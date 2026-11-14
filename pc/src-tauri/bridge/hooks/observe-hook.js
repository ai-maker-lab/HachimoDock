"use strict";
const { postStateToRunningServer } = require("./server-config");
function observeHook(stateForHook) {
  let bytes = 0, chunks = [], finished = false;
  const finish = (payload) => {
    if (finished) return;
    finished = true;
    const body = payload && stateForHook(payload);
    const done = () => { process.stdout.write("{}\n"); process.exit(0); };
    if (body) postStateToRunningServer(JSON.stringify(body), { timeoutMs: 100 }, done);
    else done();
  };
  // Observational hooks: never approve, deny, or wait for a permission choice.
  setTimeout(() => finish(null), 800);
  process.stdin.on("data", chunk => {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) { finish(null); return; }
    chunks.push(chunk);
  });
  process.stdin.on("error", () => finish(null));
  process.stdin.on("end", () => {
    try { finish(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
    catch { finish(null); }
  });
}
module.exports = { observeHook };
