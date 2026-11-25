/**
 * Production appearance-sync workflow with synthetic Tauri/storage adapters.
 * Observation never replays an old mutation. Each fresh user intent performs
 * one native content/cache check and exactly one usb_sync_appearance call,
 * returning only a human-readable notice. Agent/profile binding is no longer
 * part of this path.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTIVE_APPEARANCE_KEY,
  APPEARANCE_CHANGE_USB_REQUIRED_MESSAGE,
  APPEARANCE_CONFIRMATION_REQUIRED_MESSAGE,
  APPEARANCE_NOT_SUBMITTED_MESSAGE,
  APPEARANCE_SYNC_CANCELLED_MESSAGE,
  CHANNEL_SWITCH_DEVICE_REQUIRED_MESSAGE,
  applyDesktopPetAssignment,
  reconcileDesktopPetAppearance,
} from "./desktop-pet-assignment.js";

const BOARD = "fixture-board";
const FOLLOW = "00000000-0000-4000-8000-000000000001";
const USB = { connected: true, boardDeviceId: BOARD, connectionId: "fixture-connection", bootId: "fixture-boot" };
const PROOF = {
  status: "observed_current_state_quiescent", oldResult: "unknown",
  mutationSent: false, requiresFreshUserIntent: true,
  activeSlot: 1, activePackId: "fixture-existing-pack",
};
const ASSIGNMENT_COMMANDS = new Set([
  "usb_get_status",
  "usb_reconcile_appearance_unknown",
  "usb_sync_appearance",
]);

function fixture(t, options = {}) {
  const calls = [], storage = new Map();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const memoryStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  });
  let statusIndex = 0;
  const respond = (value, args) => {
    if (value instanceof Error) throw value;
    return typeof value === "function" ? value(args) : value;
  };
  const invoke = async (command, args) => {
    calls.push({ command, args });
    switch (command) {
      case "usb_get_status":
        if (options.statusThrows) throw new Error("fixture status unavailable");
        return respond(options.statuses
          ? options.statuses[Math.min(statusIndex++, options.statuses.length - 1)] : { ...USB }, args);
      case "usb_reconcile_appearance_unknown":
        assert.equal(args.expectedBoardDeviceId, options.expectedBoardDeviceId || BOARD);
        assert.match(args.userIntentId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
        assert.notEqual(args.userIntentId, FOLLOW);
        if (!Object.hasOwn(options, "observe")) throw new Error("appearance_recovery_no_pending");
        return respond(options.observe, args);
      case "usb_sync_appearance":
        return respond(options.sync ?? { ok: true, fileCount: 4, byteCount: 4096 }, args);
      default:
        throw new Error("Unexpected mock command: " + command);
    }
  };
  return {
    calls, storage, invoke,
    count: command => calls.filter(x => x.command === command).length,
    commands: () => calls.map(x => x.command),
    run: overrides => applyDesktopPetAssignment({
      invoke, listen: null, appearance: { id: "new-avatar", name: "新形象" },
      boardDeviceId: BOARD, currentAppearanceId: "old-avatar",
      followIntentId: FOLLOW, ...overrides,
    }),
  };
}
function noLocalCommit(f) {
  for (const command of f.commands()) {
    assert.ok(ASSIGNMENT_COMMANDS.has(command), command + " must not run");
  }
  assert.equal(f.storage.size, 0, "appearance sync must not persist local state");
}
function confirmationRequired(error) {
  assert.equal(error.code, "appearance-confirmation-required");
  assert.equal(error.message, APPEARANCE_CONFIRMATION_REQUIRED_MESSAGE);
  return true;
}

test("no pending observation precedes exactly one USB appearance sync", async t => {
  const f = fixture(t);
  const result = await f.run();
  assert.deepEqual(f.commands(), [
    "usb_get_status", "usb_reconcile_appearance_unknown", "usb_get_status",
    "usb_sync_appearance",
  ]);
  const sync = f.calls.find(x => x.command === "usb_sync_appearance");
  assert.deepEqual(sync.args, { appearanceId: "new-avatar", boardDeviceId: BOARD });
  assert.deepEqual(Object.keys(sync.args).sort(), ["appearanceId", "boardDeviceId"]);
  assert.deepEqual(Object.keys(result), ["notice"]);
  assert.equal(result.notice, "已确认「新形象」素材，USB 同步 4 个素材 (4.0 KB)");
  noLocalCommit(f);
});

test("exact quiescent proof permits only this new intent's single ordinary sync", async t => {
  const f = fixture(t, { observe: { ...PROOF } });
  const result = await f.run();
  assert.equal(f.count("usb_reconcile_appearance_unknown"), 1);
  assert.equal(f.count("usb_sync_appearance"), 1);
  assert.ok(f.commands().indexOf("usb_reconcile_appearance_unknown") < f.commands().indexOf("usb_sync_appearance"));
  assert.deepEqual(Object.keys(f.calls.find(x => x.command === "usb_sync_appearance").args).sort(),
    ["appearanceId", "boardDeviceId"]);
  assert.equal(result.notice, "已确认「新形象」素材，USB 同步 4 个素材 (4.0 KB)");
  noLocalCommit(f);
});

test("read-only reconciliation distinguishes no pending from an observed old unknown", async t => {
  const f = fixture(t);
  assert.deepEqual(await reconcileDesktopPetAppearance({ invoke: f.invoke, boardDeviceId: BOARD }),
    { observed: false, noPending: true, message: "设备已就绪。" });
  assert.deepEqual(f.commands(), ["usb_get_status", "usb_reconcile_appearance_unknown"]);
  noLocalCommit(f);
});

test("same local appearance ID still asks native to confirm its content/cache once", async t => {
  const f = fixture(t, { sync: { ok: true, reusedSlot: true, fileCount: 0, byteCount: 0 } });
  const result = await f.run({
    appearance: { id: "same-avatar", name: "同一形象" },
    currentAppearanceId: "same-avatar",
  });
  assert.equal(f.count("usb_reconcile_appearance_unknown"), 1);
  assert.equal(f.count("usb_sync_appearance"), 1);
  assert.equal(result.notice, "已确认「同一形象」从设备缓存切换，无需重新传输素材。");
  assert.match(result.notice, /设备缓存切换/);
  assert.match(result.notice, /无需重新传输素材/);
  noLocalCommit(f);
});

test("a stored active appearance id is used when the caller provides no current id", async t => {
  const f = fixture(t, { statuses: [{ connected: false }] });
  f.storage.set(ACTIVE_APPEARANCE_KEY, "new-avatar");
  await assert.rejects(() => f.run({ currentAppearanceId: "" }), { message: CHANNEL_SWITCH_DEVICE_REQUIRED_MESSAGE });
  assert.deepEqual(f.commands(), ["usb_get_status"]);
});

test("a missing appearance is rejected before any device command", async t => {
  const f = fixture(t, { statuses: [{ connected: false }] });
  await assert.rejects(() => f.run({ appearance: null }), { message: "请选择形象。" });
  assert.deepEqual(f.commands(), []);
});

for (const [name, overrides, message] of [
  ["unchanged appearance follow", { currentAppearanceId: "new-avatar" }, CHANNEL_SWITCH_DEVICE_REQUIRED_MESSAGE],
  ["changed appearance", {}, APPEARANCE_CHANGE_USB_REQUIRED_MESSAGE],
]) {
  test("offline " + name + " refuses before observation or persistence", async t => {
    const f = fixture(t, { statuses: [{ connected: false }] });
    await assert.rejects(() => f.run(overrides), { message });
    assert.deepEqual(f.commands(), ["usb_get_status"]);
    noLocalCommit(f);
  });
}

test("an unavailable USB status cannot authorize an appearance change", async t => {
  const changed = fixture(t, { statusThrows: true });
  await assert.rejects(() => changed.run(), { message: APPEARANCE_CHANGE_USB_REQUIRED_MESSAGE });
  assert.deepEqual(changed.commands(), ["usb_get_status"]);

  const unchanged = fixture(t, { statusThrows: true });
  await assert.rejects(() => unchanged.run({ currentAppearanceId: "new-avatar" }),
    { message: CHANNEL_SWITCH_DEVICE_REQUIRED_MESSAGE });
  assert.deepEqual(unchanged.commands(), ["usb_get_status"]);
});

test("a board identity mismatch is not confirmed and never reaches the sync", async t => {
  const f = fixture(t);
  await assert.rejects(() => f.run({ boardDeviceId: "different-fixture-board" }), confirmationRequired);
  assert.deepEqual(f.commands(), ["usb_get_status"]);
  noLocalCommit(f);
});

test("a missing board identity cannot start a sync", async t => {
  const f = fixture(t, { statuses: [{ connected: true, boardDeviceId: "" }] });
  await assert.rejects(() => f.run({ boardDeviceId: "" }), confirmationRequired);
  assert.deepEqual(f.commands(), ["usb_get_status"]);
  noLocalCommit(f);
});

test("the USB board id is used when no explicit board id is supplied", async t => {
  const f = fixture(t);
  const result = await f.run({ boardDeviceId: "" });
  assert.deepEqual(f.calls.find(x => x.command === "usb_sync_appearance").args,
    { appearanceId: "new-avatar", boardDeviceId: BOARD });
  assert.equal(result.notice, "已确认「新形象」素材，USB 同步 4 个素材 (4.0 KB)");
  noLocalCommit(f);
});

test("numeric progress retains the read-only confirmation step and removes its listener", async t => {
  const f = fixture(t), progress = [];
  let removed = 0;
  await f.run({
    onProgress: value => progress.push(value),
    listen: async (event, callback) => {
      assert.equal(event, "usb-sync-progress");
      callback({ payload: { currentFile: 2, totalFiles: 4, bytesSent: 2048, bytesTotal: 4096 } });
      return () => { removed++; };
    },
  });
  assert.deepEqual(progress, [
    { stage: "confirming", text: "正在确认…", indeterminate: true, followOnly: false },
    { type: "info", text: "USB 传输中… 2/4 个素材 (2.0 KB/4.0 KB) 50%",
      currentFile: 2, totalFiles: 4, bytesSent: 2048, bytesTotal: 4096, percent: 50 },
  ]);
  assert.equal(removed, 1);
});

test("named storage preparation follows confirmation without inventing byte progress", async t => {
  const f = fixture(t), progress = [];
  await f.run({
    onProgress: value => progress.push(value),
    listen: async (_event, callback) => {
      callback({ payload: { stage: "preparing_storage" } });
      callback({ payload: { stage: "unknown_future_stage" } });
      callback({ payload: { currentFile: 0, totalFiles: 4, bytesSent: 0, bytesTotal: 2048 } });
      return () => {};
    },
  });
  assert.deepEqual(progress, [
    { stage: "confirming", text: "正在确认…", indeterminate: true, followOnly: false },
    { type: "info", stage: "preparing_storage",
      text: "设备正在擦除旧素材、准备存储空间…", percent: 0, indeterminate: true },
  ]);
});

test("failed sync still removes its progress listener", async t => {
  const f = fixture(t, { sync: new Error("appearance_result_unknown_read_only_no_replay") });
  let removed = 0;
  await assert.rejects(() => f.run({
    listen: async (event) => {
      assert.equal(event, "usb-sync-progress");
      return () => { removed++; };
    },
  }), confirmationRequired);
  assert.equal(removed, 1);
  assert.equal(f.count("usb_sync_appearance"), 1);
  noLocalCommit(f);
});

test("new unknown sync is not retried or followed by another observation", async t => {
  const f = fixture(t, { observe: { ...PROOF }, sync: new Error("appearance_result_unknown_read_only_no_replay") });
  await assert.rejects(() => f.run(), confirmationRequired);
  assert.equal(f.count("usb_reconcile_appearance_unknown"), 1);
  assert.equal(f.count("usb_sync_appearance"), 1);
  noLocalCommit(f);
});

test("explicit asset cancellation is preserved after one observation and one sync", async t => {
  const f = fixture(t, { sync: { ok: false, error: APPEARANCE_SYNC_CANCELLED_MESSAGE } });
  await assert.rejects(() => f.run(), { message: APPEARANCE_SYNC_CANCELLED_MESSAGE });
  assert.equal(f.count("usb_reconcile_appearance_unknown"), 1);
  assert.equal(f.count("usb_sync_appearance"), 1);
  noLocalCommit(f);
});

for (const [name, sync] of [
  ["explicit ok=false", { ok: false, error: "fixture sync failed" }],
  ["missing ok", {}],
  ["false without detail", { ok: false }],
]) {
  test("a sync result without an explicit ok=true is reported as unconfirmed (" + name + ")", async t => {
    const f = fixture(t, { sync });
    await assert.rejects(() => f.run(), confirmationRequired);
    assert.equal(f.count("usb_sync_appearance"), 1);
    assert.equal(f.count("usb_reconcile_appearance_unknown"), 1);
    noLocalCommit(f);
  });
}

for (const code of [
  "appearance_recovery_busy",
  "appearance_recovery_not_quiescent_or_unproven",
  "appearance_recovery_requires_firmware_update",
  "appearance_raw_stream_quarantined_no_probe",
  "appearance_recovery_connection_changed",
  "unclassified_observation_failure",
]) {
  test("observation failure " + code + " never attempts a mutation or profile read", async t => {
    const f = fixture(t, { observe: new Error(code) });
    await assert.rejects(() => f.run(), error => {
      assert.doesNotMatch(error.message, /appearance_/);
      return true;
    });
    const observations = f.calls.filter(x => x.command === "usb_reconcile_appearance_unknown");
    assert.ok(code === "appearance_recovery_busy" ? observations.length > 1 && observations.length <= 24 : observations.length === 1);
    assert.equal(new Set(observations.map(x => x.args.userIntentId)).size, observations.length);
    assert.equal(f.count("usb_sync_appearance"), 0);
    noLocalCommit(f);
  });
}

for (const [name, delta] of [
  ["wrong status", { status: "observed_old_ack" }],
  ["known old result", { oldResult: "success" }],
  ["mutation was sent", { mutationSent: true }],
  ["no fresh user intent required", { requiresFreshUserIntent: false }],
  ["invalid active slot", { activeSlot: 2 }],
  ["empty pack identity", { activePackId: "" }],
  ["invalid pack identity", { activePackId: "bad\nidentity" }],
]) {
  test("inexact observation proof (" + name + ") cannot authorize a new sync", async t => {
    const f = fixture(t, { observe: { ...PROOF, ...delta } });
    await assert.rejects(() => f.run(), confirmationRequired);
    assert.equal(f.count("usb_reconcile_appearance_unknown"), 1);
    assert.equal(f.count("usb_sync_appearance"), 0);
    noLocalCommit(f);
  });
}

for (const [name, delta] of [
  ["board", { boardDeviceId: "different-fixture-board" }],
  ["connection", { connectionId: "different-fixture-connection" }],
  ["boot", { bootId: "different-fixture-boot" }],
  ["disconnect", { connected: false }],
]) {
  test("changed " + name + " after observation stops before mutating", async t => {
    const f = fixture(t, { observe: { ...PROOF }, statuses: [{ ...USB }, { ...USB, ...delta }] });
    await assert.rejects(() => f.run(), confirmationRequired);
    assert.equal(f.count("usb_sync_appearance"), 0);
    noLocalCommit(f);
  });
}

test("intent invalidated by a late observation cannot start the fresh mutation", async t => {
  let current = true;
  const f = fixture(t, { observe: () => { current = false; return { ...PROOF }; } });
  await assert.rejects(() => f.run({ isCurrent: () => current }), confirmationRequired);
  assert.equal(f.count("usb_sync_appearance"), 0);
  noLocalCommit(f);
});

test("intent invalidated after asset confirmation cannot report a committed notice", async t => {
  let current = true;
  const f = fixture(t, { sync: () => { current = false; return { ok: true }; } });
  await assert.rejects(() => f.run({ isCurrent: () => current }), confirmationRequired);
  assert.equal(f.count("usb_sync_appearance"), 1);
  noLocalCommit(f);
});

for (const [prefix, outcome] of [["APPEARANCE_RESULT_UNKNOWN:", "unknown"], ["APPEARANCE_NOT_SUBMITTED:", "not_submitted"], ["untyped failure", "unknown"]]) {
  test("activation outcome " + prefix + " is accurate and never retries", async t => {
    const f = fixture(t, { sync: { ok: false, error: prefix + " private-path-fixture-not-for-display" } });
    await assert.rejects(() => f.run(), e => {
      assert.equal(e.outcome, outcome);
      assert.equal(e.message.includes("private-path-fixture"), false);
      if (outcome === "unknown") {
        assert.equal(e.message.includes("本次未切换"), false);
        assert.equal(e.message.includes("结果"), true);
        assert.equal(e.message, APPEARANCE_CONFIRMATION_REQUIRED_MESSAGE);
      } else {
        assert.equal(e.message, APPEARANCE_NOT_SUBMITTED_MESSAGE);
        assert.match(e.message, /尚未提交/);
      }
      return true;
    });
    assert.equal(f.count("usb_sync_appearance"), 1);
    assert.equal(f.count("usb_reconcile_appearance_unknown"), 1);
    noLocalCommit(f);
  });
}

test("persisted unknown cancellation remains unknown rather than asserting stopped", async t => {
  const f = fixture(t, { sync: { ok: false, error: "APPEARANCE_RESULT_UNKNOWN: " + APPEARANCE_SYNC_CANCELLED_MESSAGE } });
  await assert.rejects(() => f.run(), e => e.outcome === "unknown" && e.message !== APPEARANCE_SYNC_CANCELLED_MESSAGE);
  noLocalCommit(f);
  assert.equal(f.count("usb_sync_appearance"), 1);
});

test("video capacity refusal is explicit and cannot commit a follow switch", async t => {
  const f = fixture(t, { sync: { ok: false, error: "APPEARANCE_NOT_SUBMITTED: P4 appearance videos require 17972330 bytes but the custom slot only has 10481664 bytes" } });
  await assert.rejects(f.run(), e => e.code === "appearance-capacity-exceeded" && e.outcome === "not_submitted" && e.message.includes("可用空间"));
  assert.equal(f.count("usb_sync_appearance"), 1);
  noLocalCommit(f);
});

test("a failed slot preflight explains the wait and never commits the switch", async t => {
  const f = fixture(t, { sync: { ok: false, error: "APPEARANCE_NOT_SUBMITTED: appearance_slot_query_busy" } });
  await assert.rejects(f.run(), error => error.outcome === "not_submitted" && /存储操作/.test(error.message));
  assert.equal(f.count("usb_sync_appearance"), 1);
  noLocalCommit(f);
});

test("a timed-out slot preflight asks to retry with the USB connection kept", async t => {
  const f = fixture(t, { sync: { ok: false, error: "APPEARANCE_NOT_SUBMITTED: appearance_slot_query_timeout" } });
  await assert.rejects(f.run(), error => error.outcome === "not_submitted" && /设备未确认形象槽位/.test(error.message));
  assert.equal(f.count("usb_sync_appearance"), 1);
  noLocalCommit(f);
});
