import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export default function StatusCueSettings({ connected, capabilities }) {
  const [config, setConfig] = useState({ enabled: false, volume: 30 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { invoke("load_status_cues").then(setConfig).catch(e => setError(String(e))); }, []);
  const supported = capabilities?.statusCueConfig === true;
  async function update(next) {
    setBusy(true); setError("");
    try { setConfig(await invoke("set_status_cues", { config: next })); }
    catch (e) {
      setError(String(e));
      // A failed delivery still saves the preference for the next hello.
      invoke("load_status_cues").then(setConfig).catch(() => {});
    } finally { setBusy(false); }
  }
  return <div style={{ padding: 16 }}>
    <label><input type="checkbox" role="switch" checked={config.enabled}
      disabled={!connected || !supported || busy}
      onChange={e => update({ ...config, enabled: e.target.checked })} /> 状态提示音</label>
    {!supported && <span style={{ marginLeft: 12 }}>需要升级设备固件</span>}
    {config.enabled && <label style={{ display: "block", marginTop: 12 }}>音量 {config.volume}
      <input aria-label="状态提示音音量" type="range" min="0" max="100" step="1"
        disabled={!connected || !supported || busy} value={config.volume}
        onChange={e => setConfig({ ...config, volume: Number(e.target.value) })}
        onPointerUp={() => update(config)} onKeyUp={() => update(config)} />
    </label>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
