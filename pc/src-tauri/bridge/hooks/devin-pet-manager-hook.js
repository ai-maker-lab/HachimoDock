#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { commandPreview } = require("./command-preview");
const { displayText } = require("./workbuddy-display");
const { observeHook } = require("./observe-hook");
const { macNotice, firstQuestion } = require("./mac-notice");
const states = {
  SessionStart: "idle", UserPromptSubmit: "working", PreToolUse: "working",
  PostToolUse: "working", PermissionRequest: "waiting_user", Stop: "done", SessionEnd: "idle",
};
function permissionDetail(tool, input) {
  const actions = { write: "写入文件", edit: "修改文件", read: "读取文件" };
  if (tool === "exec") return commandPreview(input?.command);
  if (!Object.hasOwn(actions, tool)) return tool;
  const file = typeof input?.file_path === "string" ? path.win32.basename(input.file_path) : "";
  return file ? `${actions[tool]} ${file}` : actions[tool];
}
function stateForHook(payload, event = payload?.hook_event_name) {
  if (!payload || !Object.hasOwn(states, event) || typeof payload.session_id !== "string"
      || !payload.session_id.trim() || payload.session_id.length > 256) return null;
  const tool = typeof payload.tool_name === "string" ? payload.tool_name.slice(0, 80) : "";
  const title = event === "UserPromptSubmit" && typeof payload.prompt === "string"
    ? displayText(payload.prompt, 100) : "";
  let notice;
  if (event === "PermissionRequest") notice = macNotice("devin", "permission", permissionDetail(tool, payload.tool_input));
  if (event === "PreToolUse" && tool === "ask_user_question") {
    notice = macNotice("devin", "question", firstQuestion(payload.tool_input));
  }
  return {
    ...(notice ? { notice } : {}),
    agent_id: "devin", session_id: payload.session_id, event, state: notice ? "waiting_user" : states[event],
    ...(title ? { session_title: title } : {}),
    display_content: ({
      SessionStart: "会话已打开", UserPromptSubmit: "正在思考",
      PreToolUse: tool ? `正在执行 ${tool}` : "正在处理",
      PostToolUse: "正在处理", PermissionRequest: "等待权限确认",
      Stop: "本轮结束", SessionEnd: "会话已关闭",
    })[event],
  };
}
if (require.main === module) observeHook(payload => stateForHook(payload, process.argv[2]));
module.exports = { stateForHook, states };
