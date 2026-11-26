"use strict";

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const { BaseAdapter } = require("./base");
const { findExecutable, readVersion } = require("../util/binary-resolver");
const { parseLine, frameToEvents } = require("../util/stream-json");

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Cursor Agent adapter. Status follows the existing ~/.cursor/hooks.json
 * protocol (hooks/cursor-hook.js, agent_id "cursor-agent"). Turns are sent
 * with the local CLI the same way Claude print mode is sent:
 *   agent -p --output-format stream-json --stream-partial-output --trust
 *         [--workspace cwd] [--resume chatId] <prompt>
 * --force / --yolo are never passed; a device button is not approval to run
 * every command.
 */
class CursorAgentAdapter extends BaseAdapter {
  constructor({ log, env, cwd, fallbackPaths, extraPathDirs } = {}) {
    super({ agentId: "cursor-agent", log });
    this._env = env || process.env;
    this._cwd = cwd || process.cwd();
    this._fallbackPathsOverride = Array.isArray(fallbackPaths) ? fallbackPaths : null;
    this._extraPathDirsOverride = Array.isArray(extraPathDirs) ? extraPathDirs : null;
    this._cachedBin = null;
    this._cachedAvailability = null;
    this._cachedAt = 0;
  }

  _home() {
    return this._env.HOME || this._env.USERPROFILE || "";
  }

  _defaultFallbackPaths() {
    const home = this._home();
    return [
      `${home}/.local/bin/cursor-agent`,
      `${home}/.local/bin/agent`,
      `${home}/.cursor/bin/cursor-agent`,
      ...windowsCliFiles(this._env),
    ];
  }

  _defaultExtraPathDirs() {
    const home = this._home();
    return [`${home}/.local/bin`, `${home}/.cursor/bin`, ...windowsCliDirs(this._env)];
  }

  _resolveBinary() {
    if (this._cachedBin) return this._cachedBin;
    const found = findExecutable({
      binName: "cursor-agent",
      envVar: "CURSOR_AGENT_BIN",
      env: this._env,
      fallbackPaths: this._fallbackPathsOverride !== null
        ? this._fallbackPathsOverride
        : this._defaultFallbackPaths(),
      extraPathDirs: this._extraPathDirsOverride !== null
        ? this._extraPathDirsOverride
        : this._defaultExtraPathDirs(),
    });
    this._cachedBin = found;
    return found;
  }

  async isAvailable() {
    const now = Date.now();
    if (this._cachedAvailability && now - this._cachedAt < 5000) return this._cachedAvailability;
    const bin = this._resolveBinary();
    let value;
    if (!bin) {
      value = { ready: false, reason: "未找到 Cursor Agent CLI（安装后可设置 CURSOR_AGENT_BIN）" };
    } else if (!readVersion(bin, { env: this._env })) {
      value = { ready: false, reason: `cursor-agent --version 调用失败 (${bin})` };
    } else {
      value = { ready: true, reason: null };
    }
    this._cachedAvailability = value;
    this._cachedAt = now;
    return value;
  }

  async listSessions({ limit = 20 } = {}) {
    return listCursorSessions({ home: this._home(), limit });
  }

  async openNew() {
    const probe = await this.isAvailable();
    if (!probe.ready) throw new Error(probe.reason || "cursor agent unavailable");
    const bin = this._resolveBinary();
    const result = spawnSync(bin, ["create-chat"], {
      encoding: "utf8",
      timeout: 8000,
      windowsHide: true,
      env: this._spawnEnv(),
      shell: useWindowsCmdShell(bin),
    });
    const id = String(result.stdout || "").trim().split(/\s+/)[0] || "";
    return { id, lastModified: Date.now(), cwd: "", summary: "Cursor" };
  }

  async *inject(req) {
    const text = typeof req.text === "string" ? req.text : "";
    const sessionId = req.sessionId && req.sessionId !== "auto" ? req.sessionId : "";
    const cwd = typeof req.cwd === "string" && req.cwd ? req.cwd : "";
    if (!text.trim()) {
      yield { kind: "error", code: "EMPTY_TEXT", message: "cursor agent 指令为空" };
      return;
    }
    const probe = await this.isAvailable();
    if (!probe.ready) {
      yield { kind: "error", code: "AGENT_UNAVAILABLE", message: probe.reason || "cursor agent unavailable" };
      return;
    }
    const bin = this._resolveBinary();
    const args = ["-p", "--output-format", "stream-json", "--stream-partial-output", "--trust"];
    if (cwd) args.push("--workspace", cwd);
    if (sessionId) args.push("--resume", sessionId);
    args.push(text);
    yield* this._spawnAndIterate({ bin, args, cwd, signal: req.signal, fallbackSessionId: sessionId });
  }

