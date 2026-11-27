"use strict";
/**
 * [Input] Local Kiro install markers (`~/.kiro`, Kiro.app / Kiro.exe, kiro-cli).
 * [Output] A state-only `kiro` adapter: availability for the agent bus, live sessions from the hook status tracker, and an explicit "voice input unsupported" reply.
 * [Pos] Kiro channel adapter; status arrives through hooks/kiro-hook.js, not through this adapter.
 * [Sync] Keep the agent id equal to the hook `agent_id` ("kiro").
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { BaseAdapter } = require("./base");
function kiroPaths(env = process.env, home = os.homedir()) {
  const apps = [];
  if (process.platform === "darwin") {
    apps.push("/Applications/Kiro.app", path.join(home, "Applications", "Kiro.app"));
  }
  if (env.LOCALAPPDATA) apps.push(path.join(env.LOCALAPPDATA, "Programs", "Kiro", "Kiro.exe"));
  const clis = [
    path.join(home, ".local", "bin", "kiro-cli"),
    path.join(home, ".local", "bin", "kiro-cli.exe"),
  ];
  return { root: path.join(home, ".kiro"), apps, clis };
}
class KiroAdapter extends BaseAdapter {
  constructor(options = {}) {
    super({ agentId: "kiro", log: options.log });
    this.paths = kiroPaths(options.env || process.env, options.home || os.homedir());
  }
  async isAvailable() {
    const installed = fs.existsSync(this.paths.root)
      || this.paths.apps.some((candidate) => fs.existsSync(candidate))
      || this.paths.clis.some((candidate) => fs.existsSync(candidate));
    return {
      ready: installed,
      reason: installed
        ? "支持 Kiro 状态与气泡跟随；暂不支持从设备向 Kiro 发送语音"
        : "未检测到 Kiro IDE 或 Kiro CLI",
    };
  }
  // Live sessions come from the hook status tracker. Kiro's on-disk session
  // store is not a documented contract, so it is not scanned here.
  async listSessions() { return []; }
  async openNew() { throw new Error("请在 Kiro 中新建会话"); }
  async *inject() {
    yield {
      kind: "error",
      code: "AGENT_INPUT_UNSUPPORTED",
      message: "Kiro 目前只支持状态跟随，暂不支持从设备发送语音或指令；不会转发到其他 Agent。",
    };
  }
}
module.exports = { KiroAdapter, kiroPaths };
