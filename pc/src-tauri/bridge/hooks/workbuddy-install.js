"use strict";
const fs = require("node:fs");
const { syncCommandHooks } = require("./command-hooks");
const { workbuddyPaths } = require("./workbuddy-paths");
const EVENTS = ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "Notification", "Stop", "StopFailure", "PreCompact"];
const MARKER = "workbuddy-pet-manager-hook.js";
function syncWorkBuddyHooks(options = {}) {
  const { settings, root } = workbuddyPaths(options);
  if (!fs.existsSync(root)) return { skipped: true, reason: "请先启动 WorkBuddy，再重新启用状态跟随" };
  return syncCommandHooks(settings, MARKER, EVENTS, options);
}
module.exports = { syncWorkBuddyHooks, EVENTS };
