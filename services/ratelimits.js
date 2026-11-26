// One account's X rate-limit windows, shared across runs, restarts and processes (models/RateWindow.js). lib/x.js
// reads a window before each request and writes it after each response, through the store handed to it on the meter
// (services/usage.js metered attaches windowStore(accountId)). X's limits are per user, so the key is the account,
// not its token (which rotates every two hours).
//
// No per-process cache on purpose: the worker and the web process (a Sync now press) spend the same windows, and a
// cached copy goes stale the moment the other one sends. One indexed read per X request is noise next to the call.
//
// A WRITE's window (a like, a follow, a reply: lib/writeLimits.js) is also kept on the ACCOUNT while the header shows
// it (lib/writeLimits.js `shows`: spent, or a bulk one used at all; Account.writeLimits: window → { left, ends }), so
// the countdown draws with no lookup per page, and every open tab hears it change (LiveEvent "limits",
// public/js/limits.js). Set from each answer that leaves it shown, cleared by the first that doesn't (a fresh window);
// one that simply ends is left in place and ignored (limitsFrom drops ended ones).
"use strict";

const RateWindow = require("../models/RateWindow");
const Account = require("../models/Account");
const LiveEvent = require("../models/LiveEvent");
const { BY_WINDOW, shows, limitsFrom } = require("../lib/writeLimits");

async function keepOnAccount(accountId, endpoint, win) {
  const path = `writeLimits.${endpoint}`;
  // Shown → what's left and when it resets (each press moves it); not shown → cleared, if it was kept.
  const a = shows(BY_WINDOW.get(endpoint), win)
    ? await Account.findOneAndUpdate({ _id: accountId }, { $set: { [path]: { left: win.remaining, ends: new Date(win.reset) } } }, { returnDocument: "after", projection: { writeLimits: 1 } }).lean()
    : await Account.findOneAndUpdate({ _id: accountId, [path]: { $exists: true } }, { $unset: { [path]: "" } }, { returnDocument: "after", projection: { writeLimits: 1 } }).lean();
  if (a) await LiveEvent.note(accountId, "limits", { limits: limitsFrom(a.writeLimits) }); // best-effort: never throws
}

function windowStore(accountId) {
  const key = (endpoint) => `${accountId} ${endpoint}`;
  return {
    async get(endpoint) {
      const doc = await RateWindow.findById(key(endpoint), "remaining reset").lean();
      return doc ? { remaining: doc.remaining, reset: doc.reset.getTime() } : null;
    },
    async set(endpoint, win) {
      await RateWindow.updateOne({ _id: key(endpoint) }, { $set: { remaining: win.remaining, reset: new Date(win.reset) } }, { upsert: true });
      if (BY_WINDOW.has(endpoint)) await keepOnAccount(accountId, endpoint, win).catch((e) => console.error(`[limits] keeping ${endpoint} for ${accountId}: ${e.message}`));
    },
  };
}

module.exports = { windowStore };
