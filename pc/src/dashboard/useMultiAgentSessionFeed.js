/**
 * [Input] Enabled Agent ids, the active Agent, and the visible-card policy.
 * [Output] One merged P4 routing/device queue across every enabled Agent: the
 *          active Agent keeps the live event feed, other Agents refresh from
 *          bounded snapshots, and the selected card is never truncated away.
 * [Pos] Dashboard Session aggregation boundary for the multi-Agent queue.
 * [Sync] If this file changes, update `pc/src/dashboard/.folder.md` and `pc/src/.folder.md`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchAgentSessions } from "../lib/agent-bus-client.js";
import {
  buildMultiAgentDeviceQueue,
  mergeAgentRoutingSessions,
  sortRoutingSessions,
  toEnabledAgentIds,
} from "../lib/agent-focus.js";
import {
  buildP4RoutingSessions,
  filterDismissedP4Sessions,
} from "../lib/p4-session-service.js";
import { isTerminalDeviceSession } from "../lib/session-display.js";
import {
  P4_SESSION_SNAPSHOT_POLL_MS,
  useAgentSessionFeed,
} from "./useAgentSessionFeed.js";

const P4_DEVICE_SESSION_LIMIT = 8;

export function useMultiAgentSessionFeed({
  liveAgentId: requestedLiveAgentId,
  enabledAgentIds,
  displayEnabled = true,
  dismissedSessions,
  selectedSession = null,
}) {
  const agentIds = useMemo(
    () => toEnabledAgentIds(enabledAgentIds),
    [enabledAgentIds],
  );
  // Removing the active source must stop feeding it immediately; the merged
  // list then falls back to the first remaining Agent until selection resets.
  const liveAgentId = agentIds.includes(requestedLiveAgentId)
    ? requestedLiveAgentId
    : agentIds[0] || "";
  const focusFeed = useAgentSessionFeed({
    agentId: liveAgentId,
    displayEnabled,
    dismissedSessions,
  });
  const [otherByAgent, setOtherByAgent] = useState({});
  const [nowTick, setNowTick] = useState(0);
  const [queue, setQueue] = useState([]);
  const lastFocusRef = useRef({ agentId: liveAgentId, sessions: [] });

  // Keep the last active Agent's rows when the selection moves to another
  // Agent so the card does not disappear while the new live feed bootstraps.
  useEffect(() => {
    const previous = lastFocusRef.current;
    if (previous.agentId && previous.agentId !== liveAgentId && previous.sessions.length > 0) {
      setOtherByAgent((current) => ({
        ...current,
        [previous.agentId]: previous.sessions,
      }));
    }
    lastFocusRef.current = {
      agentId: liveAgentId,
      sessions: focusFeed.routingSessions,
    };
  }, [liveAgentId, focusFeed.routingSessions]);

  const agentIdsKey = agentIds.join("\u0000");
  useEffect(() => {
    const others = agentIds.filter((id) => id && id !== liveAgentId);
    setOtherByAgent((current) => {
      // Keep the active Agent's last snapshot as a bootstrap fallback; the
      // live feed replaces it as soon as its first snapshot arrives.
      const allowed = new Set(agentIds);
      const next = Object.fromEntries(
        Object.entries(current).filter(([id]) => allowed.has(id)),
      );
      const same = Object.keys(next).length === Object.keys(current).length
        && Object.keys(next).every((id) => current[id] === next[id]);
      return same ? current : next;
    });
    if (!displayEnabled || others.length === 0) return undefined;

    let cancelled = false;
    const ctl = new AbortController();
    const timers = [];
    const pending = new Set();
    const refresh = async (agentId) => {
      if (pending.has(agentId)) return;
      pending.add(agentId);
      try {
        const rows = await fetchAgentSessions(agentId, ctl.signal);
        if (cancelled) return;
        setOtherByAgent((current) => ({
          ...current,
          [agentId]: Array.isArray(rows) ? rows : [],
        }));
      } catch {
        // Keep the last confirmed snapshot; the next interval retries.
      } finally {
        pending.delete(agentId);
      }
    };
    for (const agentId of others) {
      void refresh(agentId);
      timers.push(setInterval(() => void refresh(agentId), P4_SESSION_SNAPSHOT_POLL_MS));
    }
    return () => {
      cancelled = true;
      ctl.abort();
      for (const timer of timers) clearInterval(timer);
    };
  }, [agentIdsKey, displayEnabled, liveAgentId]);

  const entries = useMemo(() => {
    const rows = [];
    if (liveAgentId) {
      const focusRows = focusFeed.loaded
        ? focusFeed.routingSessions
        : buildP4RoutingSessions(otherByAgent[liveAgentId] || []);
      rows.push({ agentId: liveAgentId, sessions: focusRows });
    }
    for (const agentId of agentIds) {
      if (!agentId || agentId === liveAgentId) continue;
      // Background snapshots need the same internal-session filtering as the
      // live feed; otherwise Codex review threads become device cards.
      rows.push({ agentId, sessions: buildP4RoutingSessions(otherByAgent[agentId] || []) });
    }
    return rows;
  }, [agentIds, liveAgentId, focusFeed.loaded, focusFeed.routingSessions, otherByAgent]);

  const routingSessions = useMemo(
    () => sortRoutingSessions(
      filterDismissedP4Sessions(
        mergeAgentRoutingSessions(entries),
        dismissedSessions,
      ),
    ),
    [dismissedSessions, entries],
  );

  const rebuild = useCallback((previousQueue) => {
    if (!displayEnabled) return [];
    // Each full Agent snapshot is authoritative for that Agent only; the live
    // event feed is authoritative only after a replace_snapshot. This preserves
    // the old single-Agent grace behavior without dropping fresh event cards.
    const authoritativeAgentIds = agentIds.filter((agentId) => (
      agentId === liveAgentId
        ? focusFeed.authoritativeSnapshot === true
        : Array.isArray(otherByAgent[agentId])
    ));
    return buildMultiAgentDeviceQueue({
      routingSessions,
      previousQueue,
      nowMs: Date.now(),
      selectedSession,
      limit: P4_DEVICE_SESSION_LIMIT,
      enabledAgentIds: agentIds,
      authoritativeAgentIds,
    });
  }, [
    agentIds,
    displayEnabled,
    focusFeed.authoritativeSnapshot,
    focusFeed.snapshotAt,
    liveAgentId,
    otherByAgent,
    routingSessions,
    selectedSession,
  ]);

  useEffect(() => {
    setQueue((previous) => rebuild(previous));
  }, [rebuild, nowTick]);

  const hasTerminal = displayEnabled && queue.some(isTerminalDeviceSession);
  useEffect(() => {
    if (!hasTerminal) return undefined;
    const timer = setInterval(() => {
      setNowTick((value) => value + 1);
    }, 1_000);
    return () => clearInterval(timer);
  }, [hasTerminal]);

  const loaded = focusFeed.loaded || agentIds.some((agentId) => (
    agentId !== liveAgentId && Array.isArray(otherByAgent[agentId])
  ));

  return {
    sessions: queue,
    routingSessions,
    loaded,
    focusFeed,
    otherByAgent,
  };
}
