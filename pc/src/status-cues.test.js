import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
test("status cues UI defaults off, requires capability, and provides integer volume", () => {
  const ui = read("./StatusCueSettings.jsx");
  for (const text of ['enabled: false, volume: 30', 'capabilities?.statusCueConfig === true', '状态提示音', '需要升级设备固件', 'min="0" max="100" step="1"', 'invoke("set_status_cues"']) assert.ok(ui.includes(text), text);
  assert.ok(read("./DeviceDashboard.jsx").includes('<StatusCueSettings connected={usb.connected} capabilities={usb.capabilities} />'));
});
test("shared hello dispatcher restores saved cues over USB and BLE", () => {
  const rust = read("../src-tauri/src/lib.rs");
  assert.ok(rust.includes('topic == "hello" && payload["capabilities"]["statusCueConfig"] == true'));
  assert.ok(rust.includes('.send("config/status-cues", &status_cues::payload(config))'));
  assert.ok(rust.includes('if topic == "config/status-cues" { return true; }'));
  assert.ok(rust.includes('load_status_cues,') && rust.includes('set_status_cues,'));
});
