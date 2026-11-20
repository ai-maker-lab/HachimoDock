"use strict";

/*
 * [Input] Antigravity transcript JSONL plus process availability.
 * [Output] Per-session lifecycle cards with restart-safe token usage, daily totals, and display text.
 * [Pos] Antigravity transcript monitor worker for HachimoDock.
 */

const { execFile } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const defaults = require("./antigravity");

const MAX_MESSAGE_PREVIEW = 240;
const MAX_DISPLAY_TITLE = 22;
// transcript.jsonl 是会被裁剪、重写的"视图"文件，不能只靠字节偏移追尾。
// ANCHOR_BYTES: 用尾部若干字节做一致性锚点，判断已有偏移是否还有效。
// RESYNC_*: 重新对齐时最多回看多少字节/多少行，避免整段历史被回放。
const ANCHOR_BYTES = 64;
const RESYNC_MAX_BYTES = 4 * 1024 * 1024;
const RESYNC_MAX_LINES = 400;
const RESYNC_MIN_REPLAY_LINES = 3;
const DAILY_TOKEN_FIELDS = [
  "totalTokens",
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
];

const TEXT_THINKING = "\u6b63\u5728\u601d\u8003"; // 正在思考
const TEXT_REPLYING = "\u6b63\u5728\u56de\u590d"; // 正在回复
const TEXT_DONE = "\u5df2\u5b8c\u6210";         // 已完成
const TEXT_ERROR = "\u6267\u884c\u5931\u8d25";     // 执行失败
const TEXT_SESSION_FALLBACK = "Antigravity \u4f1a\u8bdd";

// 常见工具名称到用户友好文本的映射
const TOOL_NAME_MAP = {
  run_command: "\u8fd0\u884c\u547d\u4ee4",        // 运行命令
  read_file: "\u8bfb\u53d6\u6587\u4ef6",          // 读取文件
  edit_file: "\u7f16\u8f91\u6587\u4ef6",          // 编辑文件
  write_file: "\u521b\u5efa\u6587\u4ef6",         // 创建文件
  search_web: "\u8054\u7f51\u641c\u7d22",         // 联网搜索
  invoke_subagent: "\u8c03\u5ea6\u5b50\u4ee3\u7406", // 调度子代理
  schedule: "\u521b\u5efa\u5b9a\u65f6\u4efb\u52a1",    // 创建定时任务
};

function readNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function localDayKey(value = Date.now()) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function sumDailyTokenUsage(values) {
  const total = {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
  };
  for (const usage of values) {
    if (!usage || typeof usage !== "object") continue;
    for (const field of DAILY_TOKEN_FIELDS) {
      if (!Number.isFinite(usage[field])) continue;
      total[field] = (total[field] || 0) + usage[field];
    }
  }
  return total;
}

function compactText(value, max = MAX_MESSAGE_PREVIEW) {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > max ? `${normalized.slice(0, Math.max(0, max - 1))}...` : normalized;
}

function firstLine(value, max = MAX_DISPLAY_TITLE) {
  const text = compactText(value, max * 2);
  if (!text) return "";
  const line = text.split(/[。！？!?\n]/)[0] || text;
  return compactText(line, max);
}

function extractUserPrompt(rawText) {
  if (!rawText || typeof rawText !== "string") return "";
  // Antigravity 会话中常以 <USER_REQUEST> 包裹用户提问
  const match = rawText.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  const text = match && match[1] ? match[1].trim() : rawText.trim();
  return compactText(text);
}

function formatToolDescription(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return "";
  const first = toolCalls[0];
  const name = first?.name || "";
  const friendlyName = TOOL_NAME_MAP[name] || name || "\u5de5\u5177";
  return `\u6b63\u5728${friendlyName}...`; // 正在[运行命令]...
}

