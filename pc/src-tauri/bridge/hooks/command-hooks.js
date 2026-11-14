"use strict";
const fs = require("node:fs");
const path = require("node:path");
function quote(value, platform) {
  if (/[\r\n\0]/.test(value)) throw new Error("Invalid hook executable path");
  if (platform === "win32") {
    if (/["%!]/.test(value)) throw new Error("Unsupported Windows hook executable path");
    return `"${value}"`;
  }
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
function syncCommandHooks(settings, script, events, options, passEvent = false) {
  let original = null;
  try { original = fs.readFileSync(settings, "utf8"); } catch (e) { if (e.code !== "ENOENT") throw e; }
  const config = original === null ? {} : JSON.parse(original);
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Hook settings must be an object");
  if (config.disableAllHooks === true) return { skipped: true, reason: "已禁用 Hooks；保持用户设置不变" };
  if (config.hooks != null && (typeof config.hooks !== "object" || Array.isArray(config.hooks))) throw new Error("Invalid hooks; settings unchanged");
  config.hooks ||= {};
  const platform = options.platform || process.platform;
  const baseCommand = `${quote(options.nodeBin || process.execPath, platform)} ${quote(path.join(__dirname, script), platform)}`;
  let changed = false;
  for (const event of events) {
    const command = passEvent ? baseCommand + " " + event : baseCommand;
    if (config.hooks[event] != null && !Array.isArray(config.hooks[event])) throw new Error("Invalid hook event; settings unchanged");
    const entries = config.hooks[event] ||= [];
    const own = entries.flatMap(e => Array.isArray(e?.hooks) ? e.hooks : []).find(h => h?.type === "command" && typeof h.command === "string" && h.command.includes(script));
    if (own) {
      if (own.command !== command) { own.command = command; changed = true; }
    } else {
      entries.push({ matcher: "", hooks: [{ type: "command", command, timeout: 2 }] });
      changed = true;
    }
  }
  if (!changed) return { updated: false };
  // Keep a first-install recovery copy. Do not print config or credential values.
  if (original !== null) {
    try { fs.writeFileSync(`${settings}.pet-manager-backup`, original, { flag: "wx", mode: 0o600 }); }
    catch (e) { if (e.code !== "EEXIST") throw e; }
  }
  const temporary = `${settings}.pet-manager-${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, settings);
  } finally { try { fs.unlinkSync(temporary); } catch {} }
  return { updated: true };
}
module.exports = { syncCommandHooks };
