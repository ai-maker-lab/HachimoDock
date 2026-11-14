"use strict";
const fs = require("node:fs");
const { BaseAdapter } = require("./base");
const { configRoot } = require("../../../../hooks/devin-install");

class DevinAdapter extends BaseAdapter {
  constructor(options = {}) {
    super({ agentId: "devin", log: options.log });
    this.root = configRoot(options);
  }
  async isAvailable() {
    return { ready: fs.existsSync(this.root), reason: "Devin CLI 状态与会话跟随" };
  }
  // Live sessions come from the sessionStatusProvider populated by hook events.
  async listSessions() { return []; }
  async openNew() { throw new Error("请在 Devin 中新建会话"); }
  async *inject() {
    yield { kind: "error", code: "AGENT_INPUT_UNSUPPORTED", message: "请在 Devin 中输入消息" };
  }
}
module.exports = { DevinAdapter };
