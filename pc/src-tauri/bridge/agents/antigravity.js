"use strict";

/*
 * [Input] Antigravity CLI/IDE session transcript logs, optionally pinned by environment.
 * [Output] Polling defaults and process constants consumed by antigravity-log-monitor.
 * [Pos] Agent-specific monitor config for Antigravity in the managed status bridge.
 */

const os = require("os");
const path = require("path");

function readPositiveNumberEnv(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function envPath(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

function resolveAntigravityHome() {
  const customHome = envPath("ANTIGRAVITY_HOME") || envPath("CLAWD_ANTIGRAVITY_HOME");
  if (customHome) return customHome;
  const userHome = process.env.USERPROFILE || process.env.HOME || os.homedir();
  return path.join(userHome, ".gemini", "antigravity");
}

function resolveBrainDir() {
  const explicitDir = envPath("ANTIGRAVITY_BRAIN_DIR") || envPath("CLAWD_ANTIGRAVITY_BRAIN_DIR");
  if (explicitDir) return explicitDir;
  return path.join(resolveAntigravityHome(), "brain");
}

module.exports = {
  BRAIN_DIR: resolveBrainDir(),
  POLL_INTERVAL_MS: readPositiveNumberEnv("CLAWD_ANTIGRAVITY_POLL_INTERVAL_MS", 1000),
  PROCESS_POLL_INTERVAL_MS: readPositiveNumberEnv("CLAWD_ANTIGRAVITY_PROCESS_POLL_INTERVAL_MS", 30000),
  HEARTBEAT_MS: 30000,
  DEFAULT_SESSION_ID: "antigravity:local",
  NEW_FILE_MAX_AGE_MS: 120000,
  INITIAL_TAIL_BYTES: 1048576,
  MAX_SCAN_FILES: 100,
  PROCESS_NAMES_WIN: ["agy.exe", "agy.cmd", "antigravity.exe", "agy"],
  PROCESS_NAMES_UNIX: ["agy", "antigravity"],
};
