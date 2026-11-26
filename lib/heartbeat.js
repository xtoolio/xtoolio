// A lease kept alive while work runs: `beat` every BEAT_MS (it pushes a deadline LEASE_MS out), so a process that
// dies mid-run (a crash, a deploy, `node --watch` restarting on an edit) lets its lease lapse within LEASE_MS instead of
// holding it for the longest a run could take. Used by the sync lock (services/sync.js runningUntil) and every open
// usage unit (services/usage.js beatAt). Before this both waited 30 minutes: a run killed by a restart blocked that
// account's syncing for half an hour and its ledger row said "running" the whole time.
"use strict";

const BEAT_MS = 30 * 1000;
const LEASE_MS = 2 * 60 * 1000; // four missed beats

// Start beating. → stop(). A failed beat is logged, never thrown (the work itself decides whether it failed).
function heartbeat(beat) {
  const timer = setInterval(() => {
    Promise.resolve()
      .then(beat)
      .catch((e) => console.error(`[heartbeat] ${e.message}`));
  }, BEAT_MS);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

module.exports = { BEAT_MS, LEASE_MS, heartbeat };
