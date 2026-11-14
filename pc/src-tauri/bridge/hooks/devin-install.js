"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { syncCommandHooks } = require("./command-hooks");

function configRoot(options = {}) {
  const env = options.env || process.env;
  const home = options.home || os.homedir();
  const configDir = (options.platform || process.platform) === "win32"
    ? env.APPDATA || path.join(home, "AppData", "Roaming")
    : env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(configDir, "devin");
}

function syncDevinHooks(options = {}) {
  const root = configRoot(options);
  if (!fs.existsSync(root)) return { skipped: true, reason: "请先打开 Devin CLI" };
  return syncCommandHooks(path.join(root, "config.json"), "devin-pet-manager-hook.js",
    Object.keys(require("./devin-pet-manager-hook").states), options, true);
}

module.exports = { configRoot, syncDevinHooks };
