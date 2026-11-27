# Kiro 状态跟随

HachimiDock 通过 Kiro 的命令 Hook 跟随 Kiro 会话状态，在设备上显示思考、执行工具、完成等动画和气泡。目前只支持状态跟随，不支持从设备向 Kiro 发送语音或指令。

## 工作方式

1. 在客户端「Agent 跟随」里点 Kiro 的「跟随」。
2. bridge 重启时调用 `bridge/hooks/kiro-install.js`，写入 `~/.kiro/hooks/hachimodock-status.json`。这个文件归 HachimiDock 所有，其他 Hook 文件不会被改动。
3. Kiro IDE（1.0 及以上）和 Kiro CLI V3 都会加载 `~/.kiro/hooks/` 下的全局 Hook。每次触发时运行 `bridge/hooks/kiro-hook.js`，它把状态 POST 到本机 bridge 的 `/state`，`agent_id` 为 `kiro`。
4. bridge 写出 `kiro.json` 和按会话区分的状态文件，USB 或 Wi-Fi 通道再把它送到设备。

| Kiro 触发器 | 设备状态 | 气泡 |
|---|---|---|
| `SessionStart` | idle | 等待任务 |
| `UserPromptSubmit` | working | 正在思考 |
| `PreToolUse` / `PostToolUse` | working | 正在执行 命令 / 读取文件 / 编辑文件 … |
| `SubagentStop` | working | 子代理已返回，继续处理 |
| `PreCompact` | working | 正在整理上下文 |
| `PostCompact` | working | 正在处理 |
| `Stop` | done | 已完成 |
| `SessionEnd` | sleeping | 会话已结束 |

会话标题优先读取 `~/.kiro/sessions/<hash>/<session_id>/session.json` 的 `title`。这不是 Kiro 公开的接口，读取失败时退回为「Kiro · 工作区文件夹名」。

## 安全约束

- Hook 不向 stdout 输出任何内容，命令末尾带 `>/dev/null 2>&1 || true`，始终以 0 退出。Kiro 会把 stdout 加进 Agent 上下文，而 `Stop` 非零退出可能让 Kiro 再跑一轮，所以这两点都必须避免。
- 不注册 `PermissionRequest`。它的命令 Hook 决策语义没有公开文档，状态 Hook 不能影响工具审批。
- 不上传 prompt 和工具输入输出，只发送状态、工具名、会话 ID、工作区路径和会话标题。

## 已知限制

- Kiro CLI 2.x 不读取 `~/.kiro/hooks/`，需要升级到 CLI V3。
- 取消跟随不会删除 Hook 文件，之后上报会被 bridge 丢弃。需要彻底移除时运行：

```sh
"<HachimiDock.app>/Contents/Resources/bridge/runtime/node" \
  "<HachimiDock.app>/Contents/Resources/bridge/hooks/kiro-install.js" --uninstall
```

或直接删除 `~/.kiro/hooks/hachimodock-status.json`。
- 带 Agent 名称的连接横幅（R313 固件）没有 Kiro 的显示名，会显示小写 `kiro`；在固件连接横幅的显示名表加入 `{"kiro","Kiro"}` 即可显示为 `Kiro`。
