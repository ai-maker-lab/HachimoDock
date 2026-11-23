"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { CursorAgentAdapter, listCursorSessions } = require("../src/adapters/cursor-agent");

const FAKE = path.join(__dirname, "fixtures", "fake-cursor-agent.js");

function fakeBin(home) {
  if (process.platform !== "win32") {
    fs.chmodSync(FAKE, 0o755);
    return FAKE;
  }
  const shim = path.join(home, "fake-cursor-agent.cmd");
  const nodePath = process.execPath.replace(/"/g, '""');
  const scriptPath = FAKE.replace(/"/g, '""');
  fs.writeFileSync(shim, `@echo off\r\n"${nodePath}" "${scriptPath}" %*\r\n`, "utf8");
  return shim;
}

function adapter(home, extraEnv = {}) {
  return new CursorAgentAdapter({
    env: {
      HOME: home,
      USERPROFILE: home,
      PATH: process.env.PATH,
      CURSOR_AGENT_BIN: fakeBin(home),
      ...extraEnv,
    },
    cwd: home,
    fallbackPaths: [],
    extraPathDirs: [],
  });
}

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

test("isAvailable is false when the Cursor CLI path is missing", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-agent-missing-"));
  const probe = await new CursorAgentAdapter({
    env: { HOME: home, PATH: "", CURSOR_AGENT_BIN: path.join(home, "missing") },
    fallbackPaths: [],
    extraPathDirs: [],
  }).isAvailable();
  assert.equal(probe.ready, false);
  fs.rmSync(home, { recursive: true, force: true });
});

test("isAvailable accepts the Cursor CLI version string", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-agent-ready-"));
  const probe = await adapter(home).isAvailable();
  assert.equal(probe.ready, true);
  fs.rmSync(home, { recursive: true, force: true });
});

test("listSessions reads transcript ids and mtimes without chat text", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-agent-sessions-"));
  const root = path.join(home, ".cursor", "projects", "demo", "agent-transcripts");
  const older = path.join(root, "older-session");
  const newer = path.join(root, "newer-session");
  fs.mkdirSync(older, { recursive: true });
  fs.mkdirSync(newer, { recursive: true });
  fs.writeFileSync(path.join(older, "older-session.jsonl"), "{\"role\":\"user\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"secret older\"}]}}\n");
  fs.writeFileSync(path.join(newer, "newer-session.jsonl"), "{\"role\":\"user\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"secret newer\"}]}}\n");
  const olderTime = (Date.now() - 5000) / 1000;
  const newerTime = Date.now() / 1000;
  fs.utimesSync(path.join(older, "older-session.jsonl"), olderTime, olderTime);
  fs.utimesSync(path.join(newer, "newer-session.jsonl"), newerTime, newerTime);
  const sessions = listCursorSessions({ home, limit: 10 });
  assert.deepEqual(sessions.map((session) => session.id), ["newer-session", "older-session"]);
  assert.equal(sessions[0].summary, "Cursor");
  assert.equal(JSON.stringify(sessions).includes("secret"), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test("inject resumes the selected session and does not force every command", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-agent-inject-"));
  const argsFile = path.join(home, "args.json");
  const events = await collect(adapter(home, { FAKE_CURSOR_ARGS_FILE: argsFile, FAKE_CURSOR_REPLY: "继续" }).inject({
    sessionId: "chat-9",
    text: "下一步",
    cwd: home,
  }));
  const args = JSON.parse(fs.readFileSync(argsFile, "utf8"));
  assert.equal(args.includes("--force") || args.includes("--yolo"), false);
  assert.equal(args.includes("--resume"), true);
  assert.equal(args[args.indexOf("--resume") + 1], "chat-9");
  assert.equal(args.includes("--workspace"), true);
  assert.equal(args.at(-1), "下一步");
  assert.equal(events.some((event) => event.kind === "token" && event.text === "继续"), true);
  assert.equal(events.at(-1).kind, "done");
  assert.equal(events.at(-1).sessionId, "chat-9");
  fs.rmSync(home, { recursive: true, force: true });
});

test("inject without a session id starts a new print turn", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-agent-new-"));
  const argsFile = path.join(home, "args.json");
  const events = await collect(adapter(home, { FAKE_CURSOR_ARGS_FILE: argsFile }).inject({
    sessionId: "auto",
    text: "新建",
  }));
  const args = JSON.parse(fs.readFileSync(argsFile, "utf8"));
  assert.equal(args.includes("--resume"), false);
  assert.equal(events.at(-1).sessionId, "cursor-sid");
  fs.rmSync(home, { recursive: true, force: true });
});
