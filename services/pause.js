// THE PAUSE, and THE RESUME READ ("how far back?" into what was missed: the first read's own choice and mechanics).
//
// An account stops reading three ways: you pause it (Settings' switch, why "you"), its balance runs out (why
// "balance", recorded by services/balance.js chargeUnit as a charge crosses $0; the gate does the stopping and wakes
// auto-refill), or you're away (why "away": Keep syncing live off and an hour without xtoolio open, services/away.js;
// on return the layout's bar asks Catch up or Skip, the two options below). Account.pause { at, why } says since when. While HELD (held below), nothing reads in the background:
// no sync, no mentions check, no first or resume read, no Live subscriptions; your pages stay readable, and a ♥ or a
// reply you press yourself still goes (spending you chose).
//
// RESUMING after more than a day away (ASK_AFTER_MS) asks how far back to read what was missed, the first read's
// options (history.js DAY_TIERS: 1 day, 1 week, 1 month, sized from the account's pace and priced the same way), up to
// "Everything since you paused" (where reading stopped: the top limit), plus "From now" (nothing). The read is EXACT in
// time: the streams' forward bookmarks (SyncState.own / .mention newestId) are set to the moment chosen as an X id
// (lib/xid.js), so the sync's forward pass reads from now back to exactly then; and your likes reconcile to the same
// moment by the first read's own rule (services/extras.js: newest first, until a stored one or a whole page of likes of
// posts older than it). Until both are done the Inbox shows the progress page (features.firstReadGoing,
// SyncState.resume). Under a day away, it simply catches up, as it always did.
//
// What no choice brings back: follows and unfollows while paused (X keeps no history of them) and likes on your
// posts that Live would have delivered.
"use strict";

const Account = require("../models/Account");
const SyncState = require("../models/SyncState");
const { active } = require("./features");
const { idAt } = require("../lib/xid");
const { DAY_TIERS, firstReadLikes, pullCost, X_POST_LIMIT, X_MENTION_LIMIT, LIKES_PAGE } = require("./history");

const DAY_MS = 24 * 60 * 60 * 1000;
const ASK_AFTER_MS = DAY_MS; // away longer than this: resuming asks how far back

const awayLong = (account, now = Date.now()) => now - new Date(account.pause.at).getTime() >= ASK_AFTER_MS;

// Is this account HELD: no background reading or Live? You paused it; or its balance ran out more than a day ago and
// there's money again, so it waits for "how far back?". At $0 it isn't held here: THE GATE holds it (and its refusals
// wake auto-refill, which this would stop). `outOfBalance`: billing.paused(account), the caller's (this stays pure).
function held(account, outOfBalance) {
  const p = account && account.pause;
  if (!p || !p.at) return false;
  if (p.why !== "balance") return true;
  return !outOfBalance && awayLong(account);
}

// Back after a SHORT stop (money back, or the switch off, within ASK_AFTER_MS): the pause just ends, and the next sync
// catches up from where it stopped, as it always did. Live comes back (live.due).
async function resumeQuietly(accountId) {
  await Account.updateOne({ _id: accountId }, { $unset: { pause: 1 }, $set: { "live.due": true } });
}
// Does ending this pause need the question? (A short one doesn't.)
const asks = (account, now = Date.now()) => !!(account && account.pause && account.pause.at) && awayLong(account, now);

