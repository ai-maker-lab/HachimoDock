"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { buildStateBody, normalizeTrigger, readKiroSessionTitle } = require("../hooks/kiro-hook");
const {
  KIRO_HOOK_TRIGGERS,
  buildHookCommand,
  registerKiroHooks,
  unregisterKiroHooks,
} = require("../hooks/kiro-install");
const { syncAllHooks } = require("../hooks/sync-all");
const {
  LocalStatePublisher,
  publishClawdState,
  shouldPublishHookState,
} = require("../packages/clawd-backend-service/src/headless-mqtt");
const { KiroAdapter } = require("../packages/agent-session-bus/src");
function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kiro-hook-test-"));
}
test("Kiro triggers map to device states with the kiro agent id", () => {
  const payload = {
    session_id: "sess_abc",
    hook_event_name: "PreToolUse",
    cwd: "/work/demo",
    tool_name: "execute_bash",
  };
  const body = buildStateBody(payload, "", {}, { readTitle: false });
  assert.deepEqual(
    { state: body.state, event: body.event, agent: body.agent_id, session: body.session_id },
    { state: "working", event: "PreToolUse", agent: "kiro", session: "sess_abc" },
  );
  assert.equal(body.cwd, "/work/demo");
  assert.equal(body.tool_name, "execute_bash");
  assert.equal(body.tool_label, "命令");
  assert.equal(body.session_title, "Kiro · demo");
  assert.equal(body.session_title_explicit, false);
  assert.equal(buildStateBody({ ...payload, hook_event_name: "Stop" }, "", {}, { readTitle: false }).state, "attention");
  assert.equal(buildStateBody({}, "SessionEnd", {}, { readTitle: false }).state, "sleeping");
  assert.equal(buildStateBody({}, "UserPromptSubmit", { KIRO_SESSION_ID: "sess_env" }, { readTitle: false }).session_id, "sess_env");
  assert.equal(buildStateBody({}, "PermissionRequest", {}, { readTitle: false }), null);
  assert.equal(normalizeTrigger("agentStop"), "Stop");
  assert.equal(normalizeTrigger("promptSubmit"), "UserPromptSubmit");
});
test("Kiro session titles come from the local session record and reject unsafe ids", () => {
  const home = tempHome();
  const dir = path.join(home, ".kiro", "sessions", "abc123", "sess_x1");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "session.json"), JSON.stringify({ id: "sess_x1", title: "List USB Devices" }));
  assert.equal(readKiroSessionTitle("sess_x1", { home }), "List USB Devices");
  assert.equal(readKiroSessionTitle("../sess_x1", { home }), "");
  assert.equal(readKiroSessionTitle("sess_missing", { home }), "");
  const body = buildStateBody({ session_id: "sess_x1", hook_event_name: "Stop", cwd: "/w/p" }, "", {}, { home });
  assert.equal(body.session_title, "List USB Devices");
  assert.equal(body.session_title_explicit, undefined);
});
test("the hook process never prints to stdout and exits 0 when the bridge is offline", () => {
  const home = tempHome();
  const result = spawnSync(process.execPath, [path.join(__dirname, "../hooks/kiro-hook.js"), "Stop"], {
    input: JSON.stringify({ session_id: "sess_a", hook_event_name: "Stop", cwd: home }),
    env: { ...process.env, HOME: home, HACHIMODOCK_BRIDGE_CAPABILITY_DIR: path.join(home, "missing") },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  const garbage = spawnSync(process.execPath, [path.join(__dirname, "../hooks/kiro-hook.js")], {
    input: "not json",
    env: { ...process.env, HOME: home },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(garbage.status, 0);
  assert.equal(garbage.stdout, "");
});
test("the installer owns one global Kiro hook file and is idempotent", () => {
  const home = tempHome();
  assert.equal(registerKiroHooks({ home, silent: true, nodeBin: "/opt/node" }).reason, "kiro_not_installed");
  fs.mkdirSync(path.join(home, ".kiro", "hooks"), { recursive: true });
  const userHook = path.join(home, ".kiro", "hooks", "mine.json");
  fs.writeFileSync(userHook, "{\"version\":\"v1\",\"hooks\":[]}");
  const first = registerKiroHooks({ home, silent: true, nodeBin: "/opt/node", hookScript: "/app/hooks/kiro-hook.js", platform: "darwin" });
  assert.equal(first.written, true);
  const file = JSON.parse(fs.readFileSync(first.path, "utf8"));
  assert.equal(file.version, "v1");
  assert.deepEqual(file.hooks.map((hook) => hook.trigger), KIRO_HOOK_TRIGGERS);
  assert.ok(!KIRO_HOOK_TRIGGERS.includes("PermissionRequest"));
  for (const hook of file.hooks) {
    assert.equal(hook.action.type, "command");
    assert.ok(hook.action.command.endsWith(">/dev/null 2>&1 || true"));
    assert.ok(hook.action.command.includes("\"/app/hooks/kiro-hook.js\""));
    assert.equal(hook.timeout, 5);
  }
  const second = registerKiroHooks({ home, silent: true, nodeBin: "/opt/node", hookScript: "/app/hooks/kiro-hook.js", platform: "darwin" });
  assert.equal(second.written, false);
  const moved = registerKiroHooks({ home, silent: true, nodeBin: "/opt/node2", hookScript: "/app/hooks/kiro-hook.js", platform: "darwin" });
  assert.equal(moved.written, true);
  assert.equal(fs.readFileSync(userHook, "utf8"), "{\"version\":\"v1\",\"hooks\":[]}");
  assert.equal(unregisterKiroHooks({ home }).removed, true);
  assert.equal(fs.existsSync(userHook), true);
  assert.equal(buildHookCommand("C:/node.exe", "C:/h/kiro-hook.js", "Stop", "win32"), "\"C:/node.exe\" \"C:/h/kiro-hook.js\" Stop");
  assert.equal(buildHookCommand("/a $b/node", "/h.js", "Stop", "darwin"), "\"/a \\$b/node\" \"/h.js\" Stop >/dev/null 2>&1 || true");
});
test("sync-all registers Kiro hooks only when Kiro is followed", () => {
  // Keep the real ~/.kiro untouched: os.homedir() follows HOME on POSIX.
  const previousHome = process.env.HOME;
  const home = tempHome();
  process.env.HOME = home;
  try {
    fs.mkdirSync(path.join(home, ".kiro"));
    const outcomes = syncAllHooks({ syncLegacyHooks: false, syncKiro: true });
    const kiro = outcomes.find((item) => item.name === "kiro");
    assert.equal(kiro.error, undefined);
    assert.equal(kiro.result.path, path.join(home, ".kiro", "hooks", "hachimodock-status.json"));
    assert.equal(fs.existsSync(kiro.result.path), true);
    assert.ok(!syncAllHooks({ syncLegacyHooks: false }).some((item) => item.name === "kiro"));
  } finally {
    process.env.HOME = previousHome;
  }
});
test("Kiro hook state is published to the local device state with a Kiro bubble", (t) => {
  const config = { http: { syncHooks: false }, mimocode: { enabled: false }, workbuddy: { enabled: false } };
  assert.equal(shouldPublishHookState(config, "kiro"), true);
  const stateDir = tempHome();
  // The speech channel lives under os.tmpdir(); keep it away from a running client.
  const previousTmp = process.env.TMPDIR;
  process.env.TMPDIR = tempHome();
  t.after(() => { process.env.TMPDIR = previousTmp; });
  const publisher = new LocalStatePublisher({ enabledSources: ["kiro"], localStateDir: stateDir });
  publishClawdState({ publisher }, {
    state: "working",
    event: "PreToolUse",
    agent_id: "kiro",
    session_id: "sess_abc",
    session_title: "Kiro · demo",
    session_title_explicit: false,
    tool_name: "execute_bash",
    tool_label: "命令",
    cwd: "/work/demo",
  });
  const written = JSON.parse(fs.readFileSync(path.join(stateDir, "kiro.json"), "utf8"));
  assert.equal(written.source, "kiro");
  assert.equal(written.state, "working");
  assert.equal(written.sessionId, "sess_abc");
  assert.equal(written.display.title, "Kiro · demo");
  assert.equal(written.display.content, "正在执行 命令");
  assert.equal(written.sessionTitleExplicit, false);
  publishClawdState({ publisher }, { state: "attention", event: "Stop", agent_id: "kiro", session_id: "sess_abc" });
  const done = JSON.parse(fs.readFileSync(path.join(stateDir, "kiro.json"), "utf8"));
  assert.equal(done.state, "done");
  assert.equal(done.display.content, "已完成");
  // Compact mode: every Kiro update also clears the device caption, so the
  // firmware shows its small status badge instead of the full session card.
  const caption = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), "pet-manager-bridge-speech", "kiro.json"), "utf8"));
  assert.equal(caption.source, "kiro");
  assert.equal(caption.displayContent, "");
  assert.equal(caption.sessionId, undefined);
  assert.ok(Number.isFinite(caption.tsMs));
});
test("Kiro sessions are not offered as device session cards", async () => {
  const { AgentSessionBus } = require("../packages/agent-session-bus/src/server");
  const { AdapterRegistry } = require("../packages/agent-session-bus/src/registry");
  const adapter = new KiroAdapter({ home: tempHome(), env: {} });
  const bus = new AgentSessionBus({
    port: 0,
    registry: new AdapterRegistry({ adapters: [adapter], log: () => {} }),
    capability: { authorize: () => true, headers: () => ({}), publish() {}, clear() {} },
    sessionStatusProvider: () => [{ id: "kiro:sess_a", state: "working", title: "Busy chat", displayContent: "正在思考" }],
    log: () => {},
  });
  const captured = {};
  const res = {
    writeHead(status) { captured.status = status; },
    setHeader() {},
    end(body) { captured.body = body; },
  };
  await bus._handleSessions({ headers: {} }, res, new URL("http://127.0.0.1/agent/sessions?agentId=kiro"));
  const body = JSON.parse(captured.body);
  assert.equal(body.ok, true);
  assert.deepEqual(body.sessions, []);
});
test("the Kiro bus adapter is state-only and refuses voice injection", async () => {
  const adapter = new KiroAdapter({ home: tempHome(), env: {} });
  assert.equal(adapter.agentId, "kiro");
  assert.deepEqual(await adapter.listSessions(), []);
  const events = [];
  for await (const event of adapter.inject({ sessionId: "auto", text: "hi" })) events.push(event);
  assert.equal(events[0].code, "AGENT_INPUT_UNSUPPORTED");
});
