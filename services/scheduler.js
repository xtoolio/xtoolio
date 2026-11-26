// The sync scheduler, in the worker (or a plain `npm start`; config.schedulerEnabled): one pass on boot, then one
// every SYNC_EVERY_MINUTES (the tick), and every few seconds a look for FIRST PULLS to start. There's no per-account
// interval: checking costs nothing when nothing's new (services/syncPrefs.js).
//
// ONE POOL of SYNC_SLOTS (config.sync.slots) runs at once, shared by passes and first pulls (it was one account after another,
// ~3 s each when nothing's new and up to minutes when there's a lot: 100 accounts filled the 15-minute tick). X's rate
// limits are per user (lib/x.js), so accounts in parallel don't throttle each other; the run lock (services/sync.js)
// keeps any one account to one run. A first pull jumps the queue: a new person is watching its progress page.
//
// A pass waits for all its accounts before the next is scheduled (setTimeout, not setInterval), so passes never
// stack. An account whose lock is held (a "Sync now" press, a first pull) is just skipped this pass; the next pass
// picks up anything missed, because every run reads "newer than what's stored".
//
// First pulls run HERE, never in the web process: one can take 20 minutes, and a launch day's signups all
// at once would have run in the process that serves pages. POST /history only records the choice; this finds it.
"use strict";

const Account = require("../models/Account");
const SyncState = require("../models/SyncState");
const { runSync, summaryLine } = require("./sync");
const { syncSettings } = require("./accounts");
const billing = require("./billing");
const { MODULE_FILTER, pullDue, pullAskedAt } = require("./features");
const pause = require("./pause");
const PullQueue = require("../models/PullQueue");
const LiveEvent = require("../models/LiveEvent");
const { byAsked, keepDuration, createPool } = require("./pullQueue");
const { LEASE_MS } = require("../lib/heartbeat");
const { stopping } = require("../lib/shutdown");

const FIRST_RUN_DELAY_MS = 5000; // let the web process finish booting first
const FIRST_PULL_EVERY_MS = 10 * 1000;
const BUSY_RETRY_MS = 15 * 1000;

// THE POOL (services/pullQueue.js createPool: first reads first come first served, ahead of passes), sized in start()
// (SYNC_SLOTS). A restart that began while one waited its turn: nothing new starts (the next worker's first pass has it).
const pool = createPool(5, { skip: stopping });
const inPool = (fn, opts) => pool.run(fn, opts);
// THE RESTART'S WAIT (app.js): until every run in the pool has ended. The worker halts X first (lib/shutdown.js), so a
// run ends at its next request to X, its progress saved: seconds, not the 20 minutes a first pull can take.
async function drain() {
  while (!pool.idle()) await new Promise((r) => setTimeout(r, 200));
}

// One account's run, logged. → its result (or null when it threw).
async function syncOne(a, why) {
  try {
    const r = await runSync(syncSettings(a._id));
    console.log(summaryLine(r, `@${a.username}${why}`));
    return r;
  } catch (err) {
    console.error(`sync @${a.username} failed: ${err.message}`);
    return null;
  }
}

// One pass: every account that can sync (or just `only`), through the pool. → the accounts whose run was skipped because
// another run held its lock (a Sync now, a mentions check: services/mentionsCheck.js; the callers retry those). `why`
// labels the log line.
async function pass(why = "", only = null) {
  try {
    const accounts = await Account.find({ needsReauth: { $ne: true }, ...MODULE_FILTER, ...(only && { _id: { $in: only } }) }, "username").lean();
    const results = await Promise.all(accounts.map((a) => inPool(() => syncOne(a, why))));
    return accounts.filter((a, i) => results[i] && results[i].skipped === "another sync is running").map((a) => a._id);
  } catch (err) {
    console.error(`sync pass failed: ${err.message}`);
    return [];
  }
}

