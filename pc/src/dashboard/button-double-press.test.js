import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { COMPONENT_CONTROL_OPTIONS, resolveGlobalExitEvents } from "../component-center/button-config.js";
import { COMPONENT_BUTTON_EVENTS } from "../lib/clawpkg-contract.js";

// Exercise the production pure configuration functions without mounting Tauri.
const source = readFileSync(new URL("../DeviceDashboard.jsx", import.meta.url), "utf8");
const constants = source.slice(source.indexOf("export const VOICE_CONFIG_STORAGE_KEY"), source.indexOf("function preferredVoiceRow"));
const helpers = source.slice(source.indexOf("function preferredVoiceRow"), source.indexOf("function createButtonConfigRequestId"));
const normalize = source.slice(source.indexOf("function normalizeVoiceConfig"), source.indexOf("export function mergeBoardButtonConfig"));
const config = new Function("DEVICE_BUTTON_CONFIG_STORAGE_KEY", "DEVICE_BUTTON_CONFIG_MODEL_VERSION",
  (constants + helpers + normalize).replaceAll("export ", "")
    + ";return {buildBoardButtonConfigBindings,buttonControlRowsForRuntime,normalizeVoiceConfig};")("test", 10);

test("unbound doubles leave the legacy 16-event payload unchanged", () => {
  const bindings = config.buildBoardButtonConfigBindings({}, {}, "esp-p4", true);
  assert.equal(bindings.length, 16);
  assert.equal(bindings.some((b) => b.event.endsWith(".double_press")), false);
  assert.equal(bindings.find((b) => b.event === "button.sw1.hold").action, "voice_ptt");
});

test("each SW double is independently configurable and never offers PTT", () => {
  const actions = Object.fromEntries([1, 2, 3].map((sw) => [`p4_sw${sw}_double`, "agent_prompt"]));
  const values = { p4_sw2_double: "记录灵感" };
  const bindings = config.buildBoardButtonConfigBindings(actions, values, "esp-p4", true);
  assert.equal(bindings.length, 19);
  for (const sw of [1, 2, 3]) {
    const event = `button.sw${sw}.double_press`;
    assert.equal(bindings.find((b) => b.event === event).action, "agent_prompt");
    assert.ok(COMPONENT_CONTROL_OPTIONS.some((o) => o.event === event));
    assert.ok(COMPONENT_BUTTON_EVENTS.includes(event));
    const row = config.buttonControlRowsForRuntime("esp-p4").find((r) => r.event === event);
    assert.equal(row.capability, "buttonDoublePress");
    assert.equal(row.actionOptions.includes("voice_ptt"), false);
  }
  assert.equal(bindings.find((b) => b.event === "button.sw2.double_press").value, "记录灵感");
  assert.equal(config.buildBoardButtonConfigBindings(actions, values, "linux", true).length, 3);
});

test("v9 client mappings survive v10 and doubles can be global exits", () => {
  const updated = config.normalizeVoiceConfig({ buttonModelVersion: 9,
    buttonActions: { p4_sw1_short: "agent_prompt", p4_sw3_short: "page_enter" },
    buttonValues: { p4_sw1_short: "custom" } });
  assert.equal(updated.buttonActions.p4_sw1_short, "agent_prompt");
  assert.equal(updated.buttonActions.p4_sw3_short, "page_enter");
  assert.equal(updated.buttonValues.p4_sw1_short, "custom");
  assert.equal(updated.buttonActions.p4_sw1_double, "disabled");
  assert.equal(updated.buttonModelVersion, 10);
  assert.deepEqual(resolveGlobalExitEvents({ bindings: [
    { event: "button.sw2.double_press", action: "page_back" },
  ] }), ["button.sw2.double_press"]);
});
