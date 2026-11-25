/**
 * [Input] useDeviceContext for appearances/agentOptions/currentDisplay/enabledAgents/verified USB status/cancellable appearanceSync/refreshAppearances/applyDesktopPet/enableQueuedAgent/removeQueuedAgent/cancelAppearanceSync; useToast for notices.
 * [Output] Agent matrix with start/stop switches, authenticated USB/Wi-Fi appearance sync, cancel controls, and Devin cloud configuration.
 * [Pos] component node in pc/src/dashboard
 * [Sync] If this file changes, update `pc/src/dashboard/.folder.md`.
 */

import React, { useCallback, useMemo, useState } from "react";
import {
  CheckCircle,
  Pause,
  Play,
  Repeat2,
  Braces,
  Code,
  Loader,
  Terminal,
  UploadCloud,
  X,
  Zap,
} from "lucide-react";
import {
  appearanceById,
  channelLabelForId,
} from "../lib/agent-appearance-config.js";
import { BUILTIN_TERRIER_APPEARANCE_ID } from "../lib/builtin-appearances.js";
import {
  APPEARANCE_SYNC_CANCELLED_MESSAGE,
  APPEARANCE_CHANGE_USB_REQUIRED_MESSAGE,
} from "../lib/desktop-pet-assignment.js";
import AppearancePreview from "../AppearancePreview.jsx";
import { resolveDashboardPreviewMedia } from "../lib/appearance-preview.js";
import { useDeviceContext } from "../shell/DeviceContext.jsx";
import { useDialogFocus } from "../component-center/use-dialog-focus.js";
import Card from "../shell/Card.jsx";
import { appearanceStateLabel } from "../lib/appearance-state-label.js";
import Button from "../shell/Button.jsx";
import { useToast } from "../shell/ToastStack.jsx";
import DevinConfigurationButton from "./DevinConfigurationButton.jsx";

const AGENT_ICONS = {
  "claude-code": Code,
  codex: Terminal,
  openclaw: Zap,
  mimocode: Braces,
  workbuddy: Code,
  devin: Code,
  "deepseek-harness": Braces,
};

function appearanceKindLabel(appearance) {
  if (appearance?.type === "codex-import") return "Codex pet";
  if (appearance?.type === "builtin") return "内置";
  return "自定义";
}

function normalizeSyncProgress(progress = {}) {
  const bytesSent = Number(progress.bytesSent || 0);
  const bytesTotal = Number(progress.bytesTotal || 0);
  const rawPercent = Number(progress.percent);
  const percent = Number.isFinite(rawPercent)
    ? rawPercent
    : bytesTotal > 0
      ? Math.round((bytesSent / bytesTotal) * 100)
      : 0;
  return {
    text: progress.text || "正在通过 USB 下发形象素材...",
    // Follow-only switches reuse the device's current appearance: nothing is
    // transferred, so there is no byte progress and nothing to abort.
    followOnly: progress.followOnly === true,
    indeterminate: progress.followOnly === true || progress.indeterminate === true,
    currentFile: Number(progress.currentFile || 0),
    totalFiles: Number(progress.totalFiles || 0),
    bytesSent,
    bytesTotal,
    percent: Math.max(0, Math.min(100, Math.round(percent))),
  };
}

