/**
 * [Input] Enabled Agent ids and per-Agent session rows.
 * [Output] Multi-Agent session helpers: session tagging, merged routing rows, and a bounded device queue that always retains the selected item.
 * [Pos] lib node in pc/src/lib
 * [Sync] If this file changes, update `pc/src/.folder.md` and the P4 session callers.
 */

import {
  deviceSessionIdentity,
  isActiveDeviceSession,
  reconcileDeviceSessionQueue,
} from "./session-display.js";
import { p4SessionHasMeaningfulTitle } from "./p4-session-service.js";

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function toEnabledAgentIds(value) {
  const values = typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value
      : value && typeof value[Symbol.iterator] === "function"
        ? [...value]
        : [];
  const seen = new Set();
  const output = [];
  for (const raw of values) {
    const id = normalizeText(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    output.push(id);
  }
  return output;
}

export function sessionAgentId(session) {
  return normalizeText(session?.agentId) || "";
}

export function tagSessionForAgent(agentId, session) {
  const agent = normalizeText(agentId);
  const sessionId = normalizeText(session?.id);
  if (!agent || !sessionId) return null;
  return {
    ...session,
    // `id` stays the real device-visible session id. The Agent namespace only
    // exists on the PC side and in the protocol's per-item `agentId`.
    agentId: agent,
  };
}

export function tagAgentSessions(agentId, sessions) {
  return (Array.isArray(sessions) ? sessions : [])
    .map((session) => tagSessionForAgent(agentId, session))
    .filter(Boolean);
}

/**
 * Merge per-Agent routing rows into one list. Each entry keeps the caller's
 * order (enabled order), and duplicate `(agentId, id)` rows collapse to the
 * freshest one.
 */
export function mergeAgentRoutingSessions(entries) {
  const byKey = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const rows = tagAgentSessions(entry?.agentId, entry?.sessions);
    for (const row of rows) {
      const identity = deviceSessionIdentity(row);
      if (!identity) continue;
      const existing = byKey.get(identity);
      if (!existing || Number(row.lastModified || 0) >= Number(existing.lastModified || 0)) {
        byKey.set(identity, row);
      }
    }
  }
  return [...byKey.values()];
}

function recency(session) {
  return Math.max(
    Number(session?.statusUpdatedAt || 0),
    Number(session?.lastModified || 0),
  );
}

export function sortRoutingSessions(sessions) {
  return (Array.isArray(sessions) ? [...sessions] : [])
    .sort((a, b) => recency(b) - recency(a));
}

export function sessionMatchesSelection(session, selection) {
  if (!session || !selection) return false;
  const sessionId = normalizeText(selection.sessionId) || normalizeText(selection.id);
  if (!sessionId || normalizeText(session?.id) !== sessionId) return false;
  const agentId = normalizeText(selection.agentId);
  return !agentId || sessionAgentId(session) === agentId;
}

function replaceForSelection(queue, selected, limit) {
  if (!selected || queue.some((session) => deviceSessionIdentity(session) === deviceSessionIdentity(selected))) {
    return queue;
  }
  if (queue.length < limit) return [...queue, selected];
  const next = [...queue];
  let index = -1;
  for (let i = next.length - 1; i >= 0; i -= 1) {
    if (!isActiveDeviceSession(next[i])) {
      index = i;
      break;
    }
  }
  if (index < 0) index = next.length - 1;
  next[index] = selected;
  return next;
}

/**
 * Build the device-visible queue across Agents. `routingSessions` must already
 * carry `agentId` and the real session `id`. The selected item is never
 * truncated away while it is active.
 */
export function buildMultiAgentDeviceQueue({
  routingSessions,
  previousQueue = [],
  nowMs = Date.now(),
  selectedSession = null,
  limit = 8,
  authoritativeSnapshot = false,
  enabledAgentIds = null,
  authoritativeAgentIds = null,
}) {
  const queueLimit = Math.max(0, Math.floor(Number(limit) || 0));
  if (queueLimit === 0) return [];
  const enabledAgents = enabledAgentIds ? new Set(toEnabledAgentIds(enabledAgentIds)) : null;
  // A removed source stops contributing immediately; its old card must not be
  // retained just because it was active when the removal happened.
  const previous = enabledAgents
    ? previousQueue.filter((session) => {
      const agentId = sessionAgentId(session);
      return !agentId || enabledAgents.has(agentId);
    })
    : previousQueue;
  const rows = sortRoutingSessions(routingSessions);
  const eligible = rows.filter((session) => (
    !isActiveDeviceSession(session) || p4SessionHasMeaningfulTitle(session)
  ));
  const queue = reconcileDeviceSessionQueue(
    previous,
    eligible,
    nowMs,
    queueLimit,
    { authoritativeSnapshot, authoritativeAgentIds },
  );
  // Only an active selected row gets a guaranteed slot; a terminal row follows
  // the normal 60-second retain/expiry path so selecting it cannot resurrect it.
  const selected = rows.find((session) => (
    sessionMatchesSelection(session, selectedSession) && isActiveDeviceSession(session)
  )) || null;
  return replaceForSelection(queue, selected, queueLimit);
}
