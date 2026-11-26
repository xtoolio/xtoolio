// THE FIRST-READ QUEUE's rules (a launch's sign-ups arrive together, and the worker reads SYNC_SLOTS
// accounts at once; so a fair line, and the progress page saying where you are in it). Pure.
// The worker publishes the queue (services/scheduler.js → models/PullQueue.js); the progress page reads it here.
"use strict";

// How many first reads' durations are kept for the estimate, and how old a published queue may be before the page stops
// trusting it (the worker publishes every few seconds while it runs: an older one means it's down or handing over).
const KEEP_DURATIONS = 20;
const STALE_MS = 60 * 1000;

// The line's order: whoever asked first (the account made, the Inbox turned on, People's history chosen: what made
// its first read due, features.pullDue), so a worker restart rebuilds the same line. `askedAt` → ms. → a comparator.
const byAsked = (askedAt) => (a, b) => askedAt(a) - askedAt(b) || (String(a._id) < String(b._id) ? -1 : 1);

const median = (xs) => {
  if (!xs || !xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// A finished first read's duration onto the kept list (newest last, the last KEEP_DURATIONS).
const keepDuration = (list, ms) => [...(list || []), Math.round(ms)].slice(-KEEP_DURATIONS);

// Where one account stands, from the published queue. → null (not in line: reading already, not queued yet, or the
// queue is stale) | { place (1 = next), ahead, readyMs (until its own read is done; null without durations yet) }.
// The reads go `slots` at a time, each about the median: with a slot free it starts now; otherwise it waits for the
// rounds ahead of it, the first of them already about half done (the running ones are partway), then takes its own.
function standing(queue, accountId, now = Date.now()) {
  if (!queue || !queue.at || now - new Date(queue.at).getTime() > STALE_MS) return null;
  const i = (queue.waiting || []).indexOf(String(accountId));
  if (i === -1) return null;
  const typical = median(queue.durations);
  const slots = Math.max(1, queue.slots || 1);
  const free = Math.max(0, slots - (queue.running || []).length);
  const startMs = typical === null ? null : i < free ? 0 : (Math.floor((i - free) / slots) + 0.5) * typical;
  return { place: i + 1, ahead: i, readyMs: startMs === null ? null : Math.round(startMs + typical) };
}

// THE WORKER'S POOL (services/scheduler.js): `size` runs at once, and two lines for a turn: FIRST READS, first come first
// served, always ahead of the scheduled passes' accounts (each new first read used to be put at the very
// front: in a launch's rush the earliest sign-up waited longest). `skip()`: checked when a turn comes (a restart has
// begun: nothing new starts). → { run(fn, { first, id }), idle(), waiting() (the first reads' ids, in order), resize(n),
// size() }. No I/O.
function createPool(size, { skip = () => false } = {}) {
  let slots = size;
  let free = size;
  const firsts = []; // { id, go }
  const passes = [];
  const take = (first, id) => (free > 0 ? (free--, Promise.resolve()) : new Promise((go) => (first ? firsts : passes).push({ id, go })));
  const give = () => {
    const next = firsts.shift() || passes.shift();
    if (next) next.go();
    else free++;
  };
  return {
    async run(fn, { first = false, id = null } = {}) {
      await take(first, id);
      try {
        if (skip()) return null;
        return await fn();
      } finally {
        give();
      }
    },
    idle: () => free === slots && !firsts.length && !passes.length,
    waiting: () => firsts.map((w) => w.id),
    resize(n) {
      free += n - slots;
      slots = n;
    },
    size: () => slots,
  };
}

module.exports = { KEEP_DURATIONS, STALE_MS, byAsked, median, keepDuration, standing, createPool };