function extractTokenUsage(obj) {
  if (!obj || typeof obj !== "object") return null;
  const inputTokens = readNumber(obj.input_tokens);
  const outputTokens = readNumber(obj.output_tokens);
  const cachedInputTokens = readNumber(obj.cache_read_tokens);
  if (inputTokens === undefined && outputTokens === undefined) return null;

  const totalTokens = (inputTokens || 0) + (outputTokens || 0) + (cachedInputTokens || 0);

  return {
    inputTokens: inputTokens || 0,
    outputTokens: outputTokens || 0,
    cachedInputTokens: cachedInputTokens || 0,
    totalTokens,
  };
}

function lineKey(line) {
  return crypto.createHash("sha1").update(line).digest("hex").slice(0, 16);
}

function readRange(filePath, start, length) {
  if (!(length > 0)) return Buffer.alloc(0);
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, start);
    return read === length ? buffer : buffer.subarray(0, read);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

class AntigravityLogMonitor {
  constructor(agentConfig, onState) {
    this.config = { ...defaults, ...(agentConfig || {}) };
    this.onState = typeof onState === "function" ? onState : () => {};
    this.timer = null;
    this.lastRunning = null;
    this.lastEmitMs = 0;
    this.tracked = new Map();
    this.processProbeAt = 0;
    this.processProbeInFlight = false;
    this.dailyUsageDayKey = localDayKey();
    this.dailyUsageBySession = new Map();
  }

