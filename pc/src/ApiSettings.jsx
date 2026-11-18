/**
 * [Input] Shared avatar provider configs including persisted video parameters, native Volcengine ASR credential commands, and optional return navigation.
 * [Output] Kling API-key and model settings, independent LLM/ASR reads, honest credential-save errors and retained navigation drafts and Wi-Fi 6 Agent pairing; saved ASR changes are broadcast with save vs. test results distinguished.
 * [Pos] top-level page node in pc/src
 * [Sync] If this file changes, update this header and `pc/src/.folder.md`.
 */

import React, { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Eye,
  EyeOff,
  ExternalLink,
  KeyRound,
  Loader2,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import PageShell from "./shell/PageShell.jsx";
import Card from "./shell/Card.jsx";

import LlmNetworkSettings from "./LlmNetworkSettings.jsx";
import GenerationDiagnostics from "./GenerationDiagnostics.jsx";
import TextModelSelect from "./TextModelSelect.jsx";
import KlingVideoSettings from "./KlingVideoSettings.jsx";
import { KLING_KEY_URL } from "./lib/avatar-pipeline/kling-models.js";
import ImageModelSelect from "./ImageModelSelect.jsx";
import { VideoModelSelect } from "./VideoGenerationSettings.jsx";
import { useUsageHelp } from "./shell/DeviceContext.jsx";
import UsageHelp from "./UsageHelp.jsx";
import { useExitProtection } from "./lib/exit-protection.js";
import {
  VIDEO_PROVIDERS,
  loadProviderConfig,
  saveProviderConfig,
} from "./lib/avatar-pipeline/provider-config.js";
import {
  LLM_PRESETS,
  MIMO_CONNECTIONS,
  mimoConnection,
  DEFAULT_LLM_PROVIDER,
  describeLlmPreset,
  selectLlmProvider,
  changeLlmEndpoint,
  emitApiConfigurationUpdated,
  providerCredentialsConfigured,
} from "./lib/api-configuration.js";

function loadVideoConfigs() {
  return Object.fromEntries(
    VIDEO_PROVIDERS.map((provider) => [provider.id, loadProviderConfig(provider.id)]),
  );
}
function persistedProviderConfig(config) {
  return {
    apiKey: config.apiKey || "",
    baseUrl: config.baseUrl || "",
    model: config.model || "",
    thinkingModel: config.thinkingModel || "",
    imageModel: (config.imageModel || "").trim(),
    fastGeneration: config.fastGeneration !== false,
    videoParameters: config.videoParameters || {},
    advanced: config.advanced || {},
  };
}

function resultToneClass(tone) {
  return tone ? ` is-${tone}` : "";
}

export default function ApiSettings({ onBack, configReadError = "", active = true }) {
  const usageHelp = useUsageHelp();
  const [showSecrets, setShowSecrets] = useState(false);
  const [videoConfigs, setVideoConfigs] = useState(loadVideoConfigs);
  const [savedVideoConfigs, setSavedVideoConfigs] = useState(() => videoConfigs);
  const [providerResults, setProviderResults] = useState({});
  const [providerPending, setProviderPending] = useState({});
  const [savedLlm, setSavedLlm] = useState(null);
  const [asrApiKey, setAsrApiKey] = useState("");
  const [asrProvider, setAsrProvider] = useState("volcengine");
  const [speechCustom, setSpeechCustom] = useState({ baseUrl: "", asrModel: "", ttsModel: "", ttsVoice: "" });
  const [asrState, setAsrState] = useState({
    loading: true,
    pending: false,
    configured: false,
    tone: "muted",
    message: "正在读取语音识别配置…",
  });
  // 实时对话：服务预填默认模型并允许修改；豆包 Seed TTS 2.0 复用识别 Key。
  const [voiceChat, setVoiceChat] = useState({
    loading: true,
    llmPending: false,
    llmConfigured: false,
    llmProvider: DEFAULT_LLM_PROVIDER,
    llmBaseUrl: "",
    llmModel: LLM_PRESETS.find(preset => preset.id === DEFAULT_LLM_PROVIDER).model,
    llmWebSearch: true,
    llmSearchMode: "auto",
    llmSearchApiKey: "",
    llmSearchConfigured: false,
    llmApiKey: "",
    llmApiKeyMasked: "",
    llmApiKeyMasks: {},
    llmCustomBaseUrl: "",
    llmTone: "muted",
    llmMessage: "正在读取对话大模型配置…",
  });
  const [devin, setDevin] = useState({
    loading: true,
    pending: false,
    testPending: false,
    token: "",
    hasToken: false,
    orgId: "",
    enabled: false,
    tone: "muted",
    message: "正在读取 Devin 配置…",
  });
  const [savedDevinDraft, setSavedDevinDraft] = useState(null);
  const devinDraft = JSON.stringify([devin.token, devin.orgId, devin.enabled]);
  const mimo = mimoConnection(voiceChat.llmProvider);
  const llmDraft = JSON.stringify([voiceChat.llmProvider, voiceChat.llmBaseUrl, voiceChat.llmModel,
    voiceChat.llmWebSearch, voiceChat.llmApiKey, voiceChat.llmSearchMode, voiceChat.llmSearchApiKey]);
  useEffect(() => { if (!voiceChat.loading && savedLlm === null) setSavedLlm(llmDraft); }, [voiceChat.loading, savedLlm, llmDraft]);
  const dirty = JSON.stringify(videoConfigs) !== JSON.stringify(savedVideoConfigs)
    || !!asrApiKey || (savedLlm !== null && savedLlm !== llmDraft)
    || (savedDevinDraft !== null && savedDevinDraft !== devinDraft);
  const saving = voiceChat.llmPending || asrState.pending || devin.pending || Object.values(providerPending).some(Boolean);
  useExitProtection(saving ? "API 配置正在保存或测试" : dirty ? "API 配置有未保存的修改" : "");

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    invoke("devin_cloud_get_config")
      .then((config) => {
        if (cancelled) return;
        const draft = JSON.stringify(["", config.orgId || "", config.enabled === true]);
        setSavedDevinDraft(draft);
        setDevin((current) => ({
          ...current,
          loading: false,
          hasToken: config.hasToken === true,
          orgId: config.orgId || "",
          enabled: config.enabled === true,
          tone: config.error ? "error" : "muted",
          message: config.error || (config.hasToken ? "已读取加密保存的 Devin 配置。" : "尚未配置 Devin PAT。"),
        }));
      })
      .catch((error) => {
        if (cancelled) return;
        setDevin((current) => ({
          ...current,
          loading: false,
          tone: "error",
          message: `读取 Devin 配置失败：${error}`,
        }));
      });
    return () => { cancelled = true; };
  }, [active]);

  const saveDevin = async () => {
    setDevin((current) => ({ ...current, pending: true, tone: "muted", message: "正在保存 Devin 配置…" }));
    try {
      await invoke("devin_cloud_save_config", {
        token: devin.token.trim() ? devin.token : null,
        orgId: devin.orgId,
        enabled: devin.enabled,
      });
      const hasToken = devin.hasToken || Boolean(devin.token.trim());
      const draft = JSON.stringify(["", devin.orgId, devin.enabled]);
      setSavedDevinDraft(draft);
      setDevin((current) => ({
        ...current,
        pending: false,
        token: "",
        hasToken,
        tone: "success",
        message: "配置已加密保存，云端状态轮询已更新。",
      }));
    } catch (error) {
      setDevin((current) => ({
        ...current,
        pending: false,
        tone: "error",
        message: `保存 Devin 配置失败：${error}`,
      }));
    }
  };

  const testDevin = async () => {
    setDevin((current) => ({ ...current, testPending: true, tone: "muted", message: "正在测试 Devin 连接…" }));
    try {
      const result = await invoke("devin_cloud_test");
      setDevin((current) => ({
        ...current,
        testPending: false,
        tone: result.ok ? "success" : "error",
        message: result.message,
      }));
    } catch (error) {
      setDevin((current) => ({
        ...current,
        testPending: false,
        tone: "error",
        message: `Devin 连接测试失败：${error}`,
      }));
    }
  };

  const applyVoiceChatStatus = (status, patch = {}) => {
    setVoiceChat((current) => ({
      ...current,
      ...patch,
      loading: false,
      llmConfigured: status?.llmConfigured === true,
      llmWebSearch: status?.llmWebSearch !== false,
      llmSearchMode: status?.llmSearchMode || "auto",
      llmSearchConfigured: status?.llmSearchConfigured === true,
      llmProvider: status?.llmProvider || current.llmProvider,
      llmBaseUrl: status?.llmBaseUrl || "",
      llmModel: status?.llmModel || "",
      llmApiKeyMasked: status?.llmApiKeyMasked || "",
      llmApiKeyMasks: status?.llmApiKeyMasks || {},
      llmCustomBaseUrl: status?.llmCustomBaseUrl || "",
    }));
  };

  const saveLlm = async () => {
    setVoiceChat((current) => ({ ...current, llmPending: true, llmTone: "muted", llmMessage: "正在保存对话大模型配置…" }));
    try {
      const custom = voiceChat.llmProvider === "custom";
      const status = await invoke("save_voice_chat_settings", {
        input: {
          llmProvider: voiceChat.llmProvider,
          llmWebSearch: voiceChat.llmWebSearch,
          llmSearchMode: voiceChat.llmSearchMode,
          llmSearchApiKey: voiceChat.llmSearchApiKey.trim() || null,
          llmBaseUrl: custom ? voiceChat.llmBaseUrl : null,
          llmModel: voiceChat.llmModel.trim(),
          llmApiKey: voiceChat.llmApiKey.trim() || null,
        },
      });
      emitApiConfigurationUpdated({ providerId: "voice-chat-llm", configured: status?.llmConfigured === true });
      applyVoiceChatStatus(status, {
        llmPending: false,
        llmApiKey: "",
        llmSearchApiKey: "",
        llmTone: status?.llmConfigured ? "success" : "warning",
        llmMessage: status?.llmConfigured ? "配置已保存，开始聊天时将使用所选模型。" : "已保存，但还没有 API Key",
      });
      setSavedLlm(null);
    } catch (error) {
      setVoiceChat((current) => ({ ...current, llmPending: false, llmTone: "error", llmMessage: `保存失败：${error}` }));
    }
  };

  const clearSearchKey = async () => {
    setVoiceChat(current => ({ ...current, llmPending: true }));
    try {
      await invoke("clear_voice_chat_secret", { which: "search" });
      setVoiceChat(current => ({ ...current, llmPending: false, llmSearchConfigured: false,
        llmSearchApiKey: "", llmTone: "success", llmMessage: "已删除独立搜索 Key。" }));
    } catch (error) {
      setVoiceChat(current => ({ ...current, llmPending: false, llmTone: "error",
        llmMessage: `删除搜索 Key 失败：${error}` }));
    }
  };

  useEffect(() => {
    let cancelled = false;
    invoke("load_voice_chat_settings")
      .then((status) => {
        if (status?.ttsProvider === "openai") {
          setAsrProvider("openai");
          setSpeechCustom((current) => ({
            ...current,
            baseUrl: status?.ttsBaseUrl || current.baseUrl,
            ttsModel: status?.ttsModel || "",
            ttsVoice: status?.ttsVoice || "",
          }));
        }
        if (!cancelled) applyVoiceChatStatus(status, {
          llmTone: status?.llmConfigured ? "success" : "muted",
          llmMessage: status?.llmConfigured ? "对话大模型已配置" : "选一家大模型，填入 API Key 即可",
        });
      })
      .catch((error) => {
        if (!cancelled) setVoiceChat((current) => ({ ...current, loading: false,
          llmTone: "error", llmMessage: `读取对话模型配置失败：${error}` }));
      });
    // Independent services: a failed LLM read must not suppress the ASR read.
    invoke("load_device_asr_settings")
      .then((status) => {
        if (cancelled) return;
        const provider = status?.provider === "openai" ? "openai" : "volcengine";
        setAsrProvider(provider);
        if (provider === "openai") {
          setSpeechCustom((current) => ({
            ...current,
            baseUrl: status?.baseUrl || "",
            asrModel: status?.model || "",
          }));
        }
        setAsrState({
          loading: false,
          pending: false,
          configured: status?.configured === true,
          tone: status?.configured ? "success" : "muted",
          message: status?.message || "尚未配置语音识别服务",
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setAsrState({
          loading: false,
          pending: false,
          configured: false,
          tone: "error",
          message: `读取语音识别配置失败：${error}`,
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const configuredProviderCount = useMemo(
    () => VIDEO_PROVIDERS.filter((provider) =>
      providerCredentialsConfigured(provider.id, savedVideoConfigs[provider.id]),
    ).length,
    [savedVideoConfigs],
  );
  const configuredCount = configuredProviderCount + (asrState.configured ? 1 : 0)
    + (voiceChat.llmConfigured ? 1 : 0);

  const updateProvider = (providerId, patch) => {
    setVideoConfigs((current) => ({
      ...current,
      [providerId]: {
        ...current[providerId],
        ...patch,
      },
    }));
    setProviderResults((current) => ({ ...current, [providerId]: null }));
  };

  const saveProvider = async (providerId) => {
    if (providerPending[providerId]) return;
    const config = videoConfigs[providerId];
    if (!providerCredentialsConfigured(providerId, config)) {
      setProviderResults((current) => ({
        ...current,
        [providerId]: {
          tone: "warning",
          message: "请填写 API Key。",
        },
      }));
      return;
    }
    if (providerId === "custom") {
      try {
        new URL(config.baseUrl);
      } catch {
        setProviderResults((current) => ({
          ...current,
          [providerId]: { tone: "error", message: "请填写完整且有效的 Base URL。" },
        }));
        return;
      }
    }
    setProviderPending(current => ({ ...current, [providerId]: true }));
    try {
      await saveProviderConfig(providerId, persistedProviderConfig(config));
    } catch (error) {
      setProviderResults((current) => ({ ...current,
        [providerId]: { tone: "error", message: error.message || "配置未保存，请重试。" },
      }));
      return;
    } finally {
      setProviderPending(current => ({ ...current, [providerId]: false }));
    }
    const savedConfig = { ...config, needsKlingApiKey: false };
    setVideoConfigs(current => current[providerId] === config ? { ...current, [providerId]: savedConfig } : current);
    setSavedVideoConfigs(current => ({ ...current, [providerId]: savedConfig }));
    setProviderResults((current) => ({
      ...current,
      [providerId]: { tone: "success", message: "已保存到当前客户端。" },
    }));
    emitApiConfigurationUpdated({ providerId });
  };

  const saveAndTestAsr = async () => {
    const isCustom = asrProvider === "openai";
    if (!asrState.configured && !asrApiKey.trim()) {
      setAsrState((current) => ({
        ...current,
        tone: "warning",
        message: isCustom ? "请填写自定义端点的 API Key。" : "请填写火山引擎语音识别 API Key。",
      }));
      return;
    }
    let saved = null;
    setAsrState((current) => ({
      ...current,
      pending: true,
      tone: "muted",
      message: "正在保存并测试语音识别服务…",
    }));
    try {
      saved = await invoke("save_device_asr_settings", {
        input: {
          apiKey: asrApiKey.trim() || null,
          provider: isCustom ? "openai" : "volcengine",
          baseUrl: isCustom ? speechCustom.baseUrl.trim() : null,
          model: isCustom ? speechCustom.asrModel.trim() : null,
        },
      });
      if (isCustom) {
        await invoke("save_voice_chat_settings", {
          input: {
            ttsProvider: "openai",
            ttsBaseUrl: speechCustom.baseUrl.trim(),
            ttsModel: speechCustom.ttsModel.trim() || null,
            ttsVoice: speechCustom.ttsVoice.trim() || null,
          },
        });
      } else {
        await invoke("save_voice_chat_settings", { input: { ttsProvider: "volcengine" } });
      }
      emitApiConfigurationUpdated({
        providerId: "volcengine-asr",
        configured: saved?.configured === true,
      });
      setAsrApiKey("");
      const probe = await invoke("test_device_asr_settings");
      setAsrApiKey("");
      setAsrState({
        loading: false,
        pending: false,
        configured: saved?.configured === true,
        tone: "success",
        message: `Key 已保存，语音识别测试通过（${probe?.latencyMs ?? 0} ms）。可到「人设与声音」试听，检查语音合成是否可用。`,
      });
    } catch (error) {
      setAsrState((current) => ({
        ...current,
        loading: false,
        pending: false,
        configured: saved?.configured === true || current.configured,
        tone: "error",
        message: `${saved ? "共享 Key 已保存，但识别测试失败" : "保存失败"}：${error}`,
      }));
    }
  };

  return (
    <div className="api-settings-page">
    <PageShell
      title="模型配置"
      subtitle="配置语音、对话和形象生成服务"
      actions={(
        <div className="api-settings__page-actions">
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={() => setShowSecrets((current) => !current)}
          >
            {showSecrets ? <EyeOff size={14} /> : <Eye size={14} />}
            {showSecrets ? "隐藏输入" : "显示输入"}
          </button>
          {onBack && (
            <button type="button" className="btn-ghost btn-sm" onClick={onBack}>
              <ArrowLeft size={14} />
              返回
            </button>
          )}
        </div>
      )}
    >
      {dirty && <p role="status" className="api-settings__draft">有未保存的修改。切换页面会保留草稿；关闭客户端前请保存。</p>}
      <section className="api-settings__overview" aria-label="API 配置概览">
        <div className="api-settings__overview-icon" aria-hidden="true">
          <ShieldCheck size={22} />
        </div>
        <div className="api-settings__overview-copy">
          <strong>{configReadError ? "已有配置暂时无法读取（不是配置丢失）" : `${configuredCount} / ${VIDEO_PROVIDERS.length + 2} 项凭据已配置`}</strong>
          <span>按需配置即可：给 Agent 语音输入只需语音识别；和宠物聊天还需语音合成与对话大模型；生成形象需配置形象生成服务。</span>
        </div>
        <div className="api-settings__storage-note">
          <KeyRound size={14} aria-hidden="true" />
          API Key 请勿分享给他人
        </div>
      </section>



      <Card
        title="Devin 云端会话"
        subtitle="加密保存 Devin PAT 与组织 ID；启用后同步最近会话状态到设备气泡，不读取或展示会话回复内容。"
        actions={(
          <span className={`api-settings__status${devin.hasToken ? " is-success" : ""}`}>
            {devin.loading ? <Loader2 size={13} className="spin" /> : <CheckCircle2 size={13} />}
            {devin.loading ? "读取中" : devin.hasToken ? "PAT 已保存" : "未配置"}
          </span>
        )}
      >
        <div className="api-settings__form api-settings__form--devin">
          <label className="ui-field" htmlFor="api-settings-devin-token">
            <span className="ui-field__label">Personal Access Token（PAT）</span>
            <input
              id="api-settings-devin-token"
              className="ui-control api-settings__secret-input"
              type={showSecrets ? "text" : "password"}
              autoComplete="new-password"
              value={devin.token}
              onChange={(event) => setDevin((current) => ({ ...current, token: event.target.value }))}
              placeholder={devin.hasToken ? "已保存 PAT；留空则保留现有密钥" : "粘贴 Devin PAT"}
              disabled={devin.loading || devin.pending}
            />
          </label>
          <label className="ui-field" htmlFor="api-settings-devin-org">
            <span className="ui-field__label">组织 ID</span>
            <input
              id="api-settings-devin-org"
              className="ui-control"
              value={devin.orgId}
              onChange={(event) => setDevin((current) => ({ ...current, orgId: event.target.value }))}
              placeholder="org-..."
              disabled={devin.loading || devin.pending}
            />
          </label>
          <label className="ui-field api-settings__devin-enable">
            <span>
              <input
                type="checkbox"
                checked={devin.enabled}
                onChange={(event) => setDevin((current) => ({ ...current, enabled: event.target.checked }))}
                disabled={devin.loading || devin.pending}
              />
              启用 Devin 云端会话状态同步
            </span>
            <span className="muted small">每 15 秒轮询一次；只同步状态和会话标题，不读取回复文本。</span>
          </label>
          <div className="api-settings__devin-actions">
            <a
              className="api-settings__credential-link"
              href="https://docs.devin.ai/api-reference/personal-access-tokens"
              target="_blank"
              rel="noreferrer"
            >
              PAT 创建说明
              <ExternalLink size={11} aria-hidden="true" />
            </a>
            <div className={`api-settings__result${resultToneClass(devin.tone)}`} role="status">
              {devin.tone === "error" ? <AlertCircle size={13} /> : <CheckCircle2 size={13} />}
              {devin.message}
            </div>
            <button
              type="button"
              className="btn-secondary btn-sm"
              onClick={testDevin}
              disabled={devin.loading || devin.pending || devin.testPending || !devin.hasToken || dirty}
            >
              {devin.testPending ? <Loader2 size={13} className="spin" /> : null}
              测试连接
            </button>
            <button
              type="button"
              className="btn-primary btn-sm"
              onClick={saveDevin}
              disabled={devin.loading || devin.pending || devin.testPending}
            >
              {devin.pending ? <Loader2 size={13} className="spin" /> : null}
              保存
            </button>
          </div>
        </div>
      </Card>

      <Card
        title="语音识别与合成"
        subtitle={(
          <>
            让设备听懂你说的话，并让宠物开口回应。识别与合成共用一个 API Key。
            <a
              className="api-settings__credential-link"
              href="https://docs.volcengine.com/docs/DoubaoVoice/APIKeyUsage?lang=zh"
              target="_blank"
              rel="noreferrer"
            >
              Key 获取方式
              <ExternalLink size={11} aria-hidden="true" />
            </a>
          </>
        )}
        actions={(
          <span className={`api-settings__status${asrState.configured ? " is-success" : ""}`}>
            {asrState.loading ? <Loader2 size={13} className="spin" /> : <CheckCircle2 size={13} />}
            {asrState.loading ? "读取中" : asrState.configured ? "已配置" : "未配置"}
          </span>
        )}
      >
        <div className="usage-help">
          <p><strong>语音输入：</strong>{usageHelp.voice} {usageHelp.confirm}</p>
          <p><strong>实时对话：</strong>{usageHelp.chat} 还需配置下方「对话大模型」。</p>
          {usageHelp.pending && <p className="usage-help__notice">按键配置有修改，请先同步到设备。</p>}
          <details><summary>使用前需要什么</summary><p>请保持设备连接电脑，并让 Pet Manager 持续运行。默认使用豆包 ASR 2.0 和 TTS 2.0，请为该 Key 开通对应服务。</p></details>
        </div>
        <div className="api-settings__presets" role="radiogroup" aria-label="语音服务提供方">
          <button
            type="button"
            role="radio"
            aria-checked={asrProvider === "volcengine"}
            className={"btn-ghost btn-sm api-settings__preset" + (asrProvider === "volcengine" ? " is-active" : "")}
            onClick={() => setAsrProvider("volcengine")}
            disabled={asrState.pending || asrState.loading}
          >
            火山引擎
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={asrProvider === "openai"}
            className={"btn-ghost btn-sm api-settings__preset" + (asrProvider === "openai" ? " is-active" : "")}
            onClick={() => setAsrProvider("openai")}
            disabled={asrState.pending || asrState.loading}
          >
            自定义端点（GPUStack 等）
          </button>
        </div>
        {asrProvider === "openai" && (
          <div className="api-settings__form api-settings__form--speech">
            <label className="ui-field" htmlFor="api-settings-speech-url">
              <span className="ui-field__label">接口地址（OpenAI 兼容，识别与合成共用）</span>
              <input
                id="api-settings-speech-url"
                className="ui-control"
                type="text"
                value={speechCustom.baseUrl}
                onChange={(event) => setSpeechCustom((c) => ({ ...c, baseUrl: event.target.value }))}
                placeholder="https://speech.example.com"
                disabled={asrState.pending || asrState.loading}
              />
            </label>
            <label className="ui-field" htmlFor="api-settings-asr-model">
              <span className="ui-field__label">语音识别模型（ASR）</span>
              <input
                id="api-settings-asr-model"
                className="ui-control"
                type="text"
                value={speechCustom.asrModel}
                onChange={(event) => setSpeechCustom((c) => ({ ...c, asrModel: event.target.value }))}
                placeholder="faster-whisper-large-v3"
                disabled={asrState.pending || asrState.loading}
              />
            </label>
            <label className="ui-field" htmlFor="api-settings-tts-model">
              <span className="ui-field__label">语音合成模型（TTS）</span>
              <input
                id="api-settings-tts-model"
                className="ui-control"
                type="text"
                value={speechCustom.ttsModel}
                onChange={(event) => setSpeechCustom((c) => ({ ...c, ttsModel: event.target.value }))}
                placeholder="cosyvoice-300m-sft"
                disabled={asrState.pending || asrState.loading}
              />
            </label>
            <label className="ui-field" htmlFor="api-settings-tts-voice">
              <span className="ui-field__label">合成音色（voice）</span>
              <input
                id="api-settings-tts-voice"
                className="ui-control"
                type="text"
                value={speechCustom.ttsVoice}
                onChange={(event) => setSpeechCustom((c) => ({ ...c, ttsVoice: event.target.value }))}
                placeholder="Chinese Female"
                disabled={asrState.pending || asrState.loading}
              />
            </label>
          </div>
        )}
        <div className="api-settings__form api-settings__form--speech">
          <label className="ui-field" htmlFor="api-settings-asr-key">
            <span className="ui-field__label">语音 API Key（识别与合成共用）</span>
            <input
              id="api-settings-asr-key"
              className="ui-control api-settings__secret-input"
              type={showSecrets ? "text" : "password"}
              autoComplete="new-password"
              value={asrApiKey}
              onChange={(event) => setAsrApiKey(event.target.value)}
              placeholder={asrState.configured ? "已安全保存；留空可直接复测" : "输入火山引擎豆包语音 API Key"}
              disabled={asrState.pending || asrState.loading}
            />
          </label>
          <button
            type="button"
            className="btn-primary btn-sm api-settings__save"
            onClick={saveAndTestAsr}
            disabled={asrState.pending || asrState.loading}
          >
            {asrState.pending ? <Loader2 size={14} className="spin" /> : <CheckCircle2 size={14} />}
            保存并测试
          </button>
        </div>
        <div className={`api-settings__result${resultToneClass(asrState.tone)}`} role="status">
          {asrState.tone === "error" || asrState.tone === "warning"
            ? <AlertCircle size={13} />
            : <CheckCircle2 size={13} />}
          {asrState.message}
        </div>
      </Card>

      <Card title="对话大模型" subtitle="决定宠物在「实时对话」中如何理解和回答。选择一家服务并填写 API Key 即可。此配置用于和宠物聊天，不影响 ChatGPT、Claude 等 Agent 的语音输入。">
        <UsageHelp />
        <div className="api-settings__presets" role="radiogroup" aria-label="对话大模型">
          {[...LLM_PRESETS, { id: "custom", label: "自定义" }].map((preset) => {
            const selected = preset.id === "mimo" ? Boolean(mimo) : voiceChat.llmProvider === preset.id;
            return <button
              key={preset.id}
              type="button"
              role="radio"
              aria-checked={selected}
              className={"btn-ghost btn-sm api-settings__preset" + (selected ? " is-active" : "")}
              onClick={() => setVoiceChat(current => selected ? current : selectLlmProvider(current, preset.id))}
              disabled={voiceChat.llmPending || voiceChat.loading}
            >
              {preset.label}
            </button>;
          })}
        </div>
        <div className="api-settings__form api-settings__form--llm">
          {mimo && (
            <label className="ui-field" htmlFor="api-settings-mimo-connection">
              <span className="ui-field__label">MiMo 接入方式</span>
              <select id="api-settings-mimo-connection" className="ui-control" value={mimo.id}
                onChange={event => setVoiceChat(current => selectLlmProvider(current, event.target.value))}
                disabled={voiceChat.llmPending || voiceChat.loading}>
                {MIMO_CONNECTIONS.map(connection => <option key={connection.id} value={connection.id}>{connection.label}</option>)}
              </select>
              <span className="muted small">接口地址 {mimo.baseUrl}</span>
            </label>
          )}
          {voiceChat.llmProvider === "custom" ? (
            <>
              <label className="ui-field" htmlFor="api-settings-llm-url">
                <span className="ui-field__label">接口地址（OpenAI 兼容）</span>
                <input
                  id="api-settings-llm-url"
                  className="ui-control"
                  value={voiceChat.llmBaseUrl}
                  onChange={(event) => setVoiceChat((current) => changeLlmEndpoint(current, event.target.value))}
                  placeholder="https://your-endpoint/v1"
                  disabled={voiceChat.llmPending || voiceChat.loading}
                />
              </label>
            </>
          ) : !mimo && (
            <div className="api-settings__preset-summary muted small">
              {describeLlmPreset(voiceChat.llmProvider, voiceChat.llmModel)}
            </div>
          )}
          <label className="ui-field" htmlFor="api-settings-llm-model">
            <span className="ui-field__label">模型名称 / 接入点 ID</span>
            <TextModelSelect value={voiceChat.llmModel}
              onChange={llmModel => setVoiceChat(current => ({ ...current, llmModel }))}
              provider={voiceChat.llmProvider} baseUrl={voiceChat.llmBaseUrl}
              apiKey={voiceChat.llmApiKey} configured={!voiceChat.loading && voiceChat.llmConfigured}
              disabled={voiceChat.llmPending || voiceChat.loading} />
            <span id="api-settings-llm-model-help" className="muted small">可填写账号已开通的模型名称或接入点 ID；留空使用默认模型。</span>
          </label>
          <label className="ui-field" htmlFor="api-settings-llm-key">
            <span className="ui-field__label">API Key</span>
            <input
              id="api-settings-llm-key"
              className="ui-control api-settings__secret-input"
              type={showSecrets ? "text" : "password"}
              autoComplete="new-password"
              value={voiceChat.llmApiKey}
              onChange={(event) => setVoiceChat((current) => ({ ...current, llmApiKey: event.target.value }))}
              placeholder={voiceChat.llmConfigured ? `已保存 ${voiceChat.llmApiKeyMasked}；留空保持不变`
                : mimo ? (mimo.id === "mimo" ? "粘贴 MiMo 按量 API Key" : "粘贴该集群的 Token Plan API Key")
                  : "粘贴这家模型的 API Key"}
              disabled={voiceChat.llmPending || voiceChat.loading}
            />
          </label>
          <button
            type="button"
            className="btn-primary btn-sm api-settings__save"
            onClick={saveLlm}
            disabled={voiceChat.llmPending || voiceChat.loading}
          >
            {voiceChat.llmPending ? <Loader2 size={14} className="spin" /> : <CheckCircle2 size={14} />}
            保存
          </button>
        </div>
        <div className={`api-settings__result${resultToneClass(voiceChat.llmTone)}`} role="status">
          {voiceChat.llmTone === "error" || voiceChat.llmTone === "warning"
            ? <AlertCircle size={13} />
            : <CheckCircle2 size={13} />}
          {voiceChat.llmMessage}
        </div>
        <label className="ui-field api-settings__search-option">
          <span><input type="checkbox" checked={voiceChat.llmWebSearch}
            disabled={voiceChat.llmPending || voiceChat.loading}
            onChange={event => setVoiceChat(current => ({ ...current, llmWebSearch: event.target.checked }))} /> 按需联网检索</span>
          <span className="muted small">明确说「联网搜」可直接检索，闲聊和家居控制通常无需上网。检索可能单独计费。修改后点击保存，下次开始聊天生效。</span>
        </label>
        {voiceChat.llmWebSearch && <>
          <label className="ui-field">
            <span>检索来源</span>
            <select value={voiceChat.llmSearchMode}
              disabled={voiceChat.llmPending || voiceChat.loading}
              onChange={event => setVoiceChat(current => ({ ...current, llmSearchMode: event.target.value }))}>
              <option value="auto">自动 · 当前服务商</option>
              <option value="deepSeek">DeepSeek 搜索</option>
              <option value="autoWithDeepSeek">自动 · DeepSeek 备用</option>
            </select>
          </label>
          {(voiceChat.llmSearchMode !== "auto" || voiceChat.llmSearchConfigured) && <div>
            <label className="ui-field">
              <span>DeepSeek 搜索 API Key</span>
              <input type={showSecrets ? "text" : "password"} autoComplete="off" spellCheck={false}
                value={voiceChat.llmSearchApiKey}
                placeholder={voiceChat.llmSearchConfigured ? "已保存，留空继续使用" : "输入 DeepSeek 官方 API Key"}
                disabled={voiceChat.llmPending || voiceChat.loading}
                onChange={event => setVoiceChat(current => ({ ...current, llmSearchApiKey: event.target.value }))} />
              <span className="muted small">使用其他对话服务商时，请单独填写。对话已接入官方 DeepSeek 时可复用其 Key。启用备用后，当前服务商无法完成检索时会把公开关键词发送给 DeepSeek。</span>
            </label>
            {voiceChat.llmSearchConfigured && <button type="button" className="btn-ghost btn-sm"
              disabled={voiceChat.llmPending || voiceChat.loading}
              onClick={clearSearchKey}>删除独立搜索 Key</button>}
          </div>}
        </>}
        <LlmNetworkSettings />
      </Card>

      <Card title="形象生成" subtitle="新形象默认使用已配置的火山引擎，也可在生成配置中选择可灵 AI">
        <GenerationDiagnostics />
        <div className="api-settings__provider-grid">
          {VIDEO_PROVIDERS.map((provider) => {
            const config = videoConfigs[provider.id];
            const configured = providerCredentialsConfigured(provider.id, savedVideoConfigs[provider.id]);
            const result = providerResults[provider.id];
            const isKling = provider.id === "kling";
            const isCustom = provider.id === "custom";
            return (
              <section className="api-settings__provider" key={provider.id}>
                <header className="api-settings__provider-head">
                  <span className="api-settings__service-mark" aria-hidden="true">
                    <Sparkles size={18} />
                  </span>
                  <span className="api-settings__provider-title">
                    <strong>{provider.label}</strong>
                    <small>
                      {provider.sub}
                      {provider.id === "volcengine" && (
                        <a
                          className="api-settings__credential-link"
                          href="https://ark.volcengine.com/model/detail?name=doubao-seedance-2-0-mini"
                          target="_blank"
                          rel="noreferrer"
                        >
                          Key 获取方式
                          <ExternalLink size={11} aria-hidden="true" />
                        </a>
                      )}
                    </small>
                  </span>
                  <span className={`api-settings__status${configured ? " is-success" : ""}`}>
                    {configReadError ? "读取失败" : configured ? "已配置" : "未配置"}
                  </span>
                </header>

                <fieldset className="api-settings__provider-fields" disabled={Boolean(configReadError)} style={{border:0,padding:0,margin:0,minWidth:0}}>
                  <label className="ui-field" htmlFor={`api-settings-${provider.id}-key`}>
                    <span className="ui-field__label">API Key</span>
                    <input
                      id={`api-settings-${provider.id}-key`}
                      className="ui-control api-settings__secret-input"
                      type={showSecrets ? "text" : "password"}
                      autoComplete="new-password"
                      value={config.apiKey === "hachimidock-bundled-ark-v1" ? "" : config.apiKey}
                      onChange={(event) => updateProvider(provider.id, { apiKey: event.target.value })}
                      placeholder={config.apiKey === "hachimidock-bundled-ark-v1" ? "内置服务已启用，可填写自己的 Key 替换" : `输入${provider.label} API Key`}
                    />
                  </label>
                  {isKling && <>
                    <a className="api-settings__credential-link" href={KLING_KEY_URL} target="_blank" rel="noreferrer">
                      在可灵国内开发者控制台获取 API Key <ExternalLink size={11} aria-hidden="true" />
                    </a>
                    {config.needsKlingApiKey && <span className="muted small">旧版凭据需要换成新版 API Key，保存后生效。</span>}
                    <KlingVideoSettings model={config.model} value={config.videoParameters}
                      onModel={model => updateProvider(provider.id, { model })}
                      onChange={videoParameters => updateProvider(provider.id, { videoParameters })} />
                  </>}
                  {isCustom && (
                    <label className="ui-field" htmlFor="api-settings-custom-url">
                      <span className="ui-field__label">Base URL</span>
                      <input
                        id="api-settings-custom-url"
                        className="ui-control api-settings__secret-input"
                        value={config.baseUrl}
                        onChange={(event) => updateProvider(provider.id, { baseUrl: event.target.value })}
                        placeholder="https://api.example.com"
                      />
                    </label>
                  )}
                  {provider.id === "volcengine" && <div className="ui-field">
                    <span className="ui-field__label">视频生成模型</span>
                    <VideoModelSelect apiKey={config.apiKey} baseUrl={config.baseUrl}
                      model={config.model} onModel={model => updateProvider(provider.id, { model })}
                      autoSelectDefault={false} />
                    <span className="muted small">用于生成形象视频；与下方提示词模型独立。修改后点击保存。</span>
                  </div>}
                  {provider.id === "volcengine" && <div className="ui-field">
                    <span className="ui-field__label">图像理解 / 提示词模型</span>
                    <TextModelSelect vision label="图像理解模型" value={config.thinkingModel}
                      onChange={thinkingModel => updateProvider(provider.id, { thinkingModel })}
                      apiKey={config.apiKey} baseUrl={config.baseUrl} />
                  </div>}
                  {provider.id === "volcengine" && <div className="ui-field">
                    <span className="ui-field__label">图片处理模型</span>
                    <ImageModelSelect value={config.imageModel}
                      onChange={imageModel => updateProvider(provider.id, { imageModel })}
                      apiKey={config.apiKey} baseUrl={config.baseUrl} />
                  </div>}
                </fieldset>

                <footer className="api-settings__provider-foot">
                  <span className={`api-settings__provider-result${resultToneClass(result?.tone)}`}>
                    {result?.message || (configReadError ? "原配置保留，暂不可修改" : configured ? "可用于形象生成" : "等待填写凭据")}
                  </span>
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    onClick={() => saveProvider(provider.id)}
                    disabled={providerPending[provider.id] === true || Boolean(configReadError)}
                  >
                    {providerPending[provider.id] ? "保存中…" : "保存"}
                  </button>
                </footer>
              </section>
            );
          })}
        </div>
      </Card>
    </PageShell>
    </div>
  );
}
