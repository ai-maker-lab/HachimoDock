# 多 Agent 会话队列（B 模型，Session 驱动）

> 状态：实现中
> 日期：2026-11-23
> 范围：PC 客户端、Bridge、React、固件协议、测试与文档
> 审批：本阶段不做，保持现有单条串行行为

## 1. 本期唯一需求

多个 Agent 的会话合并到设备上的同一个队列：

- 顶层 `session/current.agentId` = 当前选中 Session 的 Agent，只决定 `state/<source>` 与 `speech` 路由；没有独立的 Agent 焦点；
- 每个 `sessions[]` 项携带自己的 `agentId`，表示卡片归属；
- 设备按 `(agentId, id)` 去重、保持顺序、缓存和完成音；
- 旧 PC 不带 per-item `agentId` 时，保持原有“跨 Agent 清空”行为。

除以上直接相关的改动，其余不做。

## 2. 协议

`session/current` 继续使用现有字段，不新增能力位或版本字段：

```json
{
  "agentId": "claude-code",
  "sessionId": "019abc",
  "index": 2,
  "count": 5,
  "sessions": [
    {
      "id": "019abc",
      "agentId": "claude-code",
      "title": "修复登录",
      "content": "正在运行测试",
      "state": "working",
      "transitionRevision": 42,
      "terminalRemainingMs": 0
    }
  ],
  "activeSessionIds": ["019abc"],
  "displayEnabled": true
}
```

约定：

- 顶层 `agentId` 是当前选中 Session 的 Agent；选中项变化时它会变化。
- `sessions[].agentId` 必填，是每张卡的真实 Agent；`id` 是真实会话 ID，不拼前缀。
- 设备选择事件回传 `sessionId`、`agentId`、`sessionIndex`、`sessionCount`。
- `activeSessionIds` 仍然只按 id 保留；跨 Agent 同 id 时的保留歧义是已知限制（见 §7）。
- 固件 `session_ids_match()` 保持原来的冒号截断比较，不在本期修改。

## 3. PC 聚合

- 每个启用 Agent 的会话行为 `(agentId, id)`；`tagSessionForAgent` 只补 `agentId`，不改 `id`。
- 合并、排序、8 条截断在 PC 完成；选中项必须保留。
- 只维护一个选中 Session；它的 `agentId` 决定：
  - 哪份会话作为设备的 `index`/`sessionId`；
  - 哪一路 `state/<source>` / `speech` 被转发。
- Agent 列表只决定哪些 Agent 的会话进入合并列表；加入/移出不会单独制造 Agent 焦点。
- 设备回传的选中项优先用 `payload.agentId` 定位；旧固件没有该字段时用“上次下发队列 + `sessionIndex`”兜底。

## 4. 固件

`handle_session_current()`：

- 逐项读取 `agentId`；缺失时回退到顶层 `agentId`（旧 PC）。
- 队列 staging、去重、排序保留、卡片缓存、完成音都按 `(agentId, id)`。
- 顶层 `agentId` 变化时：
  - 快照含 per-item `agentId`（新 PC）：不清空队列，按 `(agentId, id)` 对账；
  - 快照不含 per-item `agentId`（旧 PC）：保持原来的跨 Agent 清空。
- 选中项变化时同步 `current_session_id` 与 `current_session_agent`，供语音/状态使用。

## 5. 改动清单

| 范围 | 文件 |
|---|---|
| PC 身份/聚合 | `pc/src/lib/session-display.js`、`pc/src/lib/agent-focus.js`、`pc/src/dashboard/useMultiAgentSessionFeed.js` |
| PC 下发/选择 | `pc/src/dashboard/useP4SessionSync.js`、`pc/src/DeviceDashboard.jsx` |
| Rust 校验收发 | `pc/src-tauri/src/lib.rs`（`P4SessionQueueInput.agent_id`、`build_p4_device_sessions`） |
| Rust 作用域 | `pc/src-tauri/src/usb_serial.rs`（把当前选中 Session 的 Agent 写入 follow scope，去掉合成 scope） |
| 固件 | `firmware/main/pet_p4_protocol.{h,c}`、`pet_p4_input.c`、`pet_p4_renderer.c`、`pet_p4_audio.c` |
| 测试 | `pc/src-tauri/src/lib.rs` wire 级用例；`firmware/tests/*`；PC 单元测试 |
| 文档 | 本文件、`firmware/protocol.md`、`pc/README.md` |

## 6. 兼容

| 组合 | 行为 |
|---|---|
| 新 PC + 新固件 | 完整 B 模型：合并队列、每卡 Agent、选择回传 Agent |
| 新 PC + 旧固件 | 旧固件忽略 `sessions[].agentId`；仍显示合并卡片，但卡片归属/完成音按顶层选中 Session 的 Agent；PC 用 `sessionIndex` 兜底选择 |
| 旧 PC + 新固件 | 无 per-item `agentId`，固件回退到顶层 Agent，并保持原来的跨 Agent 清空 |

## 7. 已知限制

- `activeSessionIds` 只有 id：两个 Agent 使用同一原始 id 时，活动保留可能串到另一张卡；本期接受，后续再改协议。
- Wi-Fi（LAN）仍只发送当前选中 Session 的 Agent 的会话；多 Agent 合并目前以 USB 为准。
- 卡片没有 Agent 徽标；设备端仍只有一个选中项。

## 8. 验收

- 选中项变化时 `sessions[].agentId` 非空，固件不走 `legacy_agent_changed`。
- 两个 Agent 同 id 不合并；切选中项不重复卡片、顺序稳定、完成音不重放。
- 旧 PC 不带 per-item `agentId` 时仍走原清空行为。
- 单 Agent、DSH、antigravity、录音行为与改动前一致。

## 9. UI 决策（已确认）

- 形象不随选中项切换；渠道只展示当前选中 Session 的 Agent，不再手动切 Agent，也不自动同步形象。
- “当前形象”按设备最后一次确认的形象归属展示，和选中 Session 的 Agent 分开；USB 下无法读取设备确认信息时，沿用最后一次成功同步的归属。
- Agent 矩阵只负责“加入队列 / 移出队列”；选中项由合并 Session 列表决定，没有独立的 Agent 焦点。
- 移出 Agent 只删除来源；如果当前选中 Session 属于它，自动落到剩余列表的最新 Session；最后一个不允许移出。移出后的旧卡片会立即从设备队列过滤掉。
- 每个 Agent 的完整快照只对该 Agent 权威：缺失的活跃会话走原有 15 秒 grace，不会被无限保留。
- 已删除无使用方的 `ChannelSwitchConfirmModal`、旧的“跟随确认”弹窗/路径，以及相关的 `followAgent` 编排。
