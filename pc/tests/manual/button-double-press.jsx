// Isolated browser fixture: synthetic device, no real USB, agent, microphone or credentials.
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import '../../src/styles.css';
import BoardButtonPanel from '../../src/dashboard/BoardButtonPanel.jsx';
import {DEFAULT_BUTTON_ACTIONS, VOICE_CONFIG_STORAGE_KEY, dispatchBoardButtonConfig,
  resolveButtonConfigForRuntime, hasDeferredDoublePress} from '../../src/DeviceDashboard.jsx';

const runtime = 'esp-p4';
const supportsDoublePress = new URLSearchParams(location.search).get('double') === '1';
const capabilities = supportsDoublePress ? {buttonDoublePress: 'p4-button-double-press-v1'} : {};
const calls = [];
window.__TAURI_INTERNALS__ = {invoke: async (command, input) => {
  if (command !== 'button_config_signal') throw Error(`Unexpected fixture IPC: ${command}`);
  calls.push({command, input});
  return {ok: true, bindingCount: input.bindings.length};
}};

function Fixture() {
  const [config, setConfig] = useState(() => resolveButtonConfigForRuntime(
    JSON.parse(localStorage.getItem(VOICE_CONFIG_STORAGE_KEY) || 'null')
      || {buttonModelVersion: 10, enabled: false, buttonActions: DEFAULT_BUTTON_ACTIONS}, runtime).config);
  const [dirty, setDirty] = useState(false);
  const [ota, setOta] = useState({});
  function change(patch) {
    const next = resolveButtonConfigForRuntime({...config, ...patch}, runtime).config;
    localStorage.setItem(VOICE_CONFIG_STORAGE_KEY, JSON.stringify(next));
    setConfig(next); setDirty(true);
  }
  async function apply() {
    const resolved = resolveButtonConfigForRuntime(config, runtime);
    await dispatchBoardButtonConfig({boardDeviceId: 'offline-fixture', runtime, capabilities,
      buttonActions: config.buttonActions, buttonValues: config.buttonValues,
      voiceButton: resolved.voiceButton, voiceEnabled: resolved.voiceEnabled});
    setDirty(false);
    setOta({message: hasDeferredDoublePress(config.buttonActions, runtime, capabilities)
      ? '设备支持的手势已同步；双击仍保存在电脑等待固件。' : '按钮配置已同步。', tone: 'info'});
  }
  window.__buttonAcceptance = {calls, config};
  return <main style={{padding: 24, background: '#f8fafc', minHeight: '100vh'}}>
    <h1>按钮配置验收 · {supportsDoublePress ? '支持双击的固件' : '旧固件'}</h1>
    <BoardButtonPanel selectedAgentId="codex" runtime={runtime} capabilities={capabilities}
      voiceConfig={config} buttonActions={config.buttonActions} buttonValues={config.buttonValues}
      voiceConfigDirty={dirty} voiceConfigOtaState={ota} usbConnected
      onVoiceConfigChange={change} onApplyVoiceConfig={apply}/>
  </main>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
