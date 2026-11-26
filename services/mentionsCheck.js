// While you're IN THE APP, new mentions every 30 s (while you're in the app, a reply X
// notifies you of should show here too). X's live stream doesn't push a reply
// further down your thread (services/sync.js checkMentions has X's words and the count), so for the accounts someone has
// open (models/Presence.js, kept by the web processes from their /live streams) the worker reads the mentions feed
// forward every CHECK_EVERY_MS: opening the app checks within a look (unless one ran in the last 30 s), and closing every
// tab stops it (the 15-minute sync is the catch-up then). Its load follows who's using the app right now, not how many
// signed up; each check is ONE request when nothing's new (30 of the 300 per 15 minutes X allows each user for
// mentions), and costs nothing then (X bills what it returns).
//
// In the worker, beside the scheduler (app.js), outside its pool: a check is a second or two, and must not wait behind a
// pass of every account. AT_ONCE bounds them.
"use strict";

const Presence = require("../models/Presence");
const { checkMentions } = require("./sync");
const { syncSettings } = require("./accounts");
const { stopping } = require("../lib/shutdown");

const CHECK_EVERY_MS = 30 * 1000;
const LOOK_EVERY_MS = 5 * 1000;
const AT_ONCE = 10;

// Which present accounts are due: someone's there, and no check started in the last CHECK_EVERY_MS. Pure.
const dueFilter = (now) => ({ until: { $gt: new Date(now) }, $or: [{ checkedAt: null }, { checkedAt: { $lt: new Date(now - CHECK_EVERY_MS) } }] });

const running = new Set();
let timer = null;

async function look() {
  const room = AT_ONCE - running.size;
  if (room <= 0) return;
  const now = Date.now();
  const due = (await Presence.find(dueFilter(now), "_id").sort({ checkedAt: 1 }).limit(AT_ONCE * 2).lean()).filter((p) => !running.has(p._id)).slice(0, room);
  for (const { _id: id } of due) {
    running.add(id);
    // Marked when it STARTS, so a slow check isn't started twice and the next is 30 s after this one began.
    Presence.updateOne({ _id: id }, { $set: { checkedAt: new Date(now) } })
      .then(() => checkMentions(syncSettings(id)))
      .then((r) => {
        if (r && r.added) console.log(`mentions check ${id}: ${r.added} new${r.stop !== "up to date" ? ` (${r.stop})` : ""}`);
      })
      .catch((e) => console.error(`mentions check ${id} failed: ${e.message}`))
      .finally(() => running.delete(id));
  }
}

function start() {
  const tick = () => {
    if (stopping()) return;
    look()
      .catch((e) => console.error(`mentions check: ${e.message}`))
      .finally(() => (timer = setTimeout(tick, LOOK_EVERY_MS)));
  };
  timer = setTimeout(tick, LOOK_EVERY_MS);
  console.log(`mentions check: every ${CHECK_EVERY_MS / 1000} s for accounts with xtoolio open`);
}

// The restart's wait (app.js): nothing new starts, and the checks running end at their next request to X (haltX).
async function stop() {
  clearTimeout(timer);
  while (running.size) await new Promise((r) => setTimeout(r, 200));
}

module.exports = { start, stop };