export default function ChannelMatrixCard({ children, subtitle, actions }) {
  const {
    appearances,
    agentOptions,
    currentDisplay,
    enabledAgents,
    usb,
    wifi,
    appearanceSync,
    refreshAppearances,
    applyDesktopPet,
    enableQueuedAgent,
    removeQueuedAgent,
    cancelAppearanceSync,
  } = useDeviceContext();
  const { push } = useToast();

  const [pickerOpen, setPickerOpen] = useState(false);
  const syncing = appearanceSync?.pending === true;
  const syncProgress = appearanceSync?.progress
    ? normalizeSyncProgress(appearanceSync.progress)
    : null;

  const visibleAgents = useMemo(() => agentOptions.filter((agent) => agent?.id), [agentOptions]);
  const activeAgentId = currentDisplay.agentId;
  // Queue membership does not need a device; appearance sync still does.
  const canSyncAppearance = Boolean(usb?.connected || wifi);
  const queuedAgentCount = enabledAgents?.size || 0;

  const closePicker = useCallback(() => setPickerOpen(false), []);

  const openPicker = useCallback(() => {
    setPickerOpen(true);
    refreshAppearances().catch((error) => {
      console.warn("[ChannelMatrixCard] appearance refresh failed", error);
    });
  }, [refreshAppearances]);

  const handleConfirmAppearance = useCallback(async (appearance) => {
    if (!appearance?.id) return;
    closePicker();
    try {
      const { notice } = await applyDesktopPet(appearance, {
        initialProgress: {
          text: `准备下发「${appearance.name}」到设备端...`,
          percent: 0,
          indeterminate: true,
        },
      });
      push({ tone: "success", title: notice || `已同步「${appearance.name}」到设备端` });
    } catch (err) {
      const msg = err?.message || String(err);
      const cancelled = msg === APPEARANCE_SYNC_CANCELLED_MESSAGE;
      const tone =
        cancelled || msg === APPEARANCE_CHANGE_USB_REQUIRED_MESSAGE ? "warning" : "error";
      push({
        tone,
        title: cancelled ? "形象传输已中断" : "更换形象失败",
        message: cancelled ? "已停止本次操作。" : msg,
      });
    }
  }, [applyDesktopPet, closePicker, push]);

  const handleEnable = useCallback(async (agentId) => {
    try {
      const result = await enableQueuedAgent(agentId);
      push({
        tone: "success",
        title: result?.notice || `已启动 ${channelLabelForId(agentOptions, agentId)}`,
      });
    } catch (error) {
      push({
        tone: "error",
        title: "启动 Agent 失败",
        message: error?.message || String(error),
      });
    }
  }, [agentOptions, enableQueuedAgent, push]);

  const handleRemove = useCallback(async (agentId) => {
    try {
      const result = await removeQueuedAgent(agentId);
      if (result?.notice) push({ tone: "success", title: result.notice });
    } catch (error) {
      push({
        tone: "warning",
        title: "关闭 Agent 失败",
        message: error?.message || String(error),
      });
    }
  }, [push, removeQueuedAgent]);

  const handleCancelAppearanceSync = useCallback(async () => {
    try {
      await cancelAppearanceSync();
    } catch (error) {
      push({
        tone: "error",
        title: "无法中断形象传输",
        message: error?.message || String(error),
      });
    }
  }, [cancelAppearanceSync, push]);

  const appearance = currentDisplay.appearance;
  const media = resolveDashboardPreviewMedia(appearance);
  let pickerHint = "";
  if (syncing) pickerHint = "当前同步完成后可更换形象。";
  else if (!canSyncAppearance) pickerHint = "设备连接 USB 或 Wi-Fi 后可更换形象。";
  const [playing, setPlaying] = useState(() => !window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  return (<>
    {children}
    {appearance && <section className="companion-hero" aria-label="当前跟随的桌宠">
      <div>
        <span className="kicker">{currentDisplay.appearanceUnverified ? "已配置形象 · 待设备确认" : "当前形象"}</span>
        <h2>{appearance.name}</h2>
        {activeAgentId && <div className="meta">当前会话来源<strong>{currentDisplay.channelLabel}</strong></div>}
        <button type="button" className="action" onClick={openPicker}
          disabled={Boolean(pickerHint)} aria-describedby={pickerHint ? "appearance-picker-hint" : undefined}>
          <Repeat2 size={15} /> 更换形象
        </button>
        {pickerHint && <p id="appearance-picker-hint" className="muted small">{pickerHint}</p>}
      </div>
      <figure className="screen">
        <div className="film">
          <AppearancePreview key={appearance.id} media={media} playing={playing} className="companion-media" />
          {media.kind === "video" && <button type="button" aria-label={playing ? "暂停预览" : "播放预览"}
            onClick={() => setPlaying(value => !value)}>
            {playing ? <Pause size={14} /> : <Play size={14} />}
          </button>}
        </div>
        <figcaption><span>{media.kind === "video" ? "动作预览" : "形象预览"}</span>
          {media.kind === "video" && <span>{appearanceStateLabel(media.label)}</span>}</figcaption>
      </figure>
    </section>}
    <Card subtitle={subtitle} actions={actions}>
    <div className="channel-matrix" role="region" aria-label="管理会话队列的 Agent">
      {syncProgress && (
        <div className="channel-matrix-sync" aria-live="polite">
          <div className="channel-matrix-sync__copy">
            <UploadCloud size={15} />
            <div>
              <strong>{syncProgress.followOnly ? "正在切换跟随" : "正在切换形象"}</strong>
              <span>{syncProgress.text}</span>
            </div>
          </div>
          <div className="channel-matrix-sync__meter">
            <span>{syncProgress.indeterminate ? "准备中" : `${syncProgress.percent}%`}</span>
            <div
              className={`channel-matrix-sync__bar${syncProgress.indeterminate ? " is-indeterminate" : ""}`}
              role="progressbar"
              aria-label={syncProgress.followOnly ? "设备跟随切换进度" : "形象素材下发进度"}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={syncProgress.indeterminate ? undefined : syncProgress.percent}
            >
              <span style={{ "--sync-progress": `${syncProgress.percent}%` }} />
            </div>
          </div>
          {!syncProgress.followOnly && <Button
            className="channel-matrix-sync__cancel"
            variant="danger"
            size="small"
            loading={appearanceSync?.cancelling === true}
            loadingLabel="正在中断…"
            onClick={handleCancelAppearanceSync}
            aria-label="中断形象传输"
          >
            <X size={14} />
            中断传输
          </Button>}
        </div>
      )}

      {visibleAgents.length === 0 ? (
        <div className="channel-matrix__empty">暂时无法读取本机 Agent 列表。</div>
      ) : (
        <div className="channel-matrix__rows">
          {visibleAgents.map((agent) => {
            const Icon = AGENT_ICONS[agent.id] || Code;
            const isFollowed = activeAgentId === agent.id;
            const isEnabled = enabledAgents?.has?.(agent.id) === true;
            const isDetected = agent.detected === true;
            return (
              <article
                key={agent.id}
                className={`channel-row${isFollowed ? " is-active" : ""}${isDetected ? "" : " is-undetected"}`}
                aria-current={isFollowed ? "true" : undefined}
              >
                <div className="channel-row__channel">
                  <span className="channel-row__icon"><Icon size={16} /></span>
                  <div className="channel-row__label">
                    <strong>{agent.label}</strong>
                    <span className="channel-row__status" title={agent.detail || undefined}>
                      {isDetected ? "已检测" : "未检测到客户端或 CLI"}
                    </span>
                  </div>
                </div>

                {agent.id === "devin" && (
                  <div className="channel-row__settings">
                    <DevinConfigurationButton disabled={!isDetected} />
                  </div>
                )}

                <div className="channel-row__follow">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={isEnabled}
                    aria-label={isEnabled ? `关闭 ${agent.label}` : `启动 ${agent.label}`}
                    className={`channel-row__toggle${isEnabled ? " is-on" : ""}`}
                    onClick={() => (isEnabled ? handleRemove(agent.id) : handleEnable(agent.id))}
                    disabled={(!isDetected && !isEnabled) || syncing || (isEnabled && queuedAgentCount <= 1)}
                    title={
                      !isDetected && !isEnabled
                        ? "安装对应客户端或 CLI 后重新扫描"
                        : isEnabled
                          ? queuedAgentCount <= 1
                            ? "至少保留一个 Agent，无法关闭"
                            : "关闭 Agent"
                          : "启动 Agent"
                    }
                  >
                    <span className="channel-row__toggle-track" aria-hidden="true">
                      <span className="channel-row__toggle-thumb" />
                    </span>
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {pickerOpen && (
        <AgentAppearancePickerModal
          appearances={appearances}
          selectedAppearanceId={appearance?.id}
          syncing={syncing}
          onClose={closePicker}
          onConfirm={handleConfirmAppearance}
        />
      )}

    </div>
    </Card>
  </>);
}

function AgentAppearancePickerModal({
  appearances,
  selectedAppearanceId,
  syncing,
  onClose,
  onConfirm,
}) {
  const [selectedId, setSelectedId] = useState(selectedAppearanceId || BUILTIN_TERRIER_APPEARANCE_ID);
  const selected = appearanceById(appearances, selectedId);
  const canConfirm = Boolean(selected) && !syncing;

  const dialogRef = useDialogFocus(onClose, syncing);
  return (
    <div className="modal-backdrop" onClick={syncing ? undefined : onClose}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="更换形象" tabIndex={-1}
        className="modal-card modal-card--formosa-picker" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h3 className="modal-title">更换形象</h3>
            <div className="modal-subtitle">
              确认后将形象同步到设备。
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭" disabled={syncing}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <div className="formosa-picker__grid">
            {appearances.map((row) => (
              <button
                type="button"
                key={row.id}
                className={`formosa-picker__option${selectedId === row.id ? " is-selected" : ""}`}
                onClick={() => setSelectedId(row.id)}
                disabled={syncing}
              >
                <div className="formosa-picker__stage" aria-hidden="true">
                <AppearancePreview
                  media={resolveDashboardPreviewMedia(row)}
                  className="formosa-picker__media"
                  emptyClassName="formosa-picker__media formosa-picker__media--empty"
                  playing={false}
                />
                </div>
                <div className="formosa-picker__copy">
                  <strong>{row.name}</strong>
                  <span>{appearanceKindLabel(row)}</span>
                </div>
                {selectedId === row.id && <CheckCircle className="formosa-picker__check" size={16} />}
              </button>
            ))}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" type="button" onClick={onClose} disabled={syncing}>
            取消
          </button>
          <button
            className="btn-primary"
            type="button"
            onClick={() => selected && onConfirm(selected)}
            disabled={!canConfirm}
          >
            {syncing ? <Loader size={14} className="spin" /> : <UploadCloud size={14} />}
            确认
          </button>
        </div>
      </div>
    </div>
  );
}
