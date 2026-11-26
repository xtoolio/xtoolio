// THE BALANCE CLOCK: X's real credit balance, read once a minute by the worker (app.js, where the scheduler runs:
// exactly one reader), stored as a BalanceReading when it moved (services/usage.js takeReading). The day's real
// spend is the sum of drops between readings (each reading's move, usage.moveOf): exact however many units ran meanwhile.
// The owner's header and Usage page show it beside the units' price-list amounts; billing charges at X's prices and
// doesn't read it (no calibration, services/balance.js).
// It replaced a reading before and after every unit: two calls to X per unit through the owner's token.
"use strict";

const { readOwnerBalance } = require("./accounts");
const { takeReading } = require("./usage");

const EVERY_MS = 60 * 1000;

let timer = null;
let reading = null; // the tick in flight
let stopped = false;
function start() {
  if (timer) return;
  const tick = async () => {
    if (stopped) return;
    reading = takeReading(readOwnerBalance).catch((e) => console.error(`[balance clock] reading failed: ${e.message}`));
    await reading;
    reading = null;
    if (stopped) return;
    timer = setTimeout(tick, EVERY_MS);
    timer.unref();
  };
  tick();
  console.log(`balance clock: X's balance every ${EVERY_MS / 1000} s`);
}
// A restart (app.js): no reading after this, and the one in flight finishes first. Two clocks reading at once (the old
// worker and its successor) could each store the same move (BalanceReading.d): the real spend counted twice.
async function stop() {
  stopped = true;
  if (timer) clearTimeout(timer);
  if (reading) await reading;
}

module.exports = { start, stop, EVERY_MS };
