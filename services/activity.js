// services/activity.js — ADMIN → ACTIVITY: what each account has DONE in xtoolio over a window, so who's using it, and
// how, is one table (routes/admin.js; Admin → P&L is the money). Per account:
//   replies, likes, follows,
//   unfollows               — the writes sent to X from xtoolio, counted from THE LEDGER (each press's or bulk press's
//                             unit records every write it made: UsageEntry.lines "<what>:<class>", lib/x.js), so a bulk
//                             like of 12 is 12
//   done                    — conversations marked done (InboxMark.at moves with every Done press on that card)
//   last                    — when it was last active: the latest of having xtoolio open (Account.seenAt), a write, a Done
//   synced                  — the posts synced for it, ALL TIME (not the window): its own posts and its mentions, every
//                             post it's a member of (Post.accounts); the threads' context posts are shared, nobody's
// Every account that has one (not only those active in the window), the most recently active first.
"use strict";

const Account = require("../models/Account");
const Post = require("../models/Post");
const UsageEntry = require("../models/UsageEntry");
const InboxMark = require("../models/InboxMark");

// The windows Admin → Activity offers, in days; the first is the default.
const WINDOWS = [
  { days: 7, label: "7 days" },
  { days: 1, label: "24 hours" },
  { days: 30, label: "30 days" },
];
const windowOf = (days) => WINDOWS.find((w) => w.days === Number(days)) || WINDOWS[0];

// A write's count in a unit's ledger lines (0 when it made none).
const line = (key) => ({ $ifNull: [`$lines.${key}.returned`, 0] });

async function activityFor(days, now = new Date()) {
  const since = new Date(now.getTime() - windowOf(days).days * 864e5);
  const [writes, marks, accounts] = await Promise.all([
    UsageEntry.aggregate([
      { $match: { startedAt: { $gte: since }, kind: { $in: ["like", "reply", "follow"] }, accountId: { $ne: null } } },
      { $group: { _id: "$accountId", replies: { $sum: { $add: [line("replied:reply"), line("replied:replyLink")] } }, likes: { $sum: line("liked:like") }, follows: { $sum: line("followed:follow") }, unfollows: { $sum: line("unfollowed:unfollow") }, last: { $max: "$startedAt" } } },
    ]),
    InboxMark.aggregate([{ $match: { at: { $gte: since } } }, { $group: { _id: "$accountId", done: { $sum: 1 }, last: { $max: "$at" } } }]),
    Account.find({}, "username name image seenAt needsReauth balanceMicros pause features").lean(),
  ]);
  // One count per account on the membership index (Post "accounts.id"), never a pass over every post.
  const synced = new Map(await Promise.all(accounts.map(async (a) => [a._id, await Post.countDocuments({ "accounts.id": a._id })])));
  const w = new Map(writes.map((x) => [x._id, x]));
  const m = new Map(marks.map((x) => [x._id, x]));
  const latest = (...ds) => ds.filter(Boolean).map((d) => new Date(d)).reduce((a, b) => (!a || b > a ? b : a), null);
  return accounts
    .map((a) => {
      const x = w.get(a._id) || {};
      const d = m.get(a._id) || {};
      return {
        id: a._id,
        account: a,
        person: { id: a._id, username: a.username, profile: { name: a.name, image: a.image } },
        replies: x.replies || 0,
        likes: x.likes || 0,
        follows: x.follows || 0,
        unfollows: x.unfollows || 0,
        done: d.done || 0,
        synced: synced.get(a._id) || 0,
        last: latest(a.seenAt, x.last, d.last),
      };
    })
    .sort((p, q) => (q.last ? q.last.getTime() : 0) - (p.last ? p.last.getTime() : 0));
}

module.exports = { activityFor, WINDOWS, windowOf };
