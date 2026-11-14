import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Button from "../shell/Button.jsx";

export default function BoardScreenshot({ boardDeviceId }) {
  const [busy, setBusy] = useState(false);
  const [image, setImage] = useState("");
  const [error, setError] = useState("");
  async function capture() {
    setBusy(true);
    setError("");
    try {
      const frame = await invoke("capture_board_screen", { expectedBoardDeviceId: boardDeviceId });
      setImage(`data:image/png;base64,${frame.png}`);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }
  return <div>
    <Button onClick={capture} loading={busy} disabled={busy} loadingLabel="正在截图…">截取板子画面</Button>
    {error && <p role="alert">{error}</p>}
    {image && <figure><img src={image} width="320" height="240" alt="刚刚截取的板子画面" /></figure>}
  </div>;
}
