#!/usr/bin/env node
/**
 * [Input] The bundled hooks/kiro-hook.js path, the bridge Node binary, and the user's `~/.kiro` directory.
 * [Output] A HachimiDock-owned global hook file `~/.kiro/hooks/hachimodock-status.json` (Kiro hooks v1 format), written atomically and idempotently.
 * [Pos] Kiro hook installer used by hooks/sync-all.js when the Kiro channel is followed.
 * [Sync] If kiro-hook.js gains or drops triggers, update KIRO_HOOK_TRIGGERS here.
 *
 * Kiro IDE (1.0+) and Kiro CLI V3 both load every `*.json` file under
 * `~/.kiro/hooks/`. HachimiDock owns exactly one file there and never edits
 * other hook files, so the user's own hooks stay untouched.
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveNodeBin } = require("./server-config");
const HOOK_FILE_NAME = "hachimodock-status.json";
const MARKER = "kiro-hook.js";
// PermissionRequest is intentionally absent: its exit-code/decision contract
// is not documented for command hooks, and a status hook must never be able
// to influence tool approval.
const KIRO_HOOK_TRIGGERS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "Stop",
  "SessionEnd",
];
function quoteArg(value, platform) {
  // Windows paths cannot contain `"`; POSIX double quotes still expand $ and `.
  if (platform === "win32") return `"${String(value)}"`;
  return `"${String(value).replace(/(["\\$`])/g, "\\$1")}"`;
}
function buildHookCommand(nodeBin, hookScript, trigger, platform = process.platform) {
  const base = `${quoteArg(nodeBin, platform)} ${quoteArg(hookScript, platform)} ${trigger}`;
  // Discard output so nothing reaches the agent context, and force exit 0 so
  // a missing runtime (e.g. an unmounted DMG) can never block a tool or make
  // Kiro start another turn after Stop.
  return platform === "win32" ? base : `${base} >/dev/null 2>&1 || true`;
}
function buildHookFile({ nodeBin, hookScript, platform } = {}) {
  return {
    version: "v1",
    hooks: KIRO_HOOK_TRIGGERS.map((trigger) => ({
      name: `hachimodock-status-${trigger}`,
      description: "HachimiDock 桌宠状态跟随（由 HachimiDock 客户端自动维护）",
      trigger,
      action: { type: "command", command: buildHookCommand(nodeBin, hookScript, trigger, platform) },
      timeout: 5,
      enabled: true,
    })),
  };
}
function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}
function kiroHookFilePath(home = os.homedir()) {
  return path.join(home, ".kiro", "hooks", HOOK_FILE_NAME);
}
/**
 * @param {object} [options]
 * @param {boolean} [options.silent]
 * @param {string} [options.home]       override home directory (tests)
 * @param {string|null} [options.nodeBin]
 * @param {string} [options.hookScript]
 * @param {string} [options.platform]
 * @returns {{ written: boolean, skipped: boolean, path: string, reason?: string }}
 */
function registerKiroHooks(options = {}) {
  const home = options.home || os.homedir();
  const kiroDir = path.join(home, ".kiro");
  const hookPath = kiroHookFilePath(home);
  let kiroInstalled = false;
  try { kiroInstalled = fs.statSync(kiroDir).isDirectory(); } catch {}
  if (!kiroInstalled) {
    if (!options.silent) console.log("Kiro not installed (~/.kiro/ not found) — skipping hook registration.");
    return { written: false, skipped: true, path: hookPath, reason: "kiro_not_installed" };
  }
  let hookScript = options.hookScript || path.resolve(__dirname, MARKER);
  hookScript = hookScript.replace(/\\/g, "/").replace("app.asar/", "app.asar.unpacked/");
  const resolved = options.nodeBin !== undefined ? options.nodeBin : resolveNodeBin();
  const nodeBin = resolved || "node";
  const desired = buildHookFile({ nodeBin, hookScript, platform: options.platform });
  let current = null;
  try { current = JSON.parse(fs.readFileSync(hookPath, "utf-8")); } catch {}
  if (current && JSON.stringify(current) === JSON.stringify(desired)) {
    if (!options.silent) console.log(`HachimiDock Kiro hooks up to date → ${hookPath}`);
    return { written: false, skipped: true, path: hookPath };
  }
  writeJsonAtomic(hookPath, desired);
  if (!options.silent) console.log(`HachimiDock Kiro hooks → ${hookPath}`);
  return { written: true, skipped: false, path: hookPath };
}
/** Remove only the HachimiDock-owned hook file. */
function unregisterKiroHooks(options = {}) {
  const hookPath = kiroHookFilePath(options.home || os.homedir());
  try {
    const text = fs.readFileSync(hookPath, "utf-8");
    if (!text.includes(MARKER)) return { removed: false, path: hookPath, reason: "not_owned" };
    fs.unlinkSync(hookPath);
    return { removed: true, path: hookPath };
  } catch (error) {
    if (error && error.code === "ENOENT") return { removed: false, path: hookPath, reason: "missing" };
    throw error;
  }
}
module.exports = {
  HOOK_FILE_NAME,
  KIRO_HOOK_TRIGGERS,
  buildHookCommand,
  buildHookFile,
  kiroHookFilePath,
  registerKiroHooks,
  unregisterKiroHooks,
};
if (require.main === module) {
  try {
    if (process.argv.includes("--uninstall")) {
      const result = unregisterKiroHooks();
      console.log(result.removed ? `Removed ${result.path}` : `Nothing to remove (${result.reason})`);
    } else {
      registerKiroHooks({});
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
