"use strict";

function preview(text, limit) {
  if (typeof text !== "string") return "";
  let result = "";
  let bytes = 0;
  for (const char of text.replace(/\s+/g, " ").trim()) {
    bytes += Buffer.byteLength(char);
    if (bytes > limit) break;
    result += char;
  }
  return result;
}

const tools = new Map([
  ["run_command", "运行命令"],
  ["view_file", "读取文件"],
  ["write_to_file", "写入文件"],
  ["replace_file_content", "编辑文件"],
  ["multi_replace_file_content", "编辑文件"],
  ["grep_search", "搜索文件"],
]);

const artifactTools = new Set([
  "write_file",
  "edit_file",
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
]);

function requestsArtifactFeedback(toolCall) {
  if (!toolCall || typeof toolCall !== "object" || !artifactTools.has(toolCall.name)) {
    return false;
  }
  let meta = toolCall.args?.ArtifactMetadata;
  if (typeof meta === "string") {
    try {
      meta = JSON.parse(meta);
    } catch {
      return false;
    }
  }
  return Boolean(meta && typeof meta === "object" && meta.RequestFeedback === true);
}

// Only the user-facing title and response leave the parser. Raw tool results,
// private reasoning, and tool argument contents are never emitted as text or
// metadata; only the boolean `ArtifactMetadata.RequestFeedback === true` gate
// is inspected internally to classify user-approval turns as `waiting_user`.
function parseAntigravityStep(line, previous = {}) {
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    return null;
  }
  if (!row || typeof row !== "object") return null;

  const title = previous.title || "Antigravity";
  const phase = (state, event, content, meta = {}) => ({
    state,
    event: `antigravity:${event}`,
    title,
    content,
    ...meta,
  });
  if (row.status === "ERROR" || row.type === "ERROR_MESSAGE") {
    return phase("error", "error", "执行失败");
  }

  switch (row.type) {
    case "USER_INPUT": {
      const text = typeof row.content === "string" ? row.content : "";
      const request = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/)?.[1];
      return {
        ...phase("working", "user_input", "正在思考"),
        title: preview(request ?? text, 84) || title,
      };
    }
    case "PLANNER_RESPONSE": {
      if (Array.isArray(row.tool_calls) && row.tool_calls.length) {
        const pendingFeedback = Boolean(previous.pendingFeedback)
          || row.tool_calls.some(requestsArtifactFeedback);
        if (row.tool_calls.some((call) => call?.name === "ask_question")) {
          return phase("waiting_user", "waiting_user", "等你选择", {
            pendingToolResults: row.tool_calls.length,
            ...(pendingFeedback ? { pendingFeedback: true } : {}),
          });
        }
        return phase(
          "working",
          "tool_call",
          tools.get(row.tool_calls[0]?.name) || "正在使用工具",
          pendingFeedback ? { pendingFeedback: true } : {},
        );
      }
      const response = preview(row.content, 383);
      const awaitingFeedback = Boolean(previous.pendingFeedback);
      if (response) {
        if (row.status === "DONE" || !row.status) {
          return awaitingFeedback
            ? phase("waiting_user", "waiting_user", response)
            : phase("done", "response", response);
        }
        return phase(
          "speaking",
          "response",
          response,
          awaitingFeedback ? { pendingFeedback: true } : {},
        );
      }
      if (row.status === "DONE" && previous.state === "speaking") {
        return awaitingFeedback
          ? phase("waiting_user", "waiting_user", previous.content || "等待确认")
          : phase("done", "completed", previous.content);
      }
      if ((typeof row.thinking === "string" && row.thinking.trim()) || (row.status && row.status !== "DONE")) {
        return phase(
          "working",
          "thinking",
          "正在思考",
          awaitingFeedback ? { pendingFeedback: true } : {},
        );
      }
      return awaitingFeedback
        ? phase("waiting_user", "waiting_user", "等待确认")
        : phase("done", "completed", "已完成");
    }
    case "GENERIC":
      if (previous.state === "waiting_user" && previous.pendingToolResults > 0) {
        if (row.status === "RUNNING") return null;
        const remaining = previous.pendingToolResults - 1;
        const carryFeedback = previous.pendingFeedback ? { pendingFeedback: true } : {};
        return remaining > 0
          ? phase("waiting_user", "waiting_user", previous.content, {
            pendingToolResults: remaining,
            ...carryFeedback,
          })
          : phase("working", "tool_result", "正在处理工具结果", carryFeedback);
      }
      const keepFeedback = previous.pendingFeedback
        && (!row.status || row.status === "DONE" || row.status === "RUNNING");
      return previous.state === "working"
        ? phase(
          "working",
          "tool_result",
          "正在处理工具结果",
          keepFeedback ? { pendingFeedback: true } : {},
        )
        : null;
    default:
      return null;
  }
}

module.exports = { parseAntigravityStep };
