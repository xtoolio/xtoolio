// THE "NEW SINCE YOU LOOKED" COUNTS: the red number on the Likes and Follows tabs. Each is how many of its rows arrived
// since the account last opened that page, kept on the account (`<tab>Unseen`, `<tab>SeenAt`) so every page's header
// shows it with no lookup, and pushed to its open tabs (LiveEvent "count" { tab, n } → services/livePush.js →
// public/js/live.js) only when it moved. The Inbox tab's count (cards Waiting) is services/inboxCount.js, the same shape.
//
// Recomputed (refreshUnseen) when a row can have arrived: a live like on your post / a live follow or unfollow of you
// (services/live.js ingest). Only live likes count (services/likes.js TIMED), so a sync run never moves it.
// Zeroed by opening the page (seen, web.js).
"use strict";

const Account = require("../models/Account");
const Like = require("../models/Like");
const Repost = require("../models/Repost");
const { NEWS } = require("./likes");
const FollowEvent = require("../models/FollowEvent");
const LiveEvent = require("../models/LiveEvent");

// What each tab counts: the rows (by `seenAt`, when xtoolio stored them) that are the account's news, from each source.
const TABS = {
  likes: [
    // Likes on the account's posts by anyone else (extras.likerOp's rows) that came live and weren't already watched
    // arriving on another page (services/likes.js NEWS): the likers check's finds are a day or more old.
    { model: Like, rows: (accountId) => ({ accountId, authorId: accountId, likerId: { $ne: accountId }, ...NEWS }) },
    // Reposts of the account's posts (extras.reposterOp's rows: Live's, every one as it happened), on the same page.
    { model: Repost, rows: (accountId) => ({ accountId, authorId: accountId, reposterId: { $ne: accountId } }) },
  ],
  // Someone following or unfollowing the account (not the account's own follows).
  follows: [{ model: FollowEvent, rows: (accountId) => ({ accountId, direction: "in" }) }],
};
const fields = (tab) => ({ seenAt: `${tab}SeenAt`, unseen: `${tab}Unseen` });

// `quiet`: save it, but send no "count" event: the caller sends the number inside its own event (a live like on your
// post: services/live.js), so the page can decide once whether it shows.
const save = async (accountId, tab, was, n, { quiet = false } = {}) => {
  if (was === n) return;
  await Account.updateOne({ _id: accountId }, { $set: { [fields(tab).unseen]: n } });
  if (!quiet) await LiveEvent.note(accountId, "count", { tab, n });
};

// Recount one tab for one account; save it and tell its open tabs when it changed (unless `quiet`). → the count, or null
// (no account). An account from before the tab (no SeenAt) counts nothing until it first opens the page.
async function refreshUnseen(accountId, tab, opts = {}) {
  const f = fields(tab);
  const acct = await Account.findById(accountId, `${f.seenAt} ${f.unseen}`).lean();
  if (!acct) return null;
  const since = acct[f.seenAt];
  const counts = since ? await Promise.all(TABS[tab].map((s) => s.model.countDocuments({ ...s.rows(accountId), seenAt: { $gt: since } }))) : [];
  const n = counts.reduce((a, b) => a + b, 0);
  await save(accountId, tab, acct[f.unseen], n, opts);
  return n;
}

// The account opened the page: everything up to now is seen. → when it had last seen them (the page marks what's newer
// as new), or null.
async function seen(accountId, tab) {
  const f = fields(tab);
  const before = await Account.findOneAndUpdate({ _id: accountId }, { $set: { [f.seenAt]: new Date() } }, { projection: `${f.seenAt} ${f.unseen}` }).lean();
  if (!before) return null;
  await save(accountId, tab, before[f.unseen], 0);
  return before[f.seenAt] || null;
}

// For the callers that mustn't fail because of it (a sync, a live event): logged, never thrown.
const refreshUnseenSafely = (accountId, tab, opts) =>
  refreshUnseen(accountId, tab, opts).catch((e) => {
    console.error(`[unseen] counting ${tab} for ${accountId}: ${e.message}`);
    return null;
  });

module.exports = { TABS, refreshUnseen, refreshUnseenSafely, seen };
