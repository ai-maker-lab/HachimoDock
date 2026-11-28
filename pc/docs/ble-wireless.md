# macOS 蓝牙桌面无线通道（BLE Desktop Link）

当 ESP32-P4 WiFi6 v3 设备处于无法接入认证 Wi-Fi 的办公网络环境时，macOS 客户端可通过低功耗蓝牙（BLE GATT + SMP 加密绑定）建立加密控制与状态同步通道。插上 USB 线后会自动无缝优先切回 USB。

## 通道能力范围

### 支持通过蓝牙（BLE）运行
- **Agent 状态与会话同步**：支持 Codex、Claude、Antigravity（AGY）、OpenClaw 等已配置 Agent 的跟随切换、状态与气泡文案转发。
- **主机时间与定时组件**：连接成功即下发并每 2 秒维持 `system/heartbeat`，附带本机 `clock`（时间戳/时区/毫秒）与 `wasmUv`，保证盼头列车等时间类组件正常校准。
- **抗锯齿气泡字库与文本渲染**：支持 `resources/bubble-font`（`bubble32-v1.fpk`，首次写入 `/spiffs/` 后常驻）与 `ui/text-pixels` 传输，保持清晰字形。
- **设备管理与扩展**：主音量查询/设置（`audio/volume`）、蓝牙键盘快捷键配置（`keyboard/config`）、按键映射配置（`input/config`）、测试消息回执（`ui/test-message`）、组件列表/激活/安装/卸载、以及小体积形象分块同步（需固件声明 `bleAppearanceChunks`）。
- **防后台断连**：macOS 启动时声明 `NSActivityUserInitiatedAllowingIdleSystemSleep` 防止 App Nap 挂起蓝牙回调，并将 `CBCentralManager` 运行在独立串行 GCD 队列；窗口切回前台时即时刷新状态。

### 明确限制为 USB / Wi-Fi 专用
- **语音输入（PTT）与实时语音对话**：受 BLE 带宽与实时性限制，板端在纯蓝牙模式按下语音键将提示「语音需要 USB 连接」，桌面端同步拦截 `audio_bridge` / 语音流。
- **固件 OTA 升级（`firmware/*`）与 Wi-Fi 信任授权（`lan/trust`）**：仅限物理 USB（直连 BLE 处于活跃态时 UI 统一提示「需 USB 升级」，遵循直连通道优先于 Wi-Fi 的既有契约；若需走已信任的 Wi-Fi OTA，请断开蓝牙或接入 USB）。
- **音乐流媒体播放（`media/*`）**：仅限 USB 或 Wi-Fi。
