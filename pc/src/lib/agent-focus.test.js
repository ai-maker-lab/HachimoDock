/**
 * [Input] Per-Agent session rows and selection helpers.
 * [Output] Regression coverage for multi-Agent identity, merge
 *          behavior, cross-Agent id collisions, and selected-item retention.
 * [Pos] test node in pc/src/lib
 * [Sync] If this file changes, update `pc/src/.folder.md`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMultiAgentDeviceQueue,
  mergeAgentRoutingSessions,
  tagSessionForAgent,
  toEnabledAgentIds,
} from "./agent-focus.js";
import { deviceSessionIdentity, reconcileDeviceSessionQueue } from "./session-display.js";

test("session identity is the (agentId, id) pair; the device id stays real", () => {
  const tagged = tagSessionForAgent("codex", { id: "019abc", title: "Task" });
  assert.equal(tagged.id, "019abc");
  assert.equal(tagged.agentId, "codex");
  assert.equal(deviceSessionIdentity(tagged), "codex\u0000019abc");
  assert.notEqual(
    deviceSessionIdentity(tagged),
    deviceSessionIdentity(tagSessionForAgent("claude-code", { id: "019abc" })),
  );
});

test("enabled ids preserve order and deduplicate", () => {
  assert.deepEqual(toEnabledAgentIds(["codex", "claude-code", "codex"]), [
    "codex",
    "claude-code",
  ]);
  assert.deepEqual(toEnabledAgentIds(new Set(["a", "b"])), ["a", "b"]);
  assert.deepEqual(toEnabledAgentIds("codex"), ["codex"]);
  assert.deepEqual(toEnabledAgentIds(null), []);
});

test("routing merge keeps per-Agent identity even with identical raw ids", () => {
  const now = 1_000_000;
  const rows = mergeAgentRoutingSessions([
    {
      agentId: "codex",
      sessions: [{
        id: "same-id",
        title: "修复登录",
        content: "运行测试",
        state: "working",
        statusUpdatedAt: now,
      }],
    },
    {
      agentId: "claude-code",
      sessions: [{
        id: "same-id",
        title: "修复登录",
        content: "运行测试",
        state: "working",
        statusUpdatedAt: now,
      }],
    },
  ]);
  assert.deepEqual(rows.map((row) => deviceSessionIdentity(row)).sort(), [
    "claude-code\u0000same-id",
    "codex\u0000same-id",
  ]);
  assert.equal(new Set(rows.map((row) => row.agentId)).size, 2);
});

test("queue reconciliation does not collapse equal ids from different Agents", () => {
  const now = 1_500_000;
  const rows = [
    { id: "same-id", agentId: "codex", title: "A", state: "working", statusUpdatedAt: now },
    { id: "same-id", agentId: "claude-code", title: "B", state: "working", statusUpdatedAt: now },
  ];
  const queue = reconcileDeviceSessionQueue([], rows, now, 8);
  assert.equal(queue.length, 2);
});

test("device queue retains the selected row when the limit is full", () => {
  const now = 2_000_000;
  const sessions = [
    { agentId: "codex", id: "a", state: "working", statusUpdatedAt: now },
    { agentId: "codex", id: "b", state: "working", statusUpdatedAt: now + 1 },
    { agentId: "codex", id: "c", state: "working", statusUpdatedAt: now + 2 },
    { agentId: "claude-code", id: "focus", state: "working", statusUpdatedAt: now - 10 },
  ].map((row) => ({ ...row, name: `Task ${row.id}`, lastModified: row.statusUpdatedAt }));

  const queue = buildMultiAgentDeviceQueue({
    routingSessions: sessions,
    previousQueue: [],
    nowMs: now + 5,
    selectedSession: { agentId: "claude-code", sessionId: "focus" },
    limit: 3,
  });
  assert.equal(queue.length, 3);
  assert.ok(queue.some((row) => (
    row.agentId === "claude-code" && row.id === "focus"
  )));
  assert.ok(queue.every((row) => row.agentId));
});

test("removed Agents are filtered out of the previous device queue", () => {
  const now = 3_000_000;
  const previousQueue = [
    { id: "gone", agentId: "removed", title: "Gone", state: "working", statusUpdatedAt: now },
    { id: "kept", agentId: "codex", title: "Kept", state: "working", statusUpdatedAt: now },
  ];
  const queue = buildMultiAgentDeviceQueue({
    routingSessions: [],
    previousQueue,
    nowMs: now,
    enabledAgentIds: ["codex"],
    limit: 8,
  });
  assert.deepEqual(queue.map((session) => session.id), ["kept"]);
});
