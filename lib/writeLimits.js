// X's limits on the WRITES xtoolio sends for you, per user (docs.x.com rate-limits): THE one table.
// The bulk presses size themselves by it (services/extras.js writesLeft), the rate-limit store marks a spent window on
// the account by it (services/ratelimits.js), and the header's countdown names it (partials/limits.hbs:
// when a write is rate limited, the header beside the balance says when the next one opens up). Pure.
//   window   — the rate-limit window's key, as lib/x.js stores it (windowKey: a write keyed with its method)
//   perWindow, perDay — X's numbers; perDay null: none kept here (X states none we've read for it)
//   ledger   — what counts against the day: the units of `kind`, each counting the writes recorded in it (`line`, its
//              UsageEntry.lines key, meter.recordAction's what:class): one per press, or many in one bulk press's unit
//              (a bulk like is ONE ledger row, so counting rows would count 44 likes as 1)
//   words    — what the countdown calls it ("Likes 4/50 · resets in 12:34")
//   bulk     — a bulk press sizes itself by this window (the Inbox's ♥ Like N, a thread's Follow N, the bulk unfollow),
//              so the header shows it as soon as any of it is used, not only once it's spent (with the bulk
//              ♥ saying "Like 4", the header says when a full window opens again); the others (one reply, one unlike)
//              show only when spent
"use strict";

const { windowKey, reserveFor } = require("./x");

// What lib/x.js keeps back in a write's window (none: a write you press is the request itself).
const RESERVE = reserveFor("POST");

const WRITE_LIMITS = {
  like: { perWindow: 50, perDay: 1000, window: windowKey("POST", "/users/0/likes"), ledger: { kind: "like", line: "liked:like" }, words: "Likes", bulk: true },
  unlike: { perWindow: 50, perDay: null, window: windowKey("DELETE", "/users/0/likes/0"), words: "Unlikes" },
  follow: { perWindow: 50, perDay: 400, window: windowKey("POST", "/users/0/following"), ledger: { kind: "follow", line: "followed:follow" }, words: "Follows", bulk: true },
  unfollow: { perWindow: 50, perDay: null, window: windowKey("DELETE", "/users/0/following/0"), words: "Unfollows", bulk: true },
  reply: { perWindow: 100, perDay: null, window: windowKey("POST", "/tweets"), words: "Replies" },
  // The ↻. 50 / 15 min each way is INFERRED (a like's; X's repost limit not read yet): only the
  // countdown's "/50" uses it, and the window itself is X's own count from each answer's headers.
  repost: { perWindow: 50, perDay: null, window: windowKey("POST", "/users/0/retweets"), words: "Reposts" },
  unrepost: { perWindow: 50, perDay: null, window: windowKey("DELETE", "/users/0/retweets/0"), words: "Undone reposts" },
};
const BY_WINDOW = new Map(Object.entries(WRITE_LIMITS).map(([key, lim]) => [lim.window, { key, ...lim }]));

// Whether the header shows this window, from X's own count (`win` as lib/x.js stores it: remaining, reset): not reset
// yet, and either spent (down to the reserve lib/x.js keeps: it refuses to send past it) or, for a bulk one, used at all.
function shows(lim, win, now = Date.now()) {
  if (!lim || !win || !(win.reset > now)) return false;
  return win.remaining <= RESERVE || (!!lim.bulk && win.remaining < lim.perWindow);
}

// The countdown's list from what the account keeps (Account.writeLimits: window → { left, ends }; a Map, or a plain
// object from .lean()), the ended ones left out. → [{ key, words, left, max, ends (ms) }], soonest first. A value
// without `ends` (the bare Date an older version kept) is ignored; X's next answer for that window replaces it.
function limitsFrom(kept, now = Date.now()) {
  const entries = kept instanceof Map ? [...kept.entries()] : Object.entries(kept || {});
  return entries
    .map(([window, v]) => ({ lim: BY_WINDOW.get(window), left: v && v.left, ends: v && v.ends ? new Date(v.ends).getTime() : NaN }))
    .filter((e) => e.lim && e.ends > now && Number.isFinite(e.left))
    .map((e) => ({ key: e.lim.key, words: e.lim.words, left: Math.max(0, e.left - RESERVE), max: e.lim.perWindow, ends: e.ends }))
    .sort((a, b) => a.ends - b.ends);
}

// How long until `ends`, as the countdown shows it: "12:34", "1:02:03"; "0:00" once it's passed. THE format (the
// header's first paint here; public/js/limits.js ticks it the same way).
function countdown(ends, now = Date.now()) {
  const s = Math.max(0, Math.ceil((ends - now) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

module.exports = { WRITE_LIMITS, BY_WINDOW, RESERVE, shows, limitsFrom, countdown };
