// THE GRACEFUL EXIT (restart the app in flight without missing a webhook). One sequence for every role: pm2 (SIGINT, or its "shutdown" message on Windows), a plain Ctrl-C, or
// `node --watch` restarting on an edit (SIGTERM) all land here once. Each part of the process registers what it must
// do to stop cleanly (`onShutdown`); they run in REGISTRATION order (app.js registers them in the order they must run),
// each awaited, the whole bounded by `deadlineMs` (pm2's kill_timeout is set above it: ecosystem.config.js), then the
// database closes and the process exits 0. What a step does is up to it: the web stops accepting and drains, the
// worker hands over to its successor (app.js).
//
// `stopping()`: a shutdown has begun (the scheduler starts nothing new). `haltX()` / `xHalted()`: the WORKER's reads stop
// at their next request to X (lib/x.js throws a transient error, which every run already turns into a clean stop with
// its progress saved: a sync, the likes passes). The web never halts X: a reply or a bulk press in flight finishes.
"use strict";

const steps = [];
let begun = false;
let halted = false;

const onShutdown = (name, fn) => steps.push({ name, fn });
const stopping = () => begun;
const haltX = () => {
  halted = true;
};
const xHalted = () => halted;

async function shutdown(signal, { deadlineMs = 25000, mongoose = null } = {}) {
  if (begun) return;
  begun = true;
  const t0 = Date.now();
  console.log(`[shutdown] ${signal}: stopping cleanly (up to ${Math.round(deadlineMs / 1000)} s)`);
  const deadline = new Promise((r) => setTimeout(() => r("deadline"), deadlineMs).unref());
  for (const step of steps) {
    const left = deadlineMs - (Date.now() - t0);
    if (left <= 0) break;
    const r = await Promise.race([Promise.resolve().then(step.fn).catch((e) => console.error(`[shutdown] ${step.name}: ${e.message}`)), deadline]);
    if (r === "deadline") {
      console.error(`[shutdown] ${step.name}: out of time, exiting anyway`);
      break;
    }
  }
  if (mongoose) await mongoose.disconnect().catch(() => {});
  console.log(`[shutdown] done in ${Date.now() - t0} ms`);
  process.exit(0);
}

// Wire the signals once. `opts` as shutdown's.
function handleSignals(opts) {
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => shutdown(sig, opts));
  process.on("message", (m) => {
    if (m === "shutdown") shutdown("pm2 shutdown message", opts);
  });
}

module.exports = { onShutdown, stopping, haltX, xHalted, shutdown, handleSignals };
