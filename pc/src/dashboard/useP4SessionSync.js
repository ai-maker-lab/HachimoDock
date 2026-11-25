/**
 * [Input] Followed Agent Session feed, P4 identity/connection, visibility policy, and dashboard notifications.
 * [Output] Exact visible-card selection, foreground-voice lease reconciliation, temporary routing target, encoder handling, and serialized P4 Session downlinks.
 * [Pos] Dashboard-to-device Session synchronization boundary.
 * [Sync] If this file changes, update `pc/src/dashboard/.folder.md` and `pc/src/.folder.md`.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { agentSessionFeedFresh } from "./useAgentSessionFeed.js";
import {
  deviceSessionIdentity,
  deviceSessionTerminalUntilMs,
  deviceSessionTransitionRevision,
  filterActiveDeviceSessions,
  hasVerifiedUnknownActivity,
} from "../lib/session-display.js";
import {
  buildP4DeviceSessionTransportPayload,
  enqueueP4SessionBinding,
  filterDismissedP4Sessions,
  p4SessionDisplayTitle,
  p4SessionActivitySignature,
} from "../lib/p4-session-service.js";

export const P4_MANUAL_SESSION_TIMEOUT_MS = 5 * 60_000;
export const P4_SESSION_LEASE_REFRESH_MS = 4_000;
const P4_DEVICE_SESSION_LIMIT = 8;

export function createMissingSessionNoticeGate() {
  let lastContext = null;
  let lastEventAt = -Infinity;
  return {
    allow(context, now = performance.now()) {
      const allowed = context !== lastContext || now - lastEventAt >= 5_000;
      // Update on every event, so a held/floating input cannot keep producing
      // warnings. A new attempt after five quiet seconds can notify again.
      lastContext = context;
      lastEventAt = now;
      return allowed;
    },
    reset() {
      lastContext = null;
      lastEventAt = -Infinity;
    },
  };
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function clampUtf8Text(value, maxBytes) {
  let output = "";
  for (const char of String(value || "")) {
    if (new TextEncoder().encode(output + char).length > maxBytes) break;
    output += char;
  }
  return output;
}

export function cycleVoiceSessionId(currentSessionId, sessions, direction) {
  const sessionIds = [...new Set((Array.isArray(sessions) ? sessions : [])
    .map((session) => normalizeText(session?.id))
    .filter(Boolean))];
  if (!sessionIds.length) return "auto";
  const normalizedCurrent = normalizeText(currentSessionId);
  const currentIndex = normalizedCurrent && normalizedCurrent !== "auto"
    ? sessionIds.indexOf(normalizedCurrent)
    : 0;
  if (currentIndex < 0) return sessionIds[0];
  if (sessionIds.length === 1) return sessionIds[0];
  return sessionIds[
    (currentIndex + (direction < 0 ? -1 : 1) + sessionIds.length) % sessionIds.length
  ];
}

export function formatDeviceSessionTitle(session, fallbackSessionId = "") {
  const title = p4SessionDisplayTitle(session);
  if (title) return title;
  const sessionId = normalizeText(session?.id) || normalizeText(fallbackSessionId);
  return sessionId && sessionId !== "auto" ? `会话 ${sessionId.slice(0, 8)}` : "";
}

export function nextWifiSelectionAction({
  connectionChanged,
  hasRow,
  selectionKey,
  lastSelectionKey,
}) {
  // A reported device card wins over the connection reset in the same update;
  // the reset only applies when the new link has no selectable card.
  if (hasRow && selectionKey !== lastSelectionKey) return "apply";
  if (connectionChanged) return "reset";
  return "ignore";
}

export function isDeviceSessionTargetUnique(selectedSession, sessions) {
  const selectedTitle = formatDeviceSessionTitle(selectedSession);
  if (!selectedTitle) return false;
  const titleMatches = (Array.isArray(sessions) ? sessions : []).filter(
    (session) => formatDeviceSessionTitle(session) === selectedTitle,
  );
  if (titleMatches.length <= 1) return true;
  const selectedCwd = normalizeText(selectedSession?.cwd);
  if (!selectedCwd) return false;
  return titleMatches.filter(
    (session) => normalizeText(session?.cwd) === selectedCwd,
  ).length === 1;
}

export function formatDeviceSessionContent(session, title = "") {
  if (normalizeText(session?.state).toLowerCase() === "stopped") return "已停止";
  const liveContent = normalizeText(session?.displayContent);
  if (liveContent) return clampUtf8Text(liveContent, 383);
  if (hasVerifiedUnknownActivity(session)) return "运行中 · 具体阶段未确认";
  const summary = normalizeText(session?.summary);
  if (!summary || summary.startsWith("<recommended_plugins>")) return "";
  if (summary === normalizeText(title)) return "";
  return clampUtf8Text(summary, 383);
}

export function useP4SessionSync({
  enabled,
  boardDeviceId,
  agentId,
  usbConnected,
  usbConnectionId = "",
  usbBootId = "",
  displayEnabled,
  sessions,
  routingSessions,
  sessionsLoaded,
  dismissedSessions,
  onDismissSessions,
  formatSessionOption,
  selection,
  setSelection,
  rememberAgent,
  wifi,
  push,
}) {
  // One merged Session list; the selection is the only state. `agentId` is
  // only the fallback source used while no Session is selectable.
  const [bindingSyncRevision, requestBindingSync] = useReducer(
    (revision) => revision + 1,
    0,
  );
  const pendingNoticeRef = useRef(null);
  const missingSessionNoticeRef = useRef(null);
  if (!missingSessionNoticeRef.current) {
    missingSessionNoticeRef.current = createMissingSessionNoticeGate();
  }
  const bindingQueueRef = useRef(Promise.resolve());
  const bindingScope = useMemo(() => ({}), [
    enabled,
    boardDeviceId,
    agentId,
    usbConnected,
    usbConnectionId,
    usbBootId,
  ]);
  const bindingScopeRef = useRef(bindingScope);
  bindingScopeRef.current = bindingScope;
  useEffect(() => {
    bindingScopeRef.current = bindingScope;
    return () => { if (bindingScopeRef.current === bindingScope) bindingScopeRef.current = null; };
  }, [bindingScope]);
  const sessionId = selection.sessionId;
  const selectionAgentId = normalizeText(selection.agentId);

  const visibleSessions = useMemo(
    () => filterDismissedP4Sessions(sessions, dismissedSessions),
    [dismissedSessions, sessions],
  );
  const selectableSessions = useMemo(
    () => displayEnabled ? visibleSessions : [],
    [displayEnabled, visibleSessions],
  );
  const switchCandidates = selectableSessions;
  // One merged Session list: `auto` is the newest selectable Session, exactly
  // like the old single-Agent list. DSH still requires an explicit Session and
  // never participates in auto selection.
  const autoEligible = (session) => normalizeText(session?.agentId) !== "deepseek-harness";
  const autoVisibleSession = (routingSessions || []).filter(autoEligible)
    .map(row => selectableSessions.find(card => deviceSessionIdentity(card) === deviceSessionIdentity(row)))
    .find(Boolean) || selectableSessions.find(autoEligible) || null;
  const autoRoutingSession = autoVisibleSession
    || (routingSessions || []).find(autoEligible)
    || filterDismissedP4Sessions(sessions, dismissedSessions).find(autoEligible)
    || null;
  const matchesSelection = useCallback((session) => {
    if (normalizeText(session?.id) !== normalizeText(sessionId)) return false;
    return !selectionAgentId || normalizeText(session?.agentId) === selectionAgentId;
  }, [selectionAgentId, sessionId]);
  const selectedRoutingSession = (sessionId === "auto"
    ? autoRoutingSession
    : (routingSessions || []).find(matchesSelection)) || null;
  const selectedVisibleSession = sessionId === "auto"
    ? autoVisibleSession
    : selectableSessions.find(matchesSelection) || null;
  const selectedTargetSession = selectedRoutingSession || selectedVisibleSession;
  const selectedAgentId = selectionAgentId
    || normalizeText(selectedTargetSession?.agentId)
    || agentId;
  // The device binding resolves `auto` to a real Session; voice/injection
  // targets must use that resolved id, matching the old single-Agent lease.
  const selectedRealSessionId = normalizeText(selectedTargetSession?.id)
    || (sessionId === "auto" ? "" : normalizeText(sessionId));
  const selectedSessionTitle = selectedTargetSession
    ? formatDeviceSessionTitle(selectedTargetSession, sessionId)
    : "";
  const selectedDeviceSessionTitle = selectedVisibleSession
    ? formatDeviceSessionTitle(selectedVisibleSession, sessionId)
    : "";
  const selectedSessionCwd = normalizeText(selectedTargetSession?.cwd);
  const selectedSessionTitleUnique = isDeviceSessionTargetUnique(
    selectedTargetSession,
    (routingSessions || []).filter(session => session.agentId === selectedAgentId),
  );
  const selectedSessionIndex = selectedVisibleSession
    ? selectableSessions.findIndex((session) => session === selectedVisibleSession) + 1
    : 0;
  const deviceSessions = useMemo(() => selectableSessions.map((session) => {
    const title = formatDeviceSessionTitle(session);
    return {
      id: clampUtf8Text(normalizeText(session?.id), 127),
      agentId: normalizeText(session?.agentId),
      title: clampUtf8Text(title, 191),
      cwd: clampUtf8Text(normalizeText(session?.cwd), 2048),
      content: formatDeviceSessionContent(session, title),
      // Device's generic active visual is not a claimed lifecycle stage. The
      // source row remains state=unknown with its independent live evidence.
      state: hasVerifiedUnknownActivity(session) ? "working" : normalizeText(session?.state).toLowerCase() || "idle",
      transitionRevision: deviceSessionTransitionRevision(session),
      terminalUntilMs: deviceSessionTerminalUntilMs(session),
    };
  }), [selectableSessions]);
  const deviceSessionsSignature = JSON.stringify(deviceSessions);
  const activeSessionIds = useMemo(
    () => filterActiveDeviceSessions(selectableSessions)
      .slice(0, P4_DEVICE_SESSION_LIMIT)
      .map((session) => clampUtf8Text(normalizeText(session?.id), 127))
      .filter(Boolean),
    [selectableSessions],
  );
  const activeSessionIdsSignature = JSON.stringify(activeSessionIds);
  const cardsEnabled = displayEnabled && deviceSessions.length > 0;

  const onSessionChange = useCallback((nextSessionId, nextAgentId = "") => {
    const value = nextSessionId && nextSessionId !== "auto" ? nextSessionId : "auto";
    const agent = value === "auto"
      ? ""
      : normalizeText(nextAgentId) || selectionAgentId || agentId;
    setSelection({
      agentId: agent,
      sessionId: value,
      selectedAt: value === "auto" ? 0 : Date.now(),
    });
  }, [agentId, selectionAgentId]);

  const pendingAgent = useRef("");
  useEffect(() => {
    if (!selectedAgentId || selectedAgentId === agentId || pendingAgent.current) return;
    pendingAgent.current = selectedAgentId;
    rememberAgent(selectedAgentId).catch((error) => {
      push?.({ tone: "warning", title: "会话路由同步失败，将重试", message: String(error) });
    }).finally(() => { pendingAgent.current = ""; });
  }, [selectedAgentId, agentId, rememberAgent, bindingSyncRevision, push]);

  const lastConnectionIdentity = useRef("");
  const lastWifiSelection = useRef("");
  useEffect(() => {
    const identity = [boardDeviceId, wifi?.boardDeviceId, wifi?.bootId].join("/");
    const connectionChanged = identity !== lastConnectionIdentity.current;
    if (connectionChanged) {
      lastConnectionIdentity.current = identity;
      // Allow the new link to re-apply its reported card after the reset gate.
      lastWifiSelection.current = "";
      pendingNoticeRef.current = null;
    }
    const selectionKey = [wifi?.boardDeviceId, wifi?.bootId, wifi?.selectionSequence].join("/");
    const row = wifi?.selectionSequence
      ? selectableSessions.find(
        (session) => session.id === wifi.selectionSession && session.agentId === wifi.selectionAgent,
      )
      : null;
    const action = nextWifiSelectionAction({
      connectionChanged,
      hasRow: Boolean(row),
      selectionKey,
      lastSelectionKey: lastWifiSelection.current,
    });
    if (action === "apply") {
      lastWifiSelection.current = selectionKey;
      onSessionChange(row.id, row.agentId);
      return;
    }
    if (action === "reset") {
      setSelection({ agentId: "", sessionId: "auto", selectedAt: 0 });
    }
  }, [
    boardDeviceId,
    wifi?.boardDeviceId,
    wifi?.bootId,
    wifi?.selectionSequence,
    wifi?.selectionSession,
    wifi?.selectionAgent,
    selectableSessions,
    onSessionChange,
    setSelection,
  ]);

  useEffect(() => {
    if (!agentId) return undefined;
    const timer = setInterval(requestBindingSync, P4_SESSION_LEASE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [agentId]);

  useEffect(() => {
    if (sessionId === "auto") return undefined;
    const selectedStillExists = switchCandidates.some(matchesSelection);
    if (!selectedStillExists) {
      onSessionChange("auto");
      return undefined;
    }
    if (selectedAgentId === "deepseek-harness") return undefined;
    const elapsed = Date.now() - selection.selectedAt;
    const delay = Math.max(0, P4_MANUAL_SESSION_TIMEOUT_MS - elapsed);
    const timer = setTimeout(() => onSessionChange("auto"), delay);
    return () => clearTimeout(timer);
  }, [agentId, matchesSelection, onSessionChange, selection.selectedAt, sessionId, switchCandidates]);

  useEffect(() => {
    if (!agentId) return;
    // The selected Session defines the active Agent; wait for the native
    // state/speech scope to follow it before committing the binding.
    if (selectedAgentId !== agentId) return;
    const pendingNotice = pendingNoticeRef.current;
    const matchedNotice = pendingNotice?.sessionId === sessionId
      && (!pendingNotice?.agentId || pendingNotice.agentId === selectedAgentId)
      ? pendingNotice
      : null;
    const notice = matchedNotice?.message || "";
    const confirmedSnapshot = sessionsLoaded && (selectableSessions.length === 0
      || selectableSessions.every(session => !autoEligible(session)));
    if (
      ["codex", "claude-code"].includes(selectedAgentId)
      && !selectedRoutingSession
      && !confirmedSnapshot
    ) return;
    const autoFollow = sessionId === "auto" && Boolean(selectedRoutingSession);
    const requestedSessionId = autoFollow
      ? normalizeText(selectedRoutingSession?.id)
      : sessionId;
    const requestedAgentId = autoFollow
      ? normalizeText(selectedRoutingSession?.agentId) || selectedAgentId
      : selectedAgentId;
    if (wifi && !usbConnected && sessionsLoaded && agentSessionFeedFresh(selectedAgentId)) {
      const lanSessions = wifi?.sessionSelection ? deviceSessions
        : deviceSessions.filter(row => row.agentId === requestedAgentId);
      const lanSelectedIndex = lanSessions.findIndex(row =>
        row.agentId === requestedAgentId && row.id === requestedSessionId);
      invoke("lan_agent_sessions", {
        input: {
          agentId: requestedAgentId,
          sessionId: requestedSessionId,
          title: selectedDeviceSessionTitle,
          boardDeviceId: wifi?.boardDeviceId,
          bootId: wifi?.bootId,
          sessionCwd: selectedSessionCwd,
          sessionTitleUnique: selectedSessionTitleUnique,
          selectionSequence: wifi?.selectionSequence || 0,
          autoFollow,
          index: lanSelectedIndex >= 0 ? lanSelectedIndex + 1 : 0,
          count: lanSessions.length,
          sessions: buildP4DeviceSessionTransportPayload(lanSessions),
          activeSessionIds: activeSessionIds.filter((id) => (
            lanSessions.some((session) => session.id === id)
          )),
          displayEnabled: cardsEnabled,
        },
      }).catch(() => {});
    }
    if (!usbConnected || !enabled || !boardDeviceId) return;
    if (matchedNotice) pendingNoticeRef.current = null;
    const isCurrent = () => bindingScopeRef.current === bindingScope;
    const bindingPromise = enqueueP4SessionBinding(bindingQueueRef.current, isCurrent,
      () => invoke("set_p4_session_binding", {
        input: {
          boardDeviceId,
          agentId: selectedAgentId,
          expectedConnectionId: usbConnectionId,
          expectedBootId: usbBootId,
          sessionId: requestedSessionId,
          autoFollow,
          sessionTitle: selectedSessionTitle,
          deviceTitle: selectedDeviceSessionTitle,
          sessionCwd: selectedSessionCwd,
          sessionTitleUnique: selectedSessionTitleUnique,
          locateDesktop: Boolean(matchedNotice),
          sessionIndex: selectedSessionIndex,
          sessionCount: selectableSessions.length,
          sessions: buildP4DeviceSessionTransportPayload(deviceSessions),
          activeSessionIds,
          displayEnabled: cardsEnabled,
          notice,
        },
      }));
    bindingQueueRef.current = bindingPromise.catch(() => undefined);
    bindingPromise
      .then((result) => {
        if (!isCurrent() || !result) return;
        const resultSessionId = normalizeText(result?.sessionId) || "auto";
        if (resultSessionId !== requestedSessionId || !matchedNotice) return;
        const location = normalizeText(result?.desktopLocation).toLowerCase();
        const locationError = normalizeText(result?.desktopLocationError);
        const desktopAgentLabel = selectedAgentId === "claude-code" ? "Claude" : "ChatGPT（Codex）";
        if (["codex", "claude-code"].includes(selectedAgentId) && location !== "located") {
          push?.({
            tone: "warning",
            title: `会话已切换，${desktopAgentLabel} 定位失败`,
            message: locationError || matchedNotice.sessionLabel,
          });
          return;
        }
        push?.({
          tone: "success",
          title: ["codex", "claude-code"].includes(selectedAgentId)
            ? `${matchedNotice.title}并定位`
            : matchedNotice.title,
          message: matchedNotice.sessionLabel,
        });
      })
      .catch((error) => {
        if (!isCurrent()) return;
        console.warn("[p4] failed to update target session", error);
        if (matchedNotice) {
          push?.({ tone: "error", title: "会话切换失败", message: String(error) });
        }
      });
  }, [
    activeSessionIdsSignature,
    bindingScope,
    agentId,
    bindingSyncRevision,
    boardDeviceId,
    cardsEnabled,
    deviceSessionsSignature,
    enabled,
    push,
    selectableSessions.length,
    selectedAgentId,
    selectedDeviceSessionTitle,
    selectedRoutingSession,
    selectedSessionCwd,
    selectedSessionIndex,
    selectedSessionTitle,
    selectedSessionTitleUnique,
    sessionId,
    sessionsLoaded,
    usbConnected,
    wifi,
    usbConnectionId,
    usbBootId,
  ]);

  useEffect(() => {
    if (!enabled || !boardDeviceId || !agentId) return undefined;
    let disposed = false;
    let unlistenSessionSwitch = null;
    let unlistenCurrentVoice = null;

    const setup = async () => {
      unlistenSessionSwitch = await listen("usb-message", (event) => {
        const envelope = event?.payload && typeof event.payload === "object"
          ? event.payload
          : {};
        if (envelope.topic !== "input/event") return;
        const payload = envelope.payload && typeof envelope.payload === "object"
          ? envelope.payload
          : {};
        if (normalizeText(payload.boardDeviceId) !== boardDeviceId) return;
        const action = normalizeText(payload.action);
        if (action === "session_clear") {
          const dismissed = {};
          for (const session of sessions || []) {
            const identity = deviceSessionIdentity(session);
            if (identity) dismissed[identity] = p4SessionActivitySignature(session);
          }
          pendingNoticeRef.current = null;
          onDismissSessions?.(dismissed);
          push?.({
            tone: "success",
            title: "主页会话已清空",
            message: "新会话或新活动会自动重新显示。",
          });
          return;
        }
        const direction = action === "session_next"
          ? 1
          : action === "session_previous"
            ? -1
            : 0;
        if (!direction) return;

        const boardSelectedAgentId = normalizeText(payload.agentId);
        const boardSelectedSessionId = normalizeText(payload.sessionId);
        const boardSelectedIndex = Number(payload.sessionIndex) || 0;
        const boardSelectedCount = Number(payload.sessionCount) || 0;
        let boardSelectedSession = null;
        if (boardSelectedSessionId || boardSelectedAgentId) {
          boardSelectedSession = deviceSessions.find((session) => (
            (!boardSelectedAgentId || normalizeText(session?.agentId) === boardSelectedAgentId)
            && (!boardSelectedSessionId || normalizeText(session?.id) === boardSelectedSessionId)
          )) || null;
        }
        // Older firmware returns only `sessionId`/`sessionIndex`; when two
        // Agents share a raw id, the index into the last snapshot disambiguates.
        if (!boardSelectedSession
            && boardSelectedIndex > 0
            && boardSelectedIndex <= deviceSessions.length
            && (!boardSelectedCount || boardSelectedCount === deviceSessions.length)) {
          const indexed = deviceSessions[boardSelectedIndex - 1];
          if (indexed
              && (!boardSelectedSessionId || normalizeText(indexed?.id) === boardSelectedSessionId)) {
            boardSelectedSession = indexed;
          }
        }
        const nextSessionId = boardSelectedSession
          ? normalizeText(boardSelectedSession.id)
          : cycleVoiceSessionId(sessionId, switchCandidates, direction);
        const nextAgentId = normalizeText(boardSelectedSession?.agentId);
        if (nextSessionId === "auto") {
          if (!missingSessionNoticeRef.current.allow(JSON.stringify([boardDeviceId, selectedAgentId]))) return;
          push?.({
            tone: "warning",
            title: "没有可切换的会话",
            message: sessionsLoaded
              ? "当前 Agent 暂无可切换的会话。"
              : "请等待当前 Agent 的会话列表加载完成。",
            ttl: 3_000,
          });
          return;
        }
        missingSessionNoticeRef.current.reset();
        pendingNoticeRef.current = {
          sessionId: nextSessionId,
          agentId: nextAgentId,
          message: direction > 0 ? "已切换到下一个会话" : "已切换到上一个会话",
          title: direction > 0 ? "已切换到下一个会话" : "已切换到上一个会话",
          sessionLabel: formatSessionOption?.(
            boardSelectedSession || switchCandidates.find((session) => (
              normalizeText(session?.id) === nextSessionId
              && (!nextAgentId || normalizeText(session?.agentId) === nextAgentId)
            )),
          ) || "",
        };
        onSessionChange(nextSessionId, nextAgentId);
        requestBindingSync();
      });
      unlistenCurrentVoice = await listen("voice-transcript", (event) => {
        const payload = event?.payload && typeof event.payload === "object"
          ? event.payload
          : {};
        if (normalizeText(payload.boardDeviceId) !== boardDeviceId) return;
        if (normalizeText(payload.agentId) !== selectedAgentId) return;
        if (normalizeText(payload.phase).toLowerCase() !== "submitted") return;
        if (normalizeText(payload.sessionId).toLowerCase() !== "current") return;

        // The foreground Agent session has just received the confirmed turn.
        // Release a stale manual device-card lease so the refreshed newest
        // session becomes the selected bubble instead of jumping back later.
        pendingNoticeRef.current = null;
        onSessionChange("auto");
        requestBindingSync();
      });
      if (disposed) {
        unlistenSessionSwitch?.();
        unlistenCurrentVoice?.();
      }
    };

    setup().catch((error) => {
      console.warn("[device] failed to listen for session or voice routing events", error);
    });
    return () => {
      disposed = true;
      unlistenSessionSwitch?.();
      unlistenCurrentVoice?.();
    };
  }, [
    agentId,
    boardDeviceId,
    deviceSessions,
    enabled,
    selectedAgentId,
    formatSessionOption,
    onDismissSessions,
    onSessionChange,
    push,
    sessionId,
    sessions,
    sessionsLoaded,
    switchCandidates,
  ]);

  return {
    sessionId,
    selectedAgentId,
    selectedRealSessionId,
    sessions: Array.isArray(sessions) ? sessions : [],
    routingSessions: Array.isArray(routingSessions) ? routingSessions : [],
    sessionsLoaded,
    selectedRoutingSession,
    selectableSessions,
    onSessionChange,
  };
}