// First pulls: accounts with a first read due (features.pullDue: a new account's first run, the Inbox just turned on,
// People's history just chosen). Each starts at the front of the pool; one already queued or running isn't queued twice.
// Queued in the order they asked (pullQueue.byAsked: the same line after a worker restart), each timed for the wait's
// estimate, and the line published for the progress page (publishQueue).
const pulling = new Set(); // queued or running
// A deeper read asked and not yet begun by a run (sync.js runPasses sets furtherStage as it begins: one already running
// when it was asked didn't see it). Once begun, the passes carry it on. Pure.
const furtherDue = (state) => !(state && state.furtherStage);
const furtherTried = new Map(); // account → when its deeper read was last started (one try a minute)
const readingNow = new Set();
let durations = null; // the last first reads' durations, loaded from the published queue once
async function startFirstPulls() {
  if (durations === null) durations = ((await PullQueue.findById("first", "durations").lean()) || {}).durations || [];
  const chosen = (await Account.find({ needsReauth: { $ne: true }, ...MODULE_FILTER }, "username features history createdAt resumedAt pause balanceMicros").lean()).filter((a) => !pause.held(a, billing.paused(a))); // THE PAUSE: held, nothing starts
  const states = new Map((await SyncState.find({ _id: { $in: chosen.map((a) => a._id) } }, "lastRunAt furtherStage").lean()).map((s) => [s._id, s]));
  for (const a of chosen.filter((x) => pullDue(x, states.get(x._id))).sort(byAsked(pullAskedAt))) {
    if (pulling.has(a._id)) continue;
    // Out of balance (it ran dry mid-pull): the gate would refuse it every few seconds; a top-up brings it back here.
    if (await billing.outOfRunway(a._id)) continue;
    pulling.add(a._id);
    inPool(async () => {
      readingNow.add(a._id);
      publishQueue();
      const t = Date.now();
      try {
        const r = await syncOne(a, " first pull");
        // Only a read that ran to its end says how long one takes (not one skipped, or stopped by a restart).
        if (r && !r.skipped && !stopping()) durations = keepDuration(durations, Date.now() - t);
      } finally {
        readingNow.delete(a._id);
      }
    }, { first: true, id: a._id }).finally(() => {
      pulling.delete(a._id);
      publishQueue();
    });
  }
  // READ FURTHER BACK (services/further.js), asked and not yet begun: started now, not in the first reads' line (it
  // holds no page and isn't anyone's wait). Once a run has begun it, the regular passes carry it on, as a first read
  // stopped part way.
  for (const a of chosen.filter((x) => x.history && x.history.further && furtherDue(states.get(x._id)))) {
    // At most a try a minute: while another run holds the account's lock, each try is a skip.
    if (pulling.has(a._id) || Date.now() - (furtherTried.get(a._id) || 0) < 60e3 || (await billing.outOfRunway(a._id))) continue;
    furtherTried.set(a._id, Date.now());
    pulling.add(a._id);
    inPool(() => syncOne(a, " reading further back")).finally(() => pulling.delete(a._id));
  }
  await publishQueue();
}

// THE LINE, published (models/PullQueue.js) every time it changes and on every look (every 10 s): what's waiting in
// order, what's reading, the slots, the durations. The progress page reads it by _id (pullQueue.standing). When the line
// itself MOVED, every account in it hears so (LiveEvent "pull"), after it's saved, so the page that redraws reads the
// new one (the page used to reload itself every 4 s instead).
let lastLine = "";
async function publishQueue() {
  const waiting = pool.waiting().map(String);
  const running = [...readingNow].map(String);
  try {
    await PullQueue.updateOne({ _id: "first" }, { $set: { waiting, running, slots: pool.size(), durations: durations || [], at: new Date() } }, { upsert: true });
    const line = `${waiting.join(",")}|${running.join(",")}`;
    if (line === lastLine) return;
    lastLine = line;
    for (const id of new Set([...waiting, ...running])) await LiveEvent.note(id, "pull");
  } catch (e) {
    console.error(`first pulls: publishing the line: ${e.message}`);
  }
}

// `bootPass`: a pass right after boot. Off when Live runs (config.x.bearerToken): the stream's first connect runs the
// catch-up below, which IS the boot pass; both at once just collided on the lock.
function start(config, { bootPass = true } = {}) {
  pool.resize(config.sync.slots);
  begin();
  const every = config.sync.everyMinutes * 60 * 1000;
  const tick = async () => {
    if (stopping()) return;
    const busy = await pass();
    // An account busy with a short run (a mentions check is a second or two, every 30 s while its app is open) gets its
    // pass shortly, not a tick later.
    if (busy.length) setTimeout(() => (stopping() ? null : pass(" (was busy)", busy)), BUSY_RETRY_MS).unref();
    setTimeout(tick, every);
  };
  setTimeout(tick, bootPass ? FIRST_RUN_DELAY_MS : every);
  const firstPulls = () => (stopping() ? null : startFirstPulls().catch((e) => console.error(`first pulls: ${e.message}`)).then(() => setTimeout(firstPulls, FIRST_PULL_EVERY_MS).unref()));
  setTimeout(firstPulls, FIRST_RUN_DELAY_MS).unref();
  console.log(`scheduler: a pass every ${config.sync.everyMinutes} min, ${pool.size()} accounts at a time${bootPass ? "" : " (the first when X's stream connects)"}; first pulls within ${FIRST_PULL_EVERY_MS / 1000} s`);
}

// A catch-up pass now, outside the schedule: X's activity stream just (re)connected, and anything sent while nobody
// was connected is gone from it (pay-per-use can't backfill), so a sync reads it instead of waiting up to a tick
// (services/live.js: a reply sent during a restart showed up only 15 minutes later). If a sync held an
// account's lock (one killed by a restart holds it until its lease lapses), it's tried once more just after the lease.
// A pass that finds nothing new reads nothing billable but each account's own profile, which X bills once a day.
const RETRY_MS = LEASE_MS + 15 * 1000;
// It waits for this worker's turn (start(): after the "worker" lease, app.js): a new worker's stream opens beside the
// old one during a restart, and the catch-up is the new worker's first pass.
let begin;
const started = new Promise((r) => (begin = r));
async function catchUp() {
  await started;
  if (stopping()) return;
  const busy = await pass(" (catch-up)");
  if (busy.length) setTimeout(() => pass(" (catch-up, retried)", busy).catch(() => {}), RETRY_MS).unref();
}

module.exports = { start, catchUp, drain };