// How long reading has been stopped, in words: "45 minutes", "3 hours", "2 days". Pure.
function awayFor(account, now = Date.now()) {
  const ms = Math.max(0, now - new Date(account.pause.at).getTime());
  const [n, unit] = ms >= DAY_MS ? [Math.round(ms / DAY_MS), "day"] : ms >= 3600e3 ? [Math.round(ms / 3600e3), "hour"] : [Math.max(1, Math.round(ms / 60e3)), "minute"];
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

// Settings' switch: paused by you, since now (an earlier balance pause keeps its start: that's when reading stopped).
async function pauseNow(account) {
  const at = account.pause && account.pause.at ? account.pause.at : new Date();
  await Account.updateOne({ _id: account._id }, { $set: { pause: { at, why: "you" }, "live.due": true } });
}

// "HOW FAR BACK?" ON RESUME: the first read's stretches (DAY_TIERS) that fit inside the time away, then everything since
// the pause, then nothing. Each sized from the pace (`perDay`: posts + replies and mentions a day, services/estimator.js)
// and capped at what X serves (X_POST_LIMIT + X_MENTION_LIMIT: past it the oldest of the gap are simply gone); no pace:
// the most. Priced like the first read (history.pullCost, with your likes over the same stretch, firstReadLikes); the
// caller prices them for the account (routes/pages.js pricedChoices). `days`: how far back each reads (null: to where
// reading stopped). Pure.
function resumeOptions(account, { perDay = null, owned = false, likeCount = null } = {}, now = Date.now()) {
  const away = Math.max(0, (now - new Date(account.pause.at).getTime()) / DAY_MS);
  const all = X_POST_LIMIT + X_MENTION_LIMIT;
  const sized = (d) => (perDay > 0 ? Math.min(all, Math.max(5, Math.round(d * perDay))) : all);
  const n = (v) => v.toLocaleString("en-US");
  const options = [
    { key: "now", days: 0, label: "From now", budget: 0 },
    ...DAY_TIERS.filter((t) => t.days < away).map((t) => ({ key: t.key, days: t.days, label: t.label, budget: sized(t.days) })),
    { key: "since", days: null, label: `Everything since you ${account.pause.why === "away" ? "left" : "paused"} (${awayFor(account, now)})`, budget: sized(away) },
  ];
  // Your likes are reconciled only when they're read (People or Liking: resume's own `yours`). Even From now reads ONE
  // page of them from the top: it's what marks the moment, so the next check stops there instead of reading every like
  // made while away (services/extras.js runLikes), and the quote says so.
  const yours = active(account, "people") || active(account, "liking");
  const onePage = Number.isFinite(likeCount) ? Math.min(likeCount, LIKES_PAGE) : LIKES_PAGE;
  return options.map((o) => {
    // No overrun: a resume's likes read stops at the first like it already has (services/extras.js runLikes).
    const likes = !yours ? 0 : o.budget ? firstReadLikes({ budget: o.budget, likeCount, overrun: 0 }) : onePage;
    const detail = o.budget ? `Up to ${n(o.budget)} posts and mentions${likes ? ` · about ${n(likes)} of your likes` : ""}` : "Skip what you missed";
    return { ...o, likes, detail, estimate: o.budget || likes ? pullCost(o.budget, likes, { owned }) : 0 };
  });
}

// The streams' bookmarks for a resume to `floorId` (an X id; null = everything since the pause: unchanged). A stream
// whose newest post is older than it moves its bookmark up to it (and drops any unfinished pass from before, which was
// older still); a stream never read stays as it is. → { own, mention } updates for $set (only what changes). Pure.
function bookmarksFor(state, floorId) {
  const set = {};
  if (!floorId) return set;
  for (const key of ["own", "mention"]) {
    const s = (state && state[key]) || {};
    if (s.newestId && BigInt(floorId) > BigInt(s.newestId)) {
      set[`${key}.newestId`] = floorId;
      set[`${key}.gapTop`] = undefined;
      set[`${key}.gapUntil`] = undefined;
    }
  }
  return set;
}

// RESUME with `option` (one of resumeOptions'): the bookmarks set to its moment, THE RESUME READ recorded (its budget
// sizes the run, the progress page reads it), the pause ended, and the read started at once (resumedAt: features.pullDue
// puts it at the front, like a first read). Your likes reconcile to the same moment when they're read (People or Liking);
// otherwise there's nothing to reconcile.
async function resume(account, option, now = Date.now()) {
  const floorId = option.days === null ? null : idAt(now - option.days * DAY_MS);
  const state = await SyncState.findById(account._id, "own mention").lean();
  const yours = active(account, "people") || active(account, "liking");
  const set = { ...bookmarksFor(state, floorId), resume: { floorId, budget: option.budget, read: 0, likesRead: 0, likesDone: !yours, at: new Date(now) } };
  const unset = Object.fromEntries(Object.entries(set).filter(([, v]) => v === undefined).map(([k]) => [k, 1]));
  for (const k of Object.keys(unset)) delete set[k];
  await SyncState.updateOne({ _id: account._id }, { $set: set, ...(Object.keys(unset).length && { $unset: unset }) }, { upsert: true });
  await Account.updateOne({ _id: account._id }, { $unset: { pause: 1 }, $set: { resumedAt: new Date(now), "live.due": true } });
}

module.exports = { held, asks, awayFor, pauseNow, resumeQuietly, resumeOptions, bookmarksFor, resume, ASK_AFTER_MS };
