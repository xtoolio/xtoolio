// KEEP SYNCING LIVE, off: stop after an hour away, ask on return.
//
// On by default (Account.keepLive unset): xtoolio syncs and X pushes live whether or not you have it open, and you pay
// for everything that arrives. Off (the Inbox's title row, Settings), an account whose person hasn't had xtoolio open
// for AWAY_MS is paused here (THE PAUSE, services/pause.js, why "away"): no sync, no Live subscriptions, nothing
// charged. On return the layout's bar asks: Catch up (everything since you left, priced) or Skip (from now), the
// resume read's own two options; after more than a day, the resume page with its stretches.
//
// "Had xtoolio open" = the latest of Presence.until (an open /live stream, kept ahead by the web processes) and
// Account.seenAt (written by the same streams every few minutes while open: services/livePush.js), so a tab left open
// counts as present, and a phone that slept the app is away once its stream lapses. What no catch-up brings back: likes
// on your posts and follows that arrived while away (X keeps no history of either; the Likes and Follows pages show
// what came while syncing).
//
// In the worker, under its lease (app.js), a look every LOOK_EVERY_MS over the accounts that turned it off.
"use strict";

const Account = require("../models/Account");
const Presence = require("../models/Presence");
const { modulesOn } = require("./features");
const { stopping } = require("../lib/shutdown");

const AWAY_MS = 60 * 60 * 1000;
const LOOK_EVERY_MS = 60 * 1000;

// When this account last had xtoolio open (null: never seen). Pure.
function lastSeen(seenAt, presentUntil) {
  const t = Math.max(seenAt ? new Date(seenAt).getTime() : 0, presentUntil ? new Date(presentUntil).getTime() : 0);
  return t ? new Date(t) : null;
}
// Is it time to stop: Keep syncing live off, running, and away for AWAY_MS. → the moment it left, or null. Pure.
function awaySince(account, presentUntil, now = Date.now()) {
  if (!account || account.keepLive !== false || (account.pause && account.pause.at) || account.needsReauth || !modulesOn(account).length) return null;
  const last = lastSeen(account.seenAt, presentUntil);
  return last && now - last.getTime() >= AWAY_MS ? last : null;
}

async function look(now = Date.now()) {
  const accounts = await Account.find({ keepLive: false, "pause.at": { $exists: false }, needsReauth: { $ne: true } }, "keepLive pause needsReauth features seenAt").lean();
  if (!accounts.length) return 0;
  const until = new Map((await Presence.find({ _id: { $in: accounts.map((a) => a._id) } }, "until").lean()).map((p) => [p._id, p.until]));
  let n = 0;
  for (const a of accounts) {
    const at = awaySince(a, until.get(a._id), now);
    if (!at) continue;
    // Only if still running and still off (a press in between wins); live.due: Live drops its subscriptions.
    const r = await Account.updateOne({ _id: a._id, keepLive: false, "pause.at": { $exists: false } }, { $set: { pause: { at, why: "away" }, "live.due": true } });
    n += r.modifiedCount;
  }
  return n;
}

let timer = null;
function start() {
  const tick = () => {
    if (stopping()) return;
    look()
      .then((n) => n && console.log(`away: paused ${n} account${n === 1 ? "" : "s"} (an hour without xtoolio open)`))
      .catch((e) => console.error(`away: ${e.message}`))
      .finally(() => (timer = setTimeout(tick, LOOK_EVERY_MS)));
  };
  timer = setTimeout(tick, LOOK_EVERY_MS);
}
const stop = () => clearTimeout(timer);

module.exports = { AWAY_MS, lastSeen, awaySince, look, start, stop };
