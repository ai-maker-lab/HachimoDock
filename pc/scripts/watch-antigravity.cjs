"use strict";

/**
 * Antigravity 实时状态监控预览脚本（无硬件调试专用）
 * 运行：node scripts/watch-antigravity.cjs
 * 可选：ANTIGRAVITY_BRAIN_DIR=<目录> 覆盖默认的 ~/.gemini/antigravity/brain
 */

const AntigravityLogMonitor = require("../src-tauri/bridge/agents/antigravity-log-monitor.js");

console.log("\x1b[1m\x1b[34m====================================================\x1b[0m");
console.log("\x1b[1m\x1b[32m  👀 HachimoDock - Antigravity 状态实时监听服务已启动\x1b[0m");
console.log("\x1b[1m\x1b[34m====================================================\x1b[0m");
console.log("👉 现在可以在终端或 IDE 中对 Antigravity 提问或执行操作。");
console.log("   （当 Antigravity 开始思考、调用工具、完成回复时，状态会实时更新在下方）\n");

const monitor = new AntigravityLogMonitor(
  {
    POLL_INTERVAL_MS: 500, // 调试模式下使用 500ms 快速捕获
  },
  (sessionId, state, event, extra) => {
    const time = new Date().toLocaleTimeString();
    const title = extra?.session?.sessionTitle || extra?.display?.title || sessionId;
    const content = extra?.display?.content || "";
    const tokens = extra?.tokenUsage?.totalTokens || 0;

    // 彩色状态高亮
    let stateTag = `\x1b[36m[${state.toUpperCase()}]\x1b[0m`;
    if (state === "working") stateTag = `\x1b[33m[WORKING - 忙碌/思考]\x1b[0m`;
    if (state === "done")    stateTag = `\x1b[32m[DONE - 任务完成]\x1b[0m`;
    if (state === "attention") stateTag = `\x1b[31m[ERROR - 需注意]\x1b[0m`;

    console.log(`\x1b[90m[${time}]\x1b[0m ${stateTag} 事件: \x1b[35m${event}\x1b[0m`);
    console.log(`  📌 会话标题: ${title}`);
    console.log(`  💬 设备端显示内容: \x1b[1m"${content}"\x1b[0m`);
    if (tokens > 0) {
      console.log(`  📊 Token 统计: 当前轮次总计 ${tokens} tokens`);
    }
    console.log("\x1b[90m----------------------------------------------------\x1b[0m");
  }
);

monitor.start();

// AntigravityLogMonitor.start() 内部对轮询定时器调用了 unref()（避免拖住宿主服务进程）。
// 单独运行时事件循环会立刻清空，脚本刚打印完横幅就退出，所以这里显式挂一个 keep-alive。
const keepAlive = setInterval(() => {}, 60_000);

function shutdown() {
  console.log("\n🛑 停止监听服务。");
  clearInterval(keepAlive);
  monitor.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
