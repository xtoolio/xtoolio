// THE FOLLOW RECONCILER's reads, in the WORKER (services/following.js has the why). The press (POST
// /follows/back/read) only records what's wanted (SyncState.following.want); this looks every few seconds for one and
// reads it, page by page (following.readPages), each attempt its own metered unit under what's left of the quote.
// When it stops:
//   the list's end              → complete: pairs not re-read are unfollowed (following.closeWalk); nothing more to read
//   the tier's cap, the ceiling → partial: X's marker kept, so the page offers THE REST
//   X down, a restart, X's limit → tried again (after a minute, X's reset, or at once for the next worker), up to
//                                  MAX_TRIES; every page before it is kept and paid for once
//   X refuses the marker        → the walk starts again from the top, once (UNVERIFIED how long X keeps a marker)
//   the gate, a stale sign-in, anything else → partial, with its notice
// The open page hears each page (LiveEvent "following" { text }) and the end ({ done, n }: public/js/live.js reloads it
// with that toast).
//
// Beside the scheduler (app.js), outside its pool, like the mentions check: a press is a person waiting on the page,
// and must not queue behind a pass of every account. AT_ONCE bounds them.
"use strict";

const Account = require("../models/Account");
const SyncState = require("../models/SyncState");
const LiveEvent = require("../models/LiveEvent");
const following = require("./following");
const { syncSettings } = require("./accounts");
const { metered } = require("./usage");
const { active } = require("./features");
const { createClient } = require("../lib/x");
const { failureNotice } = require("../lib/notices");
const { stopping } = require("../lib/shutdown");

const LOOK_EVERY_MS = 5 * 1000;
const AT_ONCE = 5;
const MAX_TRIES = 5;
const RETRY_MS = 60 * 1000;

const running = new Set();
let timer = null;

// The read is over: the walk's state, the want gone, the page told. `complete`: the list's end was reached.
async function finish(id, { complete, n }) {
  const now = new Date();
  const st = ((await SyncState.findById(id, "following").lean()) || {}).following || {};
  if (complete) await following.closeWalk(id, st.walkAt, now);
  // A read that got nothing (refused before its first page) leaves the last finished one as it was.
  const read = complete || (st.want && st.want.readNow > 0);
  const update = { $unset: { "following.want": "", ...(complete && { "following.next": "" }) } };
  if (read) update.$set = { "following.listedAt": now, "following.complete": !!complete };
  await SyncState.updateOne({ _id: id }, update);
  await LiveEvent.note(id, "following", { done: true, n });
}

// One attempt at an account's wanted read.
async function runOne(id) {
  const account = await Account.findById(id, "username features tokens.scope needsReauth").lean();
  const st = ((await SyncState.findById(id, "following").lean()) || {}).following || {};
  const want = st.want;
  if (!want) return;
  // The module turned off (or its permission lost) since the press: nothing to read for.
  if (!account || !active(account, "follows")) return finish(id, { complete: false, n: null });
  const s = syncSettings(id);
  let result = null;
  let err = null;
  let spent = 0;
  try {
    const token = await s.getToken();
    await metered({ accountId: id, kind: "follows", label: "Who you follow", billing: s.billing, ceilingUsd: Math.max(0, want.ceilingUsd - (want.spentUsd || 0)) }, async (meter) => {
      try {
        const x = createClient({ token, meter, ownerId: s.ownerId, readCap: 0, userCap: Math.max(0, want.cap - (want.readNow || 0)) });
        result = await following.readPages({ accountId: id, x, want, walk: st });
      } finally {
        spent = meter.spentUsd || 0;
      }
    });
  } catch (e) {
    err = e;
  }
  if (spent) await SyncState.updateOne({ _id: id }, { $inc: { "following.want.spentUsd": spent } });
  if (result) {
    if (!result.complete) console.log(`[following] @${account.username}: read ${result.readNow} of ${want.budget}, stopped (the tier or the quote)`);
    return finish(id, { complete: result.complete, n: "following-read" });
  }
  // X refused the marker (a 400 on a read that had one): start the walk again from the top, once.
  if (err.status === 400 && st.next && !want.restarted) {
    console.error(`[following] @${account.username}: X refused the page marker (${err.message}); reading from the top`);
    await SyncState.updateOne({ _id: id }, { $set: { "following.walkAt": new Date(), "following.read": 0, "following.want.restarted": true }, $unset: { "following.next": "", "following.want.retryAt": "" } });
    return;
  }
  // X down, a restart, X's limit: again later, from where it stopped.
  const later = err.transient || err.status === 429;
  if (later && (want.tries || 0) + 1 < MAX_TRIES) {
    const at = stopping() ? new Date() : err.status === 429 && err.rateLimitReset ? err.rateLimitReset : new Date(Date.now() + RETRY_MS);
    console.error(`[following] @${account.username}: stopped (${err.message}); again at ${at.toISOString()}`);
    await SyncState.updateOne({ _id: id }, { $set: { "following.want.retryAt": at }, $inc: { "following.want.tries": 1 } });
    return;
  }
  return finish(id, { complete: false, n: failureNotice(err, `[following] reading the list for @${account.username}`) });
}

async function look() {
  const room = AT_ONCE - running.size;
  if (room <= 0) return;
  const now = new Date();
  const due = await SyncState.find({ "following.want": { $exists: true }, $or: [{ "following.want.retryAt": null }, { "following.want.retryAt": { $lte: now } }] }, "_id")
    .sort({ "following.want.at": 1 })
    .limit(AT_ONCE * 2)
    .lean();
  for (const { _id: id } of due.filter((d) => !running.has(d._id)).slice(0, room)) {
    running.add(id);
    runOne(id)
      .catch((e) => console.error(`[following] ${id} failed: ${e.message}`))
      .finally(() => running.delete(id));
  }
}

function start() {
  const tick = () => {
    if (stopping()) return;
    look()
      .catch((e) => console.error(`[following] look: ${e.message}`))
      .finally(() => (timer = setTimeout(tick, LOOK_EVERY_MS)));
  };
  timer = setTimeout(tick, LOOK_EVERY_MS);
}

// The restart's wait (app.js): nothing new starts, and a read running ends at its next request to X (haltX), its pages
// kept and its want left for the next worker.
async function stop() {
  clearTimeout(timer);
  while (running.size) await new Promise((r) => setTimeout(r, 200));
}

module.exports = { start, stop, runOne };
