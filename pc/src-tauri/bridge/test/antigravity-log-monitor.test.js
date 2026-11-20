"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const AntigravityLogMonitor = require("../agents/antigravity-log-monitor");

function writeJsonl(filePath, lines) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

test("AntigravityLogMonitor correctly processes USER_INPUT, tool_calls, and final responses", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-test-"));
  try {
    const brainDir = path.join(tempDir, "brain");
    const convId = "conv-123-abc";
    const transcriptPath = path.join(brainDir, convId, ".system_generated", "logs", "transcript.jsonl");

    const emitted = [];
    const monitor = new AntigravityLogMonitor(
      {
        BRAIN_DIR: brainDir,
        POLL_INTERVAL_MS: 50,
        NEW_FILE_MAX_AGE_MS: 60000,
      },
      (sessionId, state, event, extra) => {
        emitted.push({ sessionId, state, event, extra });
      }
    );

    // 1. 模拟用户输入
    writeJsonl(transcriptPath, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        created_at: "2026-11-13T01:20:24Z",
        content: "<USER_REQUEST>\n请帮我优化数据库连接池\n</USER_REQUEST>",
      },
    ]);

    monitor.poll();

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].sessionId, convId);
    assert.equal(emitted[0].state, "working");
    assert.equal(emitted[0].event, "antigravity:user_input");
    assert.equal(emitted[0].extra.session.firstUserMessage, "请帮我优化数据库连接池");

    // 2. 模拟工具调用 (run_command)
    writeJsonl(transcriptPath, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        created_at: "2026-11-13T01:20:24Z",
        content: "<USER_REQUEST>\n请帮我优化数据库连接池\n</USER_REQUEST>",
      },
      {
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-13T01:20:27Z",
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 200,
        thinking: "Let's check the database configuration.",
        tool_calls: [{ name: "run_command", args: { CommandLine: "cat db.conf" } }],
      },
    ]);

    monitor.poll();

    assert.equal(emitted.length, 2);
    assert.equal(emitted[1].state, "working");
    assert.equal(emitted[1].event, "antigravity:tool_call");
    assert.match(emitted[1].extra.display.content, /运行命令/);
    assert.equal(emitted[1].extra.tokenUsage.totalTokens, 350);

    // 3. 模拟工具返回及最终响应
    writeJsonl(transcriptPath, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        created_at: "2026-11-13T01:20:24Z",
        content: "<USER_REQUEST>\n请帮我优化数据库连接池\n</USER_REQUEST>",
      },
      {
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-13T01:20:27Z",
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 200,
        thinking: "Let's check the database configuration.",
        tool_calls: [{ name: "run_command", args: { CommandLine: "cat db.conf" } }],
      },
      {
        step_index: 2,
        source: "MODEL",
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-13T01:20:30Z",
        content: "pool_size = 5",
      },
      {
        step_index: 3,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-13T01:20:35Z",
        input_tokens: 50,
        output_tokens: 80,
        cache_read_tokens: 0,
        content: "已将连接池大小从 5 调整为 20，并配置了空闲超时。",
      },
    ]);

    monitor.poll();

    const lastEvent = emitted[emitted.length - 1];
    assert.equal(lastEvent.state, "done");
    assert.equal(lastEvent.event, "antigravity:response");
    assert.equal(lastEvent.extra.display.content, "已将连接池大小从 5 调整为 20，并配置了空闲超时。");
    assert.equal(lastEvent.extra.tokenUsage.totalTokens, 480);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("AntigravityLogMonitor keeps detecting steps after transcript.jsonl is trimmed and rewritten", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-trim-"));
  try {
    const brainDir = path.join(tempDir, "brain");
    const convId = "conv-trim-001";
    const transcriptPath = path.join(brainDir, convId, ".system_generated", "logs", "transcript.jsonl");
    const step = (index) => ({
      step_index: index,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: `2026-11-13T02:00:${String(index % 60).padStart(2, "0")}Z`,
      input_tokens: 10,
      output_tokens: 5,
      content: `第 ${index} 步`,
    });

    // Antigravity 的 transcript.jsonl 是裁剪视图：长会话里前面步骤会被丢掉，
    // 文件整体重写后长度甚至比之前更短，字节偏移随之失效。
    const history = Array.from({ length: 40 }, (_, index) => step(index));
    writeJsonl(transcriptPath, history);

    const emitted = [];
    const monitor = new AntigravityLogMonitor(
      { BRAIN_DIR: brainDir, POLL_INTERVAL_MS: 50, NEW_FILE_MAX_AGE_MS: 60000 },
      (sessionId, state, event, extra) => emitted.push({ sessionId, state, event, extra })
    );

    monitor.baselineExistingSessions();
    assert.equal(emitted.length, 0, "启动时应忽略已有历史");

    writeJsonl(transcriptPath, history.slice(30).concat(step(40)));
    monitor.poll();

    assert.equal(emitted.length, 1, "裁剪并重写后仍要捕获新步骤");
    assert.equal(emitted[0].state, "done");
    assert.equal(emitted[0].event, "antigravity:response");
    assert.equal(emitted[0].extra.display.content, "第 40 步");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a follow-up prompt leaves the terminal state behind so the device shows 正在思考", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-followup-"));
  try {
    const brainDir = path.join(tempDir, "brain");
    const convId = "conv-followup-001";
    const transcriptPath = path.join(brainDir, convId, ".system_generated", "logs", "transcript.jsonl");
    const userStep = (index, prompt) => ({
      step_index: index,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      status: "DONE",
      content: `<USER_REQUEST>\n${prompt}\n</USER_REQUEST>`,
    });
    const answerStep = (index, answer) => ({
      step_index: index,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      content: answer,
    });

    const history = [userStep(0, "第一问")];
    writeJsonl(transcriptPath, history);

    const emitted = [];
    const monitor = new AntigravityLogMonitor(
      { BRAIN_DIR: brainDir, POLL_INTERVAL_MS: 50, NEW_FILE_MAX_AGE_MS: 60000 },
      (sessionId, state, event, extra) => emitted.push({ sessionId, state, event, extra })
    );
    monitor.baselineExistingSessions();

    // 第一轮回答完成
    writeJsonl(transcriptPath, history.concat(answerStep(1, "上一次回答")));
    monitor.poll();
    assert.equal(emitted.at(-1).state, "done");
    assert.equal(emitted.at(-1).extra.display.content, "上一次回答");

    // 再次追问：转录里追加新的 USER_INPUT
    writeJsonl(transcriptPath, [
      userStep(0, "第一问"),
      answerStep(1, "上一次回答"),
      userStep(2, "第二轮追问"),
    ]);
    monitor.poll();

    const last = emitted.at(-1);
    assert.equal(last.event, "antigravity:user_input");
    assert.equal(last.state, "working");
    assert.equal(last.extra.display.content, "正在思考");

    // 设备侧看到的是状态聚合器的输出：终态不能被"保留"，否则气泡会继续显示上一次回答。
    const { SessionMetricsTracker } = require("../packages/clawd-backend-service/src/status-metrics");
    const tracker = new SessionMetricsTracker();
    let enriched;
    for (const item of emitted) {
      enriched = tracker.apply({
        source: "antigravity",
        sessionId: item.sessionId,
        state: item.state,
        event: item.event,
        display: item.extra.display,
        tsMs: Date.now(),
      });
    }
    assert.equal(enriched.state, "working");
    assert.equal(enriched.display.content, "正在思考");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
