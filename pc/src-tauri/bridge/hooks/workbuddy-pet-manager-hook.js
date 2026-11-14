#!/usr/bin/env node
"use strict";
const { observeHook } = require("./observe-hook");
const { hookDisplay, readCompletionReceipt } = require("./workbuddy-display");
const { createHash } = require("node:crypto");
const STATES = {
  SessionStart: "idle", SessionEnd: "sleeping", UserPromptSubmit: "working",
  PreToolUse: "working", PostToolUse: "working", PostToolUseFailure: "error",
  PermissionRequest: "waiting_user", Notification: "waiting_user",
  Stop: "done", StopFailure: "error", PreCompact: "working",
};
function stateForHook(payload, options) {
  if (!payload || typeof payload !== "object") return null;
  const event = payload.hook_event_name;
  const id = payload.session_id;
  if (typeof event !== "string" || !Object.hasOwn(STATES, event) || typeof id !== "string" || !id.trim() || id.length > 256) return null;
  // Explicitly allow bounded display text only; never forward the raw hook,
  // reasoning, tool arguments, auth, or transcript filesystem paths.
  const content = hookDisplay(payload, options);
  const generation = typeof payload.generation_id === "string" && payload.generation_id.length <= 512 ? payload.generation_id : "";
  const taskCorrelation = {
    userHash: event === "UserPromptSubmit" && typeof payload.prompt === "string" && payload.prompt.trim()
      ? createHash("sha256").update(payload.prompt.trim()).digest("hex") : "",
    turnId: generation ? createHash("sha256").update(generation).digest("hex") : "",
    turnActive: !["Stop", "StopFailure", "SessionStart", "SessionEnd"].includes(event),
  };
  const receipt = readCompletionReceipt(payload, options);
  if (receipt) {
    taskCorrelation.userHash = receipt.userHash;
    taskCorrelation.turnId = taskCorrelation.turnId || receipt.turnId;
    taskCorrelation.receiptSource = receipt.receiptSource;
    taskCorrelation.userTimestamp = receipt.userTimestamp;
  }
  return { agent_id: "workbuddy", session_id: id, event, state: STATES[event], session_title: "WorkBuddy 会话", session_title_explicit: false,
    task_correlation: taskCorrelation,
    ...((receipt?.reply || content) ? { display_content: receipt?.reply || content } : {}) };
}
if (require.main === module) observeHook(stateForHook);
module.exports = { stateForHook };
