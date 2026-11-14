"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { syncDevinHooks, configRoot } = require("../hooks/devin-install");
const { stateForHook, states } = require("../hooks/devin-pet-manager-hook");
const { publishClawdState } = require("../packages/clawd-backend-service/src/headless-mqtt");
const { SessionMetricsTracker } = require("../packages/clawd-backend-service/src/status-metrics");
const { DevinAdapter, createAgentSessionBus } = require("../packages/agent-session-bus/src");

test("Devin hook sync preserves existing settings and lifecycle observers", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devin-hook-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { platform: "darwin", env: { XDG_CONFIG_HOME: dir } };
  const root = configRoot(options);
  fs.mkdirSync(root);
  const settings = path.join(root, "config.json");
  const existing = { hooks: [{ type: "command", command: "personal-observer" }] };
  fs.writeFileSync(settings, JSON.stringify({ hooks: { Stop: [existing] }, model: "example" }));
  assert.equal(syncDevinHooks(options).updated, true);
  assert.equal(syncDevinHooks(options).updated, false);
  const config = JSON.parse(fs.readFileSync(settings));
  assert.equal(config.model, "example");
  assert.deepEqual(config.hooks.Stop[0], existing);
  for (const event of Object.keys(states)) {
    assert.ok(config.hooks[event].at(-1).hooks[0].command.includes("devin-pet-manager-hook.js"));
  }
});

test("Devin lifecycle reaches the selected session with its title across permission and completion", async t => {
  const metricsTracker = new SessionMetricsTracker();
  const bus = createAgentSessionBus({
    port: 0, adapters: [new DevinAdapter()], log() {},
    sessionStatusProvider: id => metricsTracker.sessionStatuses(id),
  });
  const port = await bus.start();
  t.after(() => bus.stop());
  const session = { session_id: "devin-example", prompt_id: "turn-1", tool_input: { command: "PRIVATE_TOOL_INPUT" } };
  const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "devin-title-"));
  const previousDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = dataHome;
  t.after(() => {
    if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousDataHome;
    fs.rmSync(dataHome, { recursive: true, force: true });
  });
  const cliDir = path.join(dataHome, "devin", "cli");
  fs.mkdirSync(cliDir, { recursive: true });
  const db = new (require("node:sqlite").DatabaseSync)(path.join(cliDir, "sessions.db"));
  db.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY, title TEXT)");
  db.exec("CREATE TABLE prompt_history(id INTEGER PRIMARY KEY, session_id TEXT, is_shell INTEGER, content TEXT)");
  db.prepare("INSERT INTO prompt_history VALUES (1, ?, 0, ?)").run(session.session_id, "检查任务卡片并确认时间");
  db.prepare("INSERT INTO sessions VALUES (?, ?)").run(session.session_id, "发布排期");
  t.after(() => db.close());
  for (const [event, expected] of [
    ["SessionStart", "idle"], ["UserPromptSubmit", "working"], ["PreToolUse", "working"],
    ["PermissionRequest", "waiting_user"], ["PostToolUse", "working"], ["Stop", "done"],
  ]) {
    const payload = stateForHook({ ...session, hook_event_name: event, prompt: "检查任务卡片" });
    publishClawdState({ metricsTracker, publisher: { publishMacNotice(source, notice) {
      assert.equal(source, "devin");
      assert.equal(notice.title, "Devin 等你审批");
      assert.match(notice.text, /^发布排期 · /);
    }, publishSource(value) {
      assert.equal(value.source, "devin");
      assert.equal(value.state, expected);
      assert.doesNotMatch(JSON.stringify(value), /PRIVATE_TOOL_INPUT/);
    } } }, payload);
    const res = await fetch(`http://127.0.0.1:${port}/agent/sessions?agentId=devin`);
    const { sessions } = await res.json();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, session.session_id);
    assert.equal(sessions[0].state, expected);
    if (event !== "SessionStart") assert.equal(sessions[0].displayTitle, "检查任务卡片");
  }
  const question = stateForHook({ ...session, tool_name: "ask_user_question",
    tool_input: { questions: [{ question: "周几发布？" }] } }, "PreToolUse");
  for (const title of ["检查任务卡片…", "检查任务卡片并确认时间", null, "发布排期"]) {
    db.prepare("UPDATE sessions SET title = ? WHERE id = ?").run(title, session.session_id);
    let text;
    publishClawdState({ metricsTracker, publisher: { publishSource() {},
      publishMacNotice(_, notice) { text = notice.text; } } }, question);
    assert.equal(text, title === "发布排期" ? "发布排期 · 周几发布？" : "周几发布？");
  }
  assert.equal(stateForHook({ ...session, hook_event_name: "SessionEnd" }).state, "idle");
  assert.equal(stateForHook({ hook_event_name: "Stop" }), null);
});

