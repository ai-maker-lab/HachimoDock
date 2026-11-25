/**
 * [Input] Read ChannelMatrixCard.jsx source.
 * [Output] Static Node coverage: default export, visible unavailable-client/CLI Agent rows, removed redundant session controls, start/stop switch state, per-agent appearance saving, picker-open appearance refresh, USB-only followed-agent gating/sync, inline USB sync progress, AgentAppearancePickerModal subcomponent and compact picker modal CSS.
 * [Pos] test node in pc/src/dashboard
 * [Sync] If this file changes, update `pc/src/dashboard/.folder.md`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "ChannelMatrixCard.jsx"), "utf8");
const styles = readFileSync(join(here, "../styles.css"), "utf8");

function extractCssRule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`));
  return match ? match[1] : "";
}

test("ChannelMatrixCard has a default export", () => {
  assert.match(source, /export default function ChannelMatrixCard\s*\(/);
});

test("ChannelMatrixCard keeps supported agents visible and marks unavailable clients or CLIs", () => {
  assert.match(source, /visibleAgents/);
  assert.match(source, /agentOptions\.filter\(\(agent\) => agent\?\.id\)/);
  assert.match(source, /visibleAgents\.map\s*\(/);
  assert.match(source, /is-undetected/);
  assert.match(source, /未检测到客户端或 CLI/);
  assert.match(source, /安装对应客户端或 CLI 后重新扫描/);
  assert.doesNotMatch(source, /channel-row__change-inline/);
  assert.match(source, /!isDetected && !isEnabled/);
  assert.match(source, /disabled=\{\(!isDetected && !isEnabled\) \|\| syncing/);
  assert.doesNotMatch(source, /channel-row__unavailable/);
  assert.match(source, /const canSyncAppearance = Boolean\(usb\?\.connected \|\| wifi\)/);
  assert.match(source, /enableQueuedAgent\(agentId\)/);
  assert.match(source, /removeQueuedAgent\(agentId\)/);
  assert.match(source, /设备连接 USB 或 Wi-Fi 后可更换形象/);
  assert.match(source, /已配置形象 · 待设备确认/);

  const unavailableRule = extractCssRule(styles, ".channel-row.is-undetected");
  assert.match(unavailableRule, /border-style:\s*dashed/);
  assert.doesNotMatch(unavailableRule, /opacity:/);
  const disabledToggleRule = extractCssRule(styles, ".channel-row__toggle:disabled");
  assert.match(disabledToggleRule, /opacity:\s*0\.55/);
});

test("ChannelMatrixCard destructures multiple fields from useDeviceContext", () => {
  assert.match(source, /useDeviceContext\s*\(\s*\)/);
  assert.match(source, /appearances/);
  assert.match(source, /agentOptions/);
  assert.match(source, /currentDisplay/);
  assert.match(source, /enabledAgents/);
  assert.match(source, /\busb\b/);
  assert.match(source, /applyDesktopPet/);
  assert.match(source, /enableQueuedAgent/);
  assert.match(source, /removeQueuedAgent/);
  assert.match(source, /refresh/);
});

test("Devin configuration remains available in its row and requires detection", () => {
  assert.match(source, /agent\.id === "devin"[\s\S]*?<DevinConfigurationButton disabled=\{!isDetected\} \/>/);
  const config = readFileSync(join(here, "DevinConfigurationButton.jsx"), "utf8");
  assert.match(config, /disabled=\{disabled\}/);
  assert.match(config, /invoke\("devin_cloud_get_config"\)/);
  assert.match(config, /invoke\("devin_cloud_save_config"/);
  assert.match(config, /invoke\("devin_cloud_test"\)/);
});

test("ChannelMatrixCard applies is-active class to the active channel row", () => {
  assert.match(source, /is-active/);
  assert.match(source, /isFollowed/);
  // Must be conditional based on active channel
  assert.match(source, /isFollowed\s*\?\s*["'].*is-active.*["']/);
});

test("Agents start and stop from one switch independently of the selected Session", () => {
  assert.match(source, /role="switch"/);
  assert.match(source, /aria-checked=\{isEnabled\}/);
  assert.match(source, /channel-row__toggle/);
  assert.match(source, /aria-label=\{isEnabled/);
  assert.match(source, /"启动 Agent"/);
  assert.match(source, /"关闭 Agent"/);
  assert.doesNotMatch(source, /channel-row__toggle-label/);
  assert.match(source, /handleEnable\(agent\.id\)/);
  assert.doesNotMatch(source, /加入队列/);
  const toggleRule = extractCssRule(styles, ".channel-row__toggle");
  assert.match(toggleRule, /border-radius:\s*var\(--radius-pill\)/);
  assert.match(extractCssRule(styles, ".channel-row__toggle.is-on"), /background:\s*var\(--accent-soft\)/);
});

test("Switching an Agent off keeps the last one running", () => {
  assert.match(source, /removeQueuedAgent/);
  assert.match(source, /queuedAgentCount <= 1/);
  assert.match(source, /handleRemove\(agent\.id\)/);
  assert.doesNotMatch(source, /移出队列/);
  assert.doesNotMatch(source, /requestFollow|pendingFollow|FollowAgentConfirmModal/);
});

test("Removes redundant Agent guidance and device-session controls", () => {
  assert.doesNotMatch(source, /选择设备端需要展示实时状态的Agent/);
  assert.doesNotMatch(source, /活跃会话/);
  assert.doesNotMatch(source, /显示会话/);
  assert.doesNotMatch(source, /session-display-setting/);
  assert.doesNotMatch(source, /import Switch/);
  assert.doesNotMatch(styles, /\.session-display-setting/);
});

test("Appearance changes apply to the whole device rather than one Agent", () => {
  assert.match(source, /BUILTIN_TERRIER_APPEARANCE_ID/);
  assert.match(source, /applyDesktopPet\(appearance, \{/);
  assert.match(source, /handleConfirmAppearance/);
  assert.doesNotMatch(source, /saveAgentAppearance\(/);
});

test("Opening the appearance picker is immediate while disk records refresh in the background", () => {
  assert.match(source, /const\s+openPicker\s*=\s*useCallback\(\s*\(\)\s*=>/);
  assert.match(source, /setPickerOpen\(true\);[\s\S]*refreshAppearances\(\)\.catch/);
  assert.doesNotMatch(source, /await\s+refresh\(\)/);
  assert.ok(source.indexOf("setPickerOpen(true)") < source.indexOf("refreshAppearances().catch"));
  assert.match(source, /onClick=\{openPicker\}/);
});

test("USB appearance sync progress stays inline and survives dashboard tab unmounts", () => {
  assert.match(source, /appearanceSync/);
  assert.match(source, /const\s+syncing\s*=\s*appearanceSync\?\.pending\s*===\s*true/);
  assert.match(source, /appearanceSync\?\.progress/);
  assert.doesNotMatch(source, /const \[syncProgress,\s*setSyncProgress\]\s*=\s*useState\(null\)/);
  assert.doesNotMatch(source, /const \[syncing,\s*setSyncing\]\s*=\s*useState\(false\)/);
  assert.doesNotMatch(source, /setSyncProgress\(normalizeSyncProgress\(p\)\)/);
  assert.doesNotMatch(source, /onProgress:\s*\(p\)\s*=>\s*push\(\{\s*tone:\s*"info"/);
  assert.match(source, /className="channel-matrix-sync"/);
  assert.match(source, /role="progressbar"/);
  assert.match(source, /aria-valuenow=\{syncProgress\.indeterminate \? undefined : syncProgress\.percent\}/);
  assert.match(source, /cancelAppearanceSync/);
  assert.match(source, /handleCancelAppearanceSync/);
  assert.match(source, /aria-label="中断形象传输"/);
  assert.match(source, /variant="danger"/);
  assert.match(source, /中断传输/);

  const stripRule = extractCssRule(styles, ".channel-matrix-sync");
  const cancelRule = extractCssRule(styles, ".channel-matrix-sync__cancel");
  const barRule = extractCssRule(styles, ".channel-matrix-sync__bar > span");
  assert.match(stripRule, /display:\s*grid/);
  assert.match(stripRule, /grid-template-columns:[^;]*auto/);
  assert.doesNotMatch(stripRule, /position:\s*(fixed|absolute)/);
  assert.match(cancelRule, /justify-self:\s*end/);
  assert.match(barRule, /width:\s*var\(--sync-progress\)/);
});

test("AgentAppearancePickerModal subcomponent is declared in the same file", () => {
  assert.match(source, /function AgentAppearancePickerModal\s*\(/);
});

test("FormosaPickerModal CSS stays compact when only a few appearances exist", () => {
  const modalRule = extractCssRule(styles, ".modal-card--formosa-picker");
  const gridRule = extractCssRule(styles, ".formosa-picker__grid");
  const pickerStageRule = extractCssRule(styles, ".formosa-picker__stage");
  const pickerMediaRule = extractCssRule(styles, ".formosa-picker__media");
  assert.match(modalRule, /width:\s*min\(/);
  assert.doesNotMatch(modalRule, /(^|\n)\s*width:\s*100%/);
  assert.match(gridRule, /repeat\(auto-fit,\s*minmax\(140px,\s*180px\)\)/);
  assert.doesNotMatch(gridRule, /repeat\(auto-fill,/);
  assert.match(gridRule, /justify-content:\s*start/);
  assert.match(source, /className="formosa-picker__stage"/);
  assert.match(pickerStageRule, /height:\s*150px/);
  assert.match(pickerStageRule, /place-items:\s*center/);
  assert.match(pickerStageRule, /background:\s*#000/);
  assert.match(pickerMediaRule, /object-fit:\s*contain/);
  assert.match(pickerMediaRule, /object-position:\s*center\s+center/);
  assert.doesNotMatch(source, /className="channel-row__thumb-wrap"/);
  assert.match(source, /className="companion-media"/);
  assert.match(styles, /\.modal-card--formosa-picker\s+\.modal-footer\s*\{/);
});

test("The Agent list does not read, overwrite or expose the saved DeepSeek timeout", () => {
  assert.doesNotMatch(source, /(?:load|save)_dsh_approval_timeout|channel-row__approval-timeout|审批超时时间/);
});