  async *_spawnAndIterate({ bin, args, cwd, signal, fallbackSessionId }) {
    this.log("info", "spawning cursor agent", { hasSession: Boolean(fallbackSessionId), hasWorkspace: Boolean(cwd) });
    const child = spawn(bin, args, {
      cwd: cwd || this._cwd,
      env: this._spawnEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      shell: useWindowsCmdShell(bin),
    });
    const aborter = signal && !signal.aborted
      ? () => { try { child.kill("SIGTERM"); } catch { /* ignore */ } }
      : null;
    if (aborter && signal) signal.addEventListener("abort", aborter, { once: true });
    if (signal && signal.aborted) {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
    }

    let stderrBuf = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderrBuf += chunk;
      if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-8192);
    });

    let resolvedSessionId = fallbackSessionId || "";
    let sawTerminal = false;
    const exitPromise = new Promise((resolveExit) => {
      child.once("close", (code, sig) => resolveExit({ code, sig }));
      child.once("error", (err) => resolveExit({ code: -1, sig: null, err }));
    });

    try {
      child.stdout.setEncoding("utf8");
      let buffer = "";
      for await (const chunk of child.stdout) {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          const frame = parseLine(line);
          if (!frame) continue;
          const sid = pickSessionId(frame);
          if (sid && !resolvedSessionId) resolvedSessionId = sid;
          for (const evt of frameToEvents(frame)) {
            if (evt.kind === "done" || evt.kind === "error") sawTerminal = true;
            if (evt.kind === "done") yield { ...evt, sessionId: evt.sessionId || resolvedSessionId };
            else yield evt;
          }
        }
      }
      if (buffer.trim()) {
        const frame = parseLine(buffer);
        if (frame) {
          for (const evt of frameToEvents(frame)) {
            if (evt.kind === "done" || evt.kind === "error") sawTerminal = true;
            yield evt.kind === "done" ? { ...evt, sessionId: evt.sessionId || resolvedSessionId } : evt;
          }
        }
      }
      const { code, sig, err } = await exitPromise;
      if (!sawTerminal) {
        if (err) yield { kind: "error", code: "SPAWN_FAILED", message: String(err.message || err) };
        else if (code !== 0) {
          yield {
            kind: "error",
            code: "AGENT_EXIT_NONZERO",
            message: `cursor-agent exited with code=${code} sig=${sig || ""}: ${stderrBuf.trim().slice(0, 512)}`,
          };
        } else {
          yield { kind: "done", sessionId: resolvedSessionId, stopReason: "stream_ended" };
        }
      }
    } finally {
      if (aborter && signal) signal.removeEventListener("abort", aborter);
      if (!child.killed) {
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
      }
    }
  }

  _spawnEnv() {
    const home = this._home();
    const sep = process.platform === "win32" ? ";" : ":";
    const extras = [`${home}/.local/bin`, `${home}/.cursor/bin`, ...windowsCliDirs(this._env)];
    const current = (this._env.PATH || "").split(sep).filter(Boolean);
    return { ...this._env, PATH: [...new Set([...extras, ...current])].join(sep) };
  }
}

function listCursorSessions({ home, limit = 20 } = {}) {
  const root = path.join(home || "", ".cursor", "projects");
  if (!home || !fs.existsSync(root)) return [];
  const sessions = [];
  let projects = [];
  try { projects = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const transcripts = path.join(root, project.name, "agent-transcripts");
    let entries = [];
    try { entries = fs.readdirSync(transcripts, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !SESSION_ID.test(entry.name)) continue;
      const file = path.join(transcripts, entry.name, `${entry.name}.jsonl`);
      let modified = 0;
      try {
        modified = fs.statSync(fs.existsSync(file) ? file : path.join(transcripts, entry.name)).mtimeMs;
      } catch { continue; }
      sessions.push({
        id: entry.name,
        lastModified: modified,
        cwd: "",
        summary: "Cursor",
      });
    }
  }
  sessions.sort((left, right) => right.lastModified - left.lastModified || left.id.localeCompare(right.id));
  return sessions.slice(0, Math.max(0, limit));
}

function useWindowsCmdShell(bin) {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);
}

function windowsCliDirs(env) {
  const dirs = [];
  if (env.LOCALAPPDATA) dirs.push(`${env.LOCALAPPDATA}\\cursor-agent`, `${env.LOCALAPPDATA}\\Programs\\cursor-agent`);
  if (env.USERPROFILE) dirs.push(`${env.USERPROFILE}\\.local\\bin`);
  return dirs;
}

function windowsCliFiles(env) {
  const names = ["cursor-agent.exe", "cursor-agent.cmd", "agent.exe", "agent.cmd"];
  return windowsCliDirs(env).flatMap((dir) => names.map((name) => `${dir}\\${name}`));
}

function pickSessionId(frame) {
  if (!frame || typeof frame !== "object") return "";
  if (typeof frame.session_id === "string") return frame.session_id;
  if (typeof frame.sessionId === "string") return frame.sessionId;
  return "";
}

module.exports = { CursorAgentAdapter, listCursorSessions };
