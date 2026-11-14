"use strict";

const { displayText } = require("./workbuddy-display");

function macNotice(agent, kind, detail) {
  const label = agent === "codex" ? "Codex" : "Devin";
  return {
    title: label + (kind === "permission" ? " 等你审批" : " 等你选择"),
    text: displayText(detail, 46) || "请在 Mac 上处理",
  };
}

function firstQuestion(input) {
  const first = input?.questions?.[0];
  return first?.question || first?.title;
}

module.exports = { macNotice, firstQuestion };
