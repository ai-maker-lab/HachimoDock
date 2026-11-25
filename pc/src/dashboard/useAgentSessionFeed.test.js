/**
 * [Input] Pure Agent Session feed reducer actions plus the multi-Agent device queue.
 * [Output] Behavioral coverage for Agent isolation, ordered terminal transitions,
 *          60-second card retention/expiry, and deduplication.
 * [Pos] Test node for dashboard Session orchestration.
 * [Sync] If this file changes, update `pc/src/dashboard/.folder.md`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_SESSION_FEED_INITIAL_STATE,
  agentSessionFeedReducer,
  P4_PENDING_EVENT_LIMIT,
  dispatchSessionTurn,
  queueSessionEvents,
} from "./useAgentSessionFeed.js";
import { buildMultiAgentDeviceQueue } from "../lib/agent-focus.js";
import { deviceSessionTerminalUntilMs } from "../lib/session-display.js";

function reduce(state, action) {
  return agentSessionFeedReducer(state, {
    agentId: "codex",
    displayEnabled: true,
    dismissedSessions: {},
    ...action,
  });
}

test("a tail completion and user attention bypass unrelated events, preserving their prerequisites", () => {
  const pending = [], applied = [];
  const event = (id, state, statusUpdatedAt) => ({ session: { id, state, name: id, statusUpdatedAt } });
  const events = Array.from({length: 96}, (_, i) => event(String(i), "thinking", 1));
  let state = AGENT_SESSION_FEED_INITIAL_STATE;
  const apply = item => {
    applied.push([item.session.id, item.session.state, item.session.statusUpdatedAt]);
    state = reduce(state, {type: "apply_event", value: item.session, nowMs: item.session.statusUpdatedAt});
  };
  queueSessionEvents(pending, [...events.slice(1), event("a","working",1), event("a","working",2),
    event("b","working",1), event("b","waiting_user",2), event("a","done",3), event("a","working",4)], apply);
  dispatchSessionTurn(pending, apply);
  assert.deepEqual(applied, [["a","working",2],["b","working",1],["b","waiting_user",2],["a","done",3]]);
  assert.equal(pending.length, 96);
  // The routing reducer no longer materializes a device queue; it stores the
  // merged routing rows only. Terminal-card TTL belongs to the multi-Agent
  // queue built below.
  assert.equal(state.routingSessions.find(s => s.id === "a").state, "done");
  assert.equal(state.sessions, undefined);
  while (pending.length) dispatchSessionTurn(pending, apply);
  assert.equal(applied.findLast(([id]) => id === "a")[1], "working");
  assert.equal(state.routingSessions.find(s => s.id === "a").state, "working");
});

test("sustained saturation bounds retained events and preserves distinct and implicit transitions", () => {
  const pending = [], applied = [];
  const apply = item => applied.push(item.session.id);
  for (let i = 0; i < 800; i++) {
    queueSessionEvents(pending, [{session:{id:String(i),state:"working"}}], apply);
    assert.ok(pending.length <= P4_PENDING_EVENT_LIMIT);
  }
  queueSessionEvents(pending, [{session:{id:"799",state:"idle"}}], apply);
  dispatchSessionTurn(pending, apply);
  assert.deepEqual(applied.slice(-2), ["799","799"]);
  pending.forEach(apply);
  assert.equal(new Set(applied).size,800);
  assert.equal(applied.length,801);
});

test("a racing snapshot retains concurrent events and accepts a strictly newer lifecycle", () => {
  let state = AGENT_SESSION_FEED_INITIAL_STATE;
  for (const id of ["omitted", "newer", "older", "previous"]) {
    state = reduce(state,{type:"apply_event",value:{id,name:id,state:"working",statusUpdatedAt:20},nowMs:20});
  }
  const result = reduce(state,{type:"replace_snapshot",concurrentIds:new Set(["omitted","newer","older"]),
    value:[{id:"newer",state:"done",statusUpdatedAt:25},{id:"older",name:"snapshot title",state:"idle",statusUpdatedAt:10,cwd:"/fixture"}],nowMs:30});
  assert.deepEqual(Object.fromEntries(result.routingSessions.map(s=>[s.id,s.state])),
    {omitted:"working",newer:"done",older:"working"});
  assert.equal(result.routingSessions.find(s=>s.id==="older").cwd,"/fixture");
  assert.equal(result.routingSessions.find(s=>s.id==="older").name,"snapshot title");
});

test("equal clock times use the sequence from the same lifecycle epoch", () => {
  const session = { id: "dsh-task", name: "task", epoch: "run", statusUpdatedAt: 15, state: "working", sourceSeq: 2 };
  const initial = reduce(AGENT_SESSION_FEED_INITIAL_STATE, { type: "apply_event", value: session, nowMs: 15 });
  const snapshot = sourceSeq => reduce(initial, { type: "replace_snapshot",
    value: [{ ...session, state: "done", sourceSeq }], concurrentIds: new Set([session.id]), nowMs: 16 });
  assert.equal(snapshot(1).routingSessions[0].state, "working");
  assert.equal(snapshot(3).routingSessions[0].state, "done");
});

test("Session feed admits active work, reapplies authoritative snapshots, and deduplicates repeated events", () => {
  const working = {
    id: "session-a",
    name: "Active task",
    state: "working",
    lastModified: 1000,
    statusUpdatedAt: 1000,
  };
  const loaded = reduce(AGENT_SESSION_FEED_INITIAL_STATE, {
    type: "replace_snapshot",
    value: [working],
    nowMs: 1000,
  });

  assert.equal(loaded.agentId, "codex");
  assert.equal(loaded.loaded, true);
  assert.deepEqual(loaded.routingSessions.map((session) => session.id), ["session-a"]);
  assert.equal(loaded.sessions, undefined);

  // Full snapshots are authoritative and must run even when the fingerprint is
  // unchanged so concurrent event reconciliation can stay correct.
  const repeatedSnapshot = reduce(loaded, {
    type: "replace_snapshot",
    value: [working],
    nowMs: 1000,
  });
  assert.notStrictEqual(repeatedSnapshot, loaded);
  assert.equal(repeatedSnapshot.fingerprint, loaded.fingerprint);
  assert.deepEqual(repeatedSnapshot.routingSessions, loaded.routingSessions);

  // Identical non-authoritative events do not cause Context churn.
  const eventState = reduce(loaded, {
    type: "apply_event",
    value: working,
    nowMs: 1000,
  });
  assert.equal(eventState.authoritativeSnapshot, false);
  assert.strictEqual(reduce(eventState, {
    type: "apply_event",
    value: working,
    nowMs: 1000,
  }), eventState);
});

test("Session feed preserves an explicit done transition while the device queue expires it after 60 seconds", () => {
  const working = reduce(AGENT_SESSION_FEED_INITIAL_STATE, {
    type: "apply_event",
    value: {
      id: "session-a",
      name: "Active task",
      state: "working",
      lastModified: 1000,
      statusUpdatedAt: 1000,
    },
    nowMs: 1000,
  });
  const done = reduce(working, {
    type: "apply_event",
    value: {
      id: "session-a",
      state: "done",
      lastModified: 2000,
      statusUpdatedAt: 2000,
    },
    nowMs: 2000,
  });

  // The reducer keeps the routing row; only the multi-Agent queue assigns the
  // terminal deadline and drops the card later.
  assert.equal(done.routingSessions.length, 1);
  assert.equal(done.routingSessions[0].state, "done");
  assert.equal(done.sessions, undefined);

  const activeQueue = buildMultiAgentDeviceQueue({
    routingSessions: working.routingSessions,
    previousQueue: [],
    nowMs: 1000,
    limit: 8,
  });
  const terminalQueue = buildMultiAgentDeviceQueue({
    routingSessions: done.routingSessions,
    previousQueue: activeQueue,
    nowMs: 2000,
    limit: 8,
  });
  assert.equal(terminalQueue.length, 1);
  assert.equal(terminalQueue[0].state, "done");
  assert.equal(deviceSessionTerminalUntilMs(terminalQueue[0]), 62_000);

  const expired = buildMultiAgentDeviceQueue({
    routingSessions: [],
    previousQueue: terminalQueue,
    nowMs: 62_001,
    limit: 8,
  });
  assert.deepEqual(expired, []);
});

test("Session feed treats Claude idle after visible work as a 60-second completion", () => {
  const working = reduce(AGENT_SESSION_FEED_INITIAL_STATE, {
    type: "replace_snapshot",
    agentId: "claude-code",
    value: [{
      id: "claude-task",
      name: "Claude task",
      state: "working",
      statusUpdatedAt: 10_000,
    }],
    nowMs: 10_000,
  });
  const idle = reduce(working, {
    type: "replace_snapshot",
    agentId: "claude-code",
    value: [{
      id: "claude-task",
      name: "Claude task",
      state: "idle",
      statusUpdatedAt: 11_000,
    }],
    nowMs: 11_000,
  });

  // The routing store carries the raw idle snapshot...
  assert.equal(idle.routingSessions.length, 1);
  assert.equal(idle.routingSessions[0].state, "idle");
  // ...while the device queue converts visible work -> idle into a done card
  // that is retained for the normal 60-second hold.
  const activeQueue = buildMultiAgentDeviceQueue({
    routingSessions: working.routingSessions,
    previousQueue: [],
    nowMs: 10_000,
    limit: 8,
  });
  const terminalQueue = buildMultiAgentDeviceQueue({
    routingSessions: idle.routingSessions,
    previousQueue: activeQueue,
    nowMs: 11_000,
    limit: 8,
  });
  assert.equal(terminalQueue.length, 1);
  assert.equal(terminalQueue[0].state, "done");
  assert.equal(deviceSessionTerminalUntilMs(terminalQueue[0]), 71_000);
});

test("Session feed replaces ownership on the next Agent snapshot and resets cleanly", () => {
  const codex = reduce(AGENT_SESSION_FEED_INITIAL_STATE, {
    type: "replace_snapshot",
    value: [{ id: "codex-a", name: "Codex task", state: "working", statusUpdatedAt: 1000 }],
    nowMs: 1000,
  });
  // Terminal ticking moved to the multi-Agent queue; an obsolete action must
  // not mutate the routing store or leak another Agent's rows into it.
  assert.strictEqual(
    agentSessionFeedReducer(codex, {
      type: "tick_terminal",
      agentId: "claude-code",
      nowMs: 2000,
      displayEnabled: true,
      dismissedSessions: {},
    }),
    codex,
  );

  const claude = agentSessionFeedReducer(codex, {
    type: "replace_snapshot",
    agentId: "claude-code",
    value: [{ id: "claude-a", name: "Claude task", state: "working", statusUpdatedAt: 3000 }],
    nowMs: 3000,
    displayEnabled: true,
    dismissedSessions: {},
  });
  assert.equal(claude.agentId, "claude-code");
  assert.deepEqual(claude.routingSessions.map((session) => session.id), ["claude-a"]);
  assert.equal(claude.sessions, undefined);
  assert.strictEqual(
    agentSessionFeedReducer(claude, { type: "reset" }),
    AGENT_SESSION_FEED_INITIAL_STATE,
  );
});

test("Session feed keeps working lifecycle when a Codex metadata snapshot omits state", () => {
  const event = reduce(AGENT_SESSION_FEED_INITIAL_STATE, {
    type: "apply_event",
    value: {
      id: "codex-new",
      state: "working",
      displayTitle: "Codex 会话",
      statusUpdatedAt: 1000,
    },
    nowMs: 1000,
  });
  assert.deepEqual(event.routingSessions.map((session) => session.id), ["codex-new"]);
  assert.equal(event.routingSessions[0].state, "working");

  const snapshot = reduce(event, {
    type: "replace_snapshot",
    value: [{
      id: "codex-new",
      summary: "Refactor the session router",
      lastModified: 2000,
    }],
    nowMs: 2000,
  });
  assert.equal(snapshot.routingSessions[0].state, "working");
  assert.deepEqual(snapshot.routingSessions.map((session) => session.id), ["codex-new"]);
  assert.equal(snapshot.routingSessions[0].summary, "Refactor the session router");
  assert.equal(snapshot.sessions, undefined);
});