  start() {
    if (this.timer) return;
    this.baselineExistingSessions();
    this.pollProcessState();
    this.timer = setInterval(() => this.poll(), this.config.POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  emitProcess(state, event) {
    try {
      this.onState(this.config.DEFAULT_SESSION_ID, state, event, {});
    } catch {}
  }

  emit(entry, state, event) {
    const extra = this.buildExtra(entry, state, event);
    const fingerprint = JSON.stringify({
      state,
      event,
      display: extra.display,
      tokenUsage: extra.tokenUsage && {
        totalTokens: extra.tokenUsage.totalTokens,
        inputTokens: extra.tokenUsage.inputTokens,
        outputTokens: extra.tokenUsage.outputTokens,
        cachedInputTokens: extra.tokenUsage.cachedInputTokens,
      },
      dailyTokenUsage: extra.dailyTokenUsage,
    });
    if (entry.lastEmitFingerprint === fingerprint) return;
    entry.lastEmitFingerprint = fingerprint;

    try {
      this.onState(entry.sessionId, state, event, extra);
    } catch {}
  }

  ensureTitle(entry) {
    if (entry.sessionTitle) return entry.sessionTitle;
    const fallback = firstLine(entry.firstUserMessage || entry.lastUserMessage || TEXT_SESSION_FALLBACK, 28);
    entry.sessionTitle = fallback || TEXT_SESSION_FALLBACK;
    return entry.sessionTitle;
  }

  buildDisplay(entry, state, event) {
    const title = compactText(this.ensureTitle(entry), MAX_DISPLAY_TITLE);
    let content = "";
    if (event === "antigravity:user_input" || state === "thinking") {
      content = TEXT_THINKING;
    } else if (state === "working") {
      content = entry.lastActionDetail || "\u6b63\u5728\u6267\u884c\u4efb\u52a1...";
    } else if (state === "speaking") {
      content = entry.lastAgentMessage || TEXT_REPLYING;
    } else if (state === "done") {
      content = entry.lastAgentMessage || TEXT_DONE;
    } else if (state === "attention") {
      content = TEXT_ERROR;
    } else {
      content = entry.lastDisplayContent || TEXT_THINKING;
    }

    content = compactText(content, MAX_MESSAGE_PREVIEW);
    entry.lastDisplayContent = content;

    return {
      title,
      content,
      status: state,
      event,
      updatedAtMs: Date.now(),
    };
  }

  buildExtra(entry, state, event) {
    const display = this.buildDisplay(entry, state, event);
    const dailyTokenUsage = this.buildDailyTokenUsage();
    return {
      cwd: entry.cwd || "",
      sessionTitle: this.ensureTitle(entry),
      display,
      session: {
        id: entry.sessionId,
        title: this.ensureTitle(entry),
        cwd: entry.cwd || "",
        firstUserMessage: entry.firstUserMessage || "",
        lastUserMessage: entry.lastUserMessage || "",
        lastAgentMessage: entry.lastAgentMessage || "",
      },
      messages: {
        firstUser: entry.firstUserMessage || "",
        lastUser: entry.lastUserMessage || "",
        lastAgent: entry.lastAgentMessage || "",
        userMessageCount: entry.userMessageCount || 0,
        agentMessageCount: entry.agentMessageCount || 0,
      },
      tokenUsage: entry.tokenUsage || undefined,
      dailyTokenUsage,
    };
  }

  ensureDailyUsageDay() {
    const today = localDayKey();
    if (today === this.dailyUsageDayKey) return;
    this.dailyUsageDayKey = today;
    this.dailyUsageBySession.clear();
  }

  buildDailyTokenUsage() {
    this.ensureDailyUsageDay();
    return sumDailyTokenUsage(this.dailyUsageBySession.values());
  }

  accumulateTokenUsage(entry, usage, stepIdx) {
    if (!entry || !usage) return false;
    const stepKey = `step:${stepIdx}`;
    if (entry.tokenUsageEventIds.has(stepKey)) return false;
    entry.tokenUsageEventIds.add(stepKey);

    const prev = entry.tokenUsage || { totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
    const next = {
      totalTokens: prev.totalTokens + usage.totalTokens,
      inputTokens: prev.inputTokens + usage.inputTokens,
      outputTokens: prev.outputTokens + usage.outputTokens,
      cachedInputTokens: prev.cachedInputTokens + usage.cachedInputTokens,
    };
    entry.tokenUsage = next;

    this.ensureDailyUsageDay();
    const prevDaily = this.dailyUsageBySession.get(entry.sessionId) || { totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
    this.dailyUsageBySession.set(entry.sessionId, {
      totalTokens: prevDaily.totalTokens + usage.totalTokens,
      inputTokens: prevDaily.inputTokens + usage.inputTokens,
      outputTokens: prevDaily.outputTokens + usage.outputTokens,
      cachedInputTokens: prevDaily.cachedInputTokens + usage.cachedInputTokens,
    });

    return true;
  }

  async isRunningOnWindows() {
    const processNames = new Set(
      (Array.isArray(this.config.PROCESS_NAMES_WIN) ? this.config.PROCESS_NAMES_WIN : [])
        .map((name) => String(name).trim().toLowerCase())
        .filter(Boolean)
    );
    if (processNames.size === 0) return false;

    const output = await execFileText("tasklist", ["/FO", "CSV", "/NH"], {
      timeout: 2000,
      windowsHide: true,
    });
    if (output) {
      const lines = output.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const match = trimmed.match(/^"([^"]+)"/);
        if (!match || !match[1]) continue;
        if (processNames.has(match[1].toLowerCase())) return true;
      }
    }
    return false;
  }

  async isRunningOnUnix() {
    const processNames = new Set(
      (Array.isArray(this.config.PROCESS_NAMES_UNIX) ? this.config.PROCESS_NAMES_UNIX : [])
        .map((name) => String(name).trim().toLowerCase())
        .filter(Boolean)
    );
    if (processNames.size === 0) return false;

    const output = await execFileText("ps", ["-A", "-o", "comm="], { timeout: 2000 });
    if (output) {
      const lines = output.split(/\r?\n/);
      for (const line of lines) {
        const command = path.basename(line.trim()).toLowerCase();
        if (!command) continue;
        if (processNames.has(command)) return true;
      }
    }
    return false;
  }

  async isRunning() {
    if (process.platform === "win32") return this.isRunningOnWindows();
    return this.isRunningOnUnix();
  }

  poll() {
    this.pollSessions();
    this.pollProcessState();
  }

  pollProcessState() {
    const now = Date.now();
    const probeIntervalMs = Math.max(1000, Number(this.config.PROCESS_POLL_INTERVAL_MS) || 30000);
    if (this.processProbeInFlight || now - this.processProbeAt < probeIntervalMs) return;

    this.processProbeAt = now;
    this.processProbeInFlight = true;
    Promise.resolve(this.isRunning())
      .then((running) => this.updateRunningState(Boolean(running)))
      .catch(() => this.updateRunningState(false))
      .finally(() => {
        this.processProbeInFlight = false;
      });
  }

  updateRunningState(running) {
    const now = Date.now();
    const heartbeatMs = Math.max(1000, Number(this.config.HEARTBEAT_MS) || 30000);
    const changed = this.lastRunning === null || this.lastRunning !== running;

    this.lastRunning = running;
    if (this.tracked.size > 0) return;
    if (!changed && (now - this.lastEmitMs) < heartbeatMs) return;

    this.lastEmitMs = now;
    if (running) this.emitProcess("idle", "process.detected");
    else this.emitProcess("sleeping", "process.missing");
  }

  brainDir() {
    return this.config.BRAIN_DIR || defaults.BRAIN_DIR;
  }

  listSessionFiles() {
    const root = this.brainDir();
    let convDirs;
    try {
      convDirs = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }

    const files = [];
    for (const item of convDirs) {
      if (!item.isDirectory()) continue;
      const convId = item.name;
      // Antigravity 会话日志标准路径：<brain>/<convId>/.system_generated/logs/transcript.jsonl
      const primaryPath = path.join(root, convId, ".system_generated", "logs", "transcript.jsonl");
      const fallbackPath = path.join(root, convId, "transcript.jsonl");

      const targetPath = fs.existsSync(primaryPath) ? primaryPath : (fs.existsSync(fallbackPath) ? fallbackPath : null);
      if (!targetPath) continue;

      try {
        const stat = fs.statSync(targetPath);
        files.push({
          filePath: targetPath,
          sessionId: convId,
          mtimeMs: stat.mtimeMs,
        });
      } catch {}
    }

    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const limit = Math.max(1, Number(this.config.MAX_SCAN_FILES) || 100);
    return files.slice(0, limit);
  }

  processLine(line, entry) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    if (!obj || typeof obj !== "object") return;

    const stepIdx = obj.step_index ?? 0;
    const type = typeof obj.type === "string" ? obj.type : "";
    const status = typeof obj.status === "string" ? obj.status : "";

    // 1. 累计 Token 开销
    const usage = extractTokenUsage(obj);
    if (usage) {
      this.accumulateTokenUsage(entry, usage, stepIdx);
    }

    // 2. 处理错误状态
    if (status === "ERROR") {
      entry.lastState = "attention";
      entry.lastActionDetail = TEXT_ERROR;
      this.emit(entry, "attention", "antigravity:error");
      return;
    }

    // 3. 用户输入步 (USER_INPUT)
    if (type === "USER_INPUT") {
      const prompt = extractUserPrompt(obj.content);
      if (prompt) {
        entry.lastUserMessage = prompt;
        if (!entry.firstUserMessage) entry.firstUserMessage = prompt;
        if (!entry.sessionTitle) entry.sessionTitle = firstLine(prompt, 28);
      }
      entry.userMessageCount = (entry.userMessageCount || 0) + 1;
      entry.lastState = "working";
      entry.lastActionDetail = TEXT_THINKING;
      entry.lastEventTime = Date.now();
      this.emit(entry, "working", "antigravity:user_input");
      return;
    }

    // 4. 模型规划与执行步 (PLANNER_RESPONSE)
    if (type === "PLANNER_RESPONSE") {
      entry.agentMessageCount = (entry.agentMessageCount || 0) + 1;
      entry.lastEventTime = Date.now();

      // 如果有工具调用，维持在 "working" 状态并展示工具名
      if (Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0) {
        entry.lastState = "working";
        entry.lastActionDetail = formatToolDescription(obj.tool_calls);
        this.emit(entry, "working", "antigravity:tool_call");
        return;
      }

      // 如果没有工具调用，并且有回复内容或思维链完成
      if (typeof obj.content === "string" && obj.content.trim()) {
        entry.lastAgentMessage = compactText(obj.content);
        entry.lastState = "done";
        this.emit(entry, "done", "antigravity:response");
        return;
      }

      // 仅有 thinking 阶段
      if (typeof obj.thinking === "string" && obj.thinking.trim()) {
        entry.lastState = "working";
        entry.lastActionDetail = TEXT_THINKING;
        this.emit(entry, "working", "antigravity:thinking");
        return;
      }

      // 默认完成状态
      entry.lastState = "done";
      this.emit(entry, "done", "antigravity:completed");
      return;
    }

    // 5. 工具执行结果返回 (GENERIC) -> 维持 working
    if (type === "GENERIC" && entry.lastState === "working") {
      this.emit(entry, "working", "antigravity:tool_result");
      return;
    }
  }

  createEntry(sessionId, offset, dropFirstLine) {
    return {
      offset,
      partial: "",
      dropFirstLine,
      sessionId,
      cwd: "",
      tokenUsage: null,
      tokenUsageEventIds: new Set(),
      sessionTitle: "",
      firstUserMessage: "",
      lastUserMessage: "",
      lastAgentMessage: "",
      lastActionDetail: "",
      lastDisplayContent: "",
      userMessageCount: 0,
      agentMessageCount: 0,
      lastEmitFingerprint: "",
      lastState: null,
      lastEventTime: Date.now(),
      // 追尾一致性状态：inode + 尾部锚点 + 最后处理过的行指纹
      ino: null,
      lastSize: offset,
      anchor: Buffer.alloc(0),
      lastLineKey: "",
    };
  }

  tailLineKey(filePath, size) {
    const start = Math.max(0, size - 65536);
    const buffer = readRange(filePath, start, size - start);
    if (!buffer) return "";
    const lines = buffer.toString("utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) return "";
    // 首行可能被截断，只要还有别的行就不用它
    const last = lines[lines.length - 1];
    return lineKey(last);
  }

  anchorOffset(entry, filePath) {
    const length = Math.min(ANCHOR_BYTES, entry.offset);
    entry.anchor = length > 0 ? (readRange(filePath, entry.offset - length, length) || Buffer.alloc(0)) : Buffer.alloc(0);
  }

  // 判断已有偏移是否仍然指向同一段内容：文件变短、被替换、或前缀被裁剪都要重新对齐。
  needsResync(entry, filePath, stat) {
    if (stat.size < entry.offset) return true;
    if (entry.ino !== null && stat.ino !== entry.ino) return true;
    if (stat.size > entry.offset && entry.anchor.length > 0) {
      const current = readRange(filePath, entry.offset - entry.anchor.length, entry.anchor.length);
      if (!current || !current.equals(entry.anchor)) return true;
    }
    return false;
  }

  // 重新对齐：以"上次处理过的最后一行"为界，只补它之后的增量，绝不整段回放。
  resyncFile(filePath, entry, stat) {
    const start = Math.max(0, stat.size - RESYNC_MAX_BYTES);
    const buffer = readRange(filePath, start, stat.size - start);
    if (!buffer) return;

    const lines = buffer.toString("utf8").split(/\r?\n/).map((line) => line.trim());
    let partial = "";
    if (lines.length > 0 && lines[lines.length - 1] !== "") partial = lines.pop() || "";
    else if (lines.length > 0) lines.pop();
    if (start > 0 && lines.length > 0) lines.shift(); // 首行被截断，丢弃

    let begin = lines.length;
    if (entry.lastLineKey) {
      let found = -1;
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - RESYNC_MAX_LINES); i -= 1) {
        if (lineKey(lines[i]) === entry.lastLineKey) {
          found = i;
          break;
        }
      }
      // 找不到上次那行说明裁剪幅度很大：只补最后几行，宁可少报也不要错乱回放
      begin = found >= 0 ? found + 1 : Math.max(0, lines.length - RESYNC_MIN_REPLAY_LINES);
    }

    for (let i = begin; i < lines.length; i += 1) {
      if (!lines[i]) continue;
      this.processLine(lines[i], entry);
    }

    entry.offset = stat.size;
    entry.lastSize = stat.size;
    entry.ino = stat.ino;
    entry.partial = partial;
    entry.dropFirstLine = false;
    this.anchorOffset(entry, filePath);
    entry.lastLineKey = this.tailLineKey(filePath, stat.size) || entry.lastLineKey;
    if (begin < lines.length) entry.lastEventTime = Date.now();
  }

