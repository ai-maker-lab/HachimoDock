#!/usr/bin/env node
/**
 * [Input] Kiro IDE / Kiro CLI V3 command-hook stdin JSON (`hook_event_name`, `session_id`, `cwd`, `tool_name`) plus the trigger name in argv[2].
 * [Output] One best-effort POST to the local HachimiDock bridge `/state` endpoint with `agent_id: "kiro"`.
 * [Pos] Kiro status hook registered in `~/.kiro/hooks/hachimodock-status.json` by hooks/kiro-install.js.
 * [Sync] If the trigger list changes, update KIRO_HOOK_TRIGGERS in hooks/kiro-install.js.
 *
 * Kiro feeds command-hook stdout back into the agent context, and a non-zero
 * exit on `Stop` can start another agent turn. This script therefore never
 * writes to stdout and always exits 0, including when the bridge is offline.
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SESSION_FILE_MAX_BYTES = 256 * 1024;
const TRIGGER_TO_STATE = {
  SessionStart: { state: "idle", event: "SessionStart" },
  UserPromptSubmit: { state: "working", event: "UserPromptSubmit" },
  PreToolUse: { state: "working", event: "PreToolUse" },
  PostToolUse: { state: "working", event: "PostToolUse" },
  SubagentStop: { state: "working", event: "SubagentStop" },
  PreCompact: { state: "sweeping", event: "PreCompact" },
  PostCompact: { state: "working", event: "PostCompact" },
  Stop: { state: "attention", event: "Stop" },
  SessionEnd: { state: "sleeping", event: "SessionEnd" },
};
// Kiro built-in tool ids → short labels for the device bubble. MCP tools
// arrive as `mcp_<server>_<tool>` and other ids are shown as-is.
const TOOL_LABELS = {
  execute_bash: "命令",
  execute_pwsh: "命令",
  read_file: "读取文件",
  read_multiple_files: "读取文件",
  list_directory: "浏览目录",
  file_search: "搜索文件",
  grep_search: "搜索代码",
  fs_write: "写入文件",
  fs_append: "写入文件",
  str_replace: "编辑文件",
  delete_file: "删除文件",
  web_fetch: "访问网页",
  remote_web_search: "联网搜索",
  invoke_sub_agent: "子代理",
};
function normalizeTrigger(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  // Accept 0.x / CLI 2.x camelCase names as well as V3 PascalCase names.
  const legacy = {
    agentspawn: "SessionStart",
    sessionstart: "SessionStart",
    promptsubmit: "UserPromptSubmit",
    userpromptsubmit: "UserPromptSubmit",
    pretooluse: "PreToolUse",
    posttooluse: "PostToolUse",
    subagentstop: "SubagentStop",
    precompact: "PreCompact",
    postcompact: "PostCompact",
    agentstop: "Stop",
    stop: "Stop",
    sessionend: "SessionEnd",
  };
  return legacy[trimmed.toLowerCase()] || trimmed;
}
function toolLabel(name) {
  if (typeof name !== "string" || !name.trim()) return "";
  const id = name.trim();
  if (TOOL_LABELS[id]) return TOOL_LABELS[id];
  if (id.startsWith("mcp_")) return `MCP ${id.slice(4)}`.slice(0, 60);
  return id.slice(0, 60);
}
/**
 * Best-effort conversation title from Kiro's local session record
 * (`~/.kiro/sessions/<workspace-hash>/<session_id>/session.json`). This file
 * is not a documented Kiro contract, so any mismatch falls back to the folder.
 */
function readKiroSessionTitle(sessionId, options = {}) {
  if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) return "";
  const io = options.fs || fs;
  const root = options.sessionsDir || path.join(options.home || os.homedir(), ".kiro", "sessions");
  let groups = [];
  try {
    groups = io.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return "";
  }
  for (const group of groups.slice(0, 64)) {
    const file = path.join(root, group.name, sessionId, "session.json");
    try {
      const stat = io.statSync(file);
      if (!stat.isFile() || stat.size > SESSION_FILE_MAX_BYTES) continue;
      const record = JSON.parse(io.readFileSync(file, "utf8"));
      if (record && record.id === sessionId && typeof record.title === "string" && record.title.trim()) {
        return record.title.trim().slice(0, 120);
      }
    } catch {}
  }
  return "";
}
function buildStateBody(payload, triggerArg, env = process.env, options = {}) {
  const safePayload = payload && typeof payload === "object" ? payload : {};
  const trigger = normalizeTrigger(triggerArg || safePayload.hook_event_name);
  const mapped = TRIGGER_TO_STATE[trigger];
  if (!mapped) return null;
  const sessionId = [safePayload.session_id, safePayload.conversation_id, env.KIRO_SESSION_ID]
    .find((value) => typeof value === "string" && value.trim());
  const body = {
    state: mapped.state,
    event: mapped.event,
    agent_id: "kiro",
    session_id: sessionId ? sessionId.trim().slice(0, 256) : "default",
  };
  const cwd = typeof safePayload.cwd === "string" && safePayload.cwd.trim()
    ? safePayload.cwd.trim()
    : process.cwd();
  if (cwd) body.cwd = cwd;
  const recordTitle = options.readTitle === false ? "" : readKiroSessionTitle(body.session_id, options);
  const folder = cwd ? path.basename(cwd) : "";
  if (recordTitle) {
    body.session_title = recordTitle;
  } else if (folder) {
    // A folder label is only a fallback; it must not pin the session title.
    body.session_title = `Kiro · ${folder}`.slice(0, 160);
    body.session_title_explicit = false;
  }
  if (typeof safePayload.tool_name === "string" && safePayload.tool_name.trim()) {
    body.tool_name = safePayload.tool_name.trim().slice(0, 80);
    const label = toolLabel(body.tool_name);
    if (label) body.tool_label = label;
  }
  if (env.CLAWD_REMOTE) {
    try { body.host = require("./server-config").readHostPrefix(); } catch {}
  }
  return body;
}
function finish() {
  process.exit(0);
}
function runWithPayload(payload) {
  let body = null;
  try {
    body = buildStateBody(payload, process.argv[2]);
  } catch {
    body = null;
  }
  if (!body) {
    finish();
    return;
  }
  let postStateToRunningServer;
  try {
    ({ postStateToRunningServer } = require("./server-config"));
  } catch {
    finish();
    return;
  }
  // Hard ceiling so a stalled local socket never delays the Kiro agent.
  const guard = setTimeout(finish, 1500);
  guard.unref?.();
  try {
    postStateToRunningServer(JSON.stringify(body), { timeoutMs: 150 }, finish);
  } catch {
    finish();
  }
}
if (require.main === module) {
  process.on("uncaughtException", finish);
  process.on("unhandledRejection", finish);
  const chunks = [];
  let ran = false;
  const once = () => {
    if (ran) return;
    ran = true;
    let payload = {};
    try {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim()) payload = JSON.parse(raw);
    } catch {
      payload = {};
    }
    runWithPayload(payload);
  };
  process.stdin.on("data", (chunk) => {
    // Tool responses can be large; only the leading metadata is needed.
    if (chunks.reduce((sum, c) => sum + c.length, 0) < 1024 * 1024) chunks.push(chunk);
  });
  process.stdin.on("end", once);
  process.stdin.on("error", once);
  setTimeout(once, 400).unref?.();
}
module.exports = { buildStateBody, normalizeTrigger, readKiroSessionTitle, toolLabel, TRIGGER_TO_STATE };
