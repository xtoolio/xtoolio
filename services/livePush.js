// Live, the web side (docs/LIVE.md, hop 2): what changed reaches the pages already open, over SSE (GET /live in web.js,
// public/js/live.js in the page). No page polls: any process notes a change as a LiveEvent row (models/LiveEvent.js),
// and this process holds ONE change stream on those rows and hands each to its account's open tabs (the hub).
// It also keeps whether X's stream is up (LiveState, written by the worker) for the header's "Live".
// Runs in the web process (app.js); the worker never serves pages.
"use strict";

const LiveEvent = require("../models/LiveEvent");
const LiveState = require("../models/LiveState");
const Presence = require("../models/Presence");
const Account = require("../models/Account");
const { LEASE_MS, BEAT_MS } = require("../lib/heartbeat");
const { stopping } = require("../lib/shutdown");

// Who's listening: account id → its open tabs' send functions. A row reaches ONLY its own account's tabs (`publish`);
// `broadcast` is for what's the same for everyone (whether X's stream is up). → { add → remove(), publish, broadcast }
function createHub() {
  const clients = new Map();
  return {
    add(accountId, send) {
      const id = String(accountId);
      if (!clients.has(id)) clients.set(id, new Set());
      clients.get(id).add(send);
      return () => {
        const set = clients.get(id);
        if (!set) return;
        set.delete(send);
        if (!set.size) clients.delete(id);
      };
    },
    publish(row) {
      for (const send of clients.get(String(row.accountId)) || []) send(row);
    },
    accounts() {
      return [...clients.keys()];
    },
    broadcast(row) {
      for (const set of clients.values()) for (const send of set) send(row);
    },
  };
}
const hub = createHub();

// PRESENCE (models/Presence.js): an open /live stream IS someone in the app, so this process keeps `until` ahead for
// every account whose tabs it holds: at once when one joins (opening the app checks right away), then every beat. Every
// web process writes for its own tabs; `$max`, so none pulls another's back. The worker's mentions check reads it.
const PRESENCE_BEAT_MS = 20 * 1000;
const PRESENCE_FOR_MS = 50 * 1000; // two beats and a little: one missed write doesn't drop anyone
// Each write also marks the accounts SEEN (Account.seenAt), only where the last mark is a few minutes old (every page
// load joins, and a busy tab shouldn't write each): the "last active" Admin shows, and what services/away.js measures
// an hour away from once Presence has lapsed and gone.
const SEEN_EVERY_MS = 5 * 60 * 1000;
function markPresent(ids, now = Date.now()) {
  if (!ids.length) return Promise.resolve();
  const until = new Date(now + PRESENCE_FOR_MS);
  const ats = ids.map(String);
  return Promise.all([
    Presence.bulkWrite(ats.map((id) => ({ updateOne: { filter: { _id: id }, update: { $max: { until } }, upsert: true } })), { ordered: false }),
    Account.updateMany({ _id: { $in: ats }, $or: [{ seenAt: { $lt: new Date(now - SEEN_EVERY_MS) } }, { seenAt: { $exists: false } }] }, { $set: { seenAt: new Date(now) } }),
  ]).catch((e) => console.error(`[livePush] presence: ${e.message}`));
}
// A tab's stream joins: its account's news reaches it, and the account is present and seen now. → remove()
function join(accountId, send) {
  const remove = hub.add(accountId, send);
  markPresent([accountId]);
  return remove;
}

// X's stream is up when the worker says it's connected AND its beat is fresh (a worker that died says nothing: its
// beat just stops). Pure.
const healthy = (state, now = Date.now()) => !!(state && state.connectedAt && state.beatAt && now - new Date(state.beatAt).getTime() < LEASE_MS);

let live = false;
let state = null;
const isLive = () => live;
function recheck() {
  const next = healthy(state);
  if (next === live) return;
  live = next;
  hub.broadcast({ type: "status", data: { live } });
}

// A change stream that reopens itself after an error (Atlas failover, a network blip).
function watch(model, pipeline, options, onChange) {
  const open = () => {
    const changes = model.watch(pipeline, options);
    changes.on("change", (c) => Promise.resolve(onChange(c)).catch((e) => console.error(`[livePush] ${e.message}`)));
    changes.on("error", (err) => {
      if (stopping()) return; // the process is on its way out (lib/shutdown.js): its database is closing
      console.error(`[livePush] watching ${model.collection.name}: ${err.message}; reopening in 5 s`);
      changes.close().catch(() => {});
      setTimeout(open, 5000);
    });
  };
  open();
}

function start() {
  watch(LiveEvent, [{ $match: { operationType: "insert" } }], {}, (c) => hub.publish(c.fullDocument));
  watch(LiveState, [], { fullDocument: "updateLookup" }, (c) => {
    if (c.fullDocument) state = c.fullDocument;
    recheck();
  });
  LiveState.findById("stream")
    .lean()
    .then((s) => {
      state = s;
      recheck();
    })
    .catch((e) => console.error(`[livePush] reading the stream's state: ${e.message}`));
  // A beat that stops (a dead worker) changes nothing in the database, so the clock notices it.
  setInterval(recheck, BEAT_MS).unref();
  setInterval(() => (stopping() ? null : markPresent(hub.accounts())), PRESENCE_BEAT_MS).unref();
}

module.exports = { createHub, hub, join, healthy, isLive, start };