  trackFileBaseline(filePath, sessionId) {
    if (this.tracked.has(filePath)) return;
    try {
      const stat = fs.statSync(filePath);
      const entry = this.createEntry(sessionId, stat.size, false);
      entry.ino = stat.ino;
      entry.lastSize = stat.size;
      this.anchorOffset(entry, filePath);
      entry.lastLineKey = this.tailLineKey(filePath, stat.size);
      this.tracked.set(filePath, entry);
    } catch {}
  }

  baselineExistingSessions() {
    const files = this.listSessionFiles();
    for (const file of files) {
      this.trackFileBaseline(file.filePath, file.sessionId);
    }
  }

  pollFile(filePath, sessionId) {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return;
    }

    let entry = this.tracked.get(filePath);
    if (!entry) {
      const initialTailBytes = Math.max(0, Number(this.config.INITIAL_TAIL_BYTES) || 0);
      const initialOffset = initialTailBytes > 0 && stat.size > initialTailBytes
        ? stat.size - initialTailBytes
        : 0;
      entry = this.createEntry(sessionId, initialOffset, initialOffset > 0);
      entry.ino = stat.ino;
      entry.lastSize = stat.size;
      this.anchorOffset(entry, filePath);
      entry.lastLineKey = this.tailLineKey(filePath, initialOffset) || "";
      this.tracked.set(filePath, entry);
    }