test("native calls produce passive reminders, ordinary tools do not", () => {
  const { permissionNotice } = require("../hooks/codex-permission-notice");
  const base = { session_id: "s", tool_input: { questions: [{ question: "用哪个版本？" }] } };
  const question = stateForHook({ ...base, tool_name: "ask_user_question" }, "PreToolUse");
  assert.equal(question.state, "waiting_user");
  assert.deepEqual(question.notice, { title: "Devin 等你选择", text: "用哪个版本？" });
  assert.equal(stateForHook({ ...base, tool_name: "exec" }, "PreToolUse").notice, undefined);
  assert.equal(permissionNotice({ ...base, hook_event_name: "PostToolUse" }), null);
  const hook = permissionNotice({ ...base, hook_event_name: "PermissionRequest", tool_name: "Bash" });
  assert.deepEqual(hook.notice, { title: "Codex 等你审批", text: "Bash" });
  assert.equal(hook.decision, undefined);
  const approve = (tool_name, command) => permissionNotice({ ...base, hook_event_name: "PermissionRequest",
    tool_name, tool_input: { command, description: "检查连接" } }).notice.text;
  assert.equal(approve("Bash", "curl -X POST -H 'Authorization: Bearer private'"), "运行 curl -X POST -H ***");
  assert.equal(approve("apply_patch", "private patch body"), "检查连接");
});

test("Devin file approval banners show the action and filename", () => {
  for (const [tool_name, file_path, text] of [
    ["write", "/Users/test/project/weekly-report.md", "写入文件 weekly-report.md"],
    ["edit", "C:\\work\\会议记录.md", "修改文件 会议记录.md"],
    ["read", "README.md", "读取文件 README.md"],
    ["write", null, "写入文件"],
  ]) {
    const event = stateForHook({ session_id: "s", tool_name,
      tool_input: { file_path, content: "PRIVATE", command: "PRIVATE" } }, "PermissionRequest");
    assert.deepEqual(event.notice, { title: "Devin 等你审批", text });
  }
});

test("Devin exec approvals show the operation without copying credentials or shell payloads", () => {
  function preview(command) {
    return stateForHook({ session_id: "s", tool_name: "exec", tool_input: { command } }, "PermissionRequest").notice.text;
  }
  assert.equal(preview("TOKEN=secret /usr/bin/git diff --stat"), "运行 git diff --stat");
  assert.equal(preview("npm run build"), "运行 npm run build");
  assert.equal(preview("curl -X POST -H 'Authorization: Bearer private value' --token=123456"), "运行 curl -X POST -H *** --token ***");
  assert.equal(preview("echo 'positional secret'"), "运行 echo ***");
  assert.equal(preview("sh -c 'echo private'"), "运行 sh *** ...");
  assert.equal(preview("git status && echo secret"), "运行 git status ...");
  assert.equal(preview(null), "运行命令");
  const long = preview("curl --silent --show-error --fail --location --verbose --token secret");
  assert.ok([...long].length <= 46 && long.endsWith("..."));
});

test("following Codex or Devin observes the other local installation", () => {
  const { companionObservers } = require("../packages/clawd-backend-service/src/headless-mqtt");
  assert.deepEqual(companionObservers("codex", true, true), { codex: false, devin: true });
  assert.deepEqual(companionObservers("devin", true, true), { codex: true, devin: false });
  assert.deepEqual(companionObservers("devin", false, true), { codex: false, devin: false });
  assert.deepEqual(companionObservers("codex", true, false), { codex: false, devin: false });
  assert.deepEqual(companionObservers("workbuddy", true, true), { codex: false, devin: false });
});
