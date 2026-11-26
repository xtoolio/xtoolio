// A lease one process holds at a time, in the database (models/Lease.js), kept alive by THE heartbeat (lib/heartbeat.js:
// a beat every 30 s pushes it LEASE_MS out). `acquire` waits until it's free (released, or lapsed: its holder died
// without letting go), takes it atomically, and returns `release()`. Used by the worker (app.js): during a restart the
// new worker starts beside the old one, and its duties wait here until the old one has stopped its own and released.
"use strict";

const crypto = require("crypto");
const os = require("os");
const Lease = require("../models/Lease");
const { heartbeat, LEASE_MS } = require("./heartbeat");

const POLL_MS = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Whether a holder ("host:pid:tag") is a process on THIS machine that's gone (killed, crashed: `node --watch` on Windows
// kills on every edit, and a crashed worker on the server never lets go): then its lease is free now, not when it lapses.
function deadHere(holder) {
  const [host, pid] = String(holder).split(":");
  if (host !== os.hostname() || !/^\d+$/.test(pid) || Number(pid) === process.pid) return false;
  try {
    process.kill(Number(pid), 0); // signal 0: only asks whether it exists
    return false;
  } catch (e) {
    return e.code === "ESRCH";
  }
}

// One atomic take: free (no doc), lapsed (until past), ours, or its holder is dead on this machine. → whether we hold it.
async function tryTake(name, holder) {
  const until = new Date(Date.now() + LEASE_MS);
  const current = await Lease.findById(name, "holder").lean();
  const orphan = current && deadHere(current.holder) ? [{ holder: current.holder }] : [];
  try {
    const r = await Lease.updateOne({ _id: name, $or: [{ until: { $lt: new Date() } }, { holder }, ...orphan] }, { $set: { holder, until } }, { upsert: true });
    return r.modifiedCount + r.upsertedCount > 0;
  } catch (e) {
    if (e.code === 11000) return false; // someone else holds it: the upsert's insert collided with their doc
    throw e;
  }
}

// → release(): stops the beat and lets go (only if still ours). `onWait()` once, if it isn't free at first.
async function acquire(name, { onWait } = {}) {
  const holder = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString("hex")}`;
  for (let waited = false; !(await tryTake(name, holder)); waited = true) {
    if (!waited && onWait) onWait();
    await sleep(POLL_MS);
  }
  const stop = heartbeat(() => Lease.updateOne({ _id: name, holder }, { $set: { until: new Date(Date.now() + LEASE_MS) } }));
  return async () => {
    stop();
    await Lease.deleteOne({ _id: name, holder });
  };
}

module.exports = { acquire, tryTake };