    // Antigravity 每一步都会整体重写 transcript.jsonl（裁剪视图），
    // 可能出现"变短 / 被截断到 0 再写 / 换 inode 原子替换"。
    // 只按偏移追加会在这些情况下永久漏检，所以先校验再决定是追加还是重新对齐。
    if (this.needsResync(entry, filePath, stat)) {
      this.resyncFile(filePath, entry, stat);
      return;
    }

    if (stat.size <= entry.offset) {
      entry.lastSize = stat.size;
      return;
    }

    let buffer;
    let fd;
    try {
      const readLen = stat.size - entry.offset;
      fd = fs.openSync(filePath, "r");
      buffer = Buffer.alloc(readLen);
      // readSync may return a short read; trimming avoids NUL padding that would
      // otherwise corrupt the trailing JSON line.
      const read = fs.readSync(fd, buffer, 0, readLen, entry.offset);
      if (read < readLen) buffer = buffer.subarray(0, read);
    } catch {
      return;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {}
      }
    }
    entry.offset = stat.size;
    entry.lastSize = stat.size;
    entry.ino = stat.ino;

    const text = entry.partial + buffer.toString("utf8");
    const lines = text.split(/\r?\n/);
    entry.partial = lines.pop() || "";
    if (entry.dropFirstLine) {
      lines.shift();
      entry.dropFirstLine = false;
    }

    let lastKey = entry.lastLineKey;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      lastKey = lineKey(line);
      this.processLine(line, entry);
    }
    entry.lastLineKey = lastKey;
    this.anchorOffset(entry, filePath);
  }

  pollSessions() {
    const files = this.listSessionFiles();
    const now = Date.now();
    const maxAgeMs = Math.max(1000, Number(this.config.NEW_FILE_MAX_AGE_MS) || 120000);

    for (const file of files) {
      if (!this.tracked.has(file.filePath) && now - file.mtimeMs > maxAgeMs) {
        this.trackFileBaseline(file.filePath, file.sessionId);
        continue;
      }
      this.pollFile(file.filePath, file.sessionId);
    }

    for (const filePath of this.tracked.keys()) {
      if (!fs.existsSync(filePath)) this.tracked.delete(filePath);
    }
  }
}

function execFileText(file, args, options) {
  return new Promise((resolve) => {
    execFile(file, args, {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      ...options,
    }, (error, stdout) => {
      resolve(error ? "" : String(stdout || ""));
    });
  });
}

module.exports = AntigravityLogMonitor;
