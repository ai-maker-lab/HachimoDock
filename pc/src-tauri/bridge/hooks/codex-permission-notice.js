#!/usr/bin/env node
"use strict";

const { observeHook } = require("./observe-hook");
const { macNotice } = require("./mac-notice");
const { commandPreview } = require("./command-preview");

function permissionNotice(payload) {
  if (payload?.hook_event_name !== "PermissionRequest" || !payload.session_id) return null;
  const input = payload.tool_input;
  const detail = payload.tool_name === "Bash" && typeof input?.command === "string"
    ? commandPreview(input.command)
    : input?.description || payload.tool_name;
  return {
    agent_id: "codex", event: "PermissionRequest", session_id: "codex:" + payload.session_id,
    notice: macNotice("codex", "permission", detail),
  };
}

if (require.main === module) observeHook(permissionNotice);
module.exports = { permissionNotice };
