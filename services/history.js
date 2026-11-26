// "How far back should xtoolio read?" — the choice an account makes when People first reads its history. Pure.
//
// The choice is a BUDGET of timeline posts + mentions read going backwards (Account.history.budget). The sync
// honours it as a hard depth: backfill stops when SyncState.backfillRead reaches it, on the first pull and on
// every scheduled run after (services/sync.js). New posts keep arriving regardless; only the past is limited.
"use strict";

const { estimatePull, PRICE, LIKES_PER_POST_READ } = require("../lib/pricing");

// THE LIKES A FIRST READ RECONCILES (services/extras.js runLikes): your likes over EXACTLY the stretch the history covers
// (a day of posts is a day of likes), so the Inbox and People know what you already
// liked and nothing is read after. What's READ, not just what's in the stretch: the likes in it (LIKES_PER_POST_READ per
// post and mention read, lib/pricing.js, measured on one account) come in X's pages of LIKES_PAGE, and the look back
// stops only after a WHOLE page of likes of older posts (extras.js pastFloor), which takes OVERRUN_PAGES more on
// what's been seen (a liked post's age is mixed): so whole pages, plus two. Without the overrun a short read was
// quoted at a fraction of its cost (a "1 day" read quoted a few dozen likes and read three pages of them).
// Never more than you have (`likeCount`, X's like_count, when known). → a count. Pure.
const LIKES_PAGE = 100;
const OVERRUN_PAGES = 2;
// `overrun`: 0 for a RESUME (services/pause.js), whose read stops at the first like it already has (the likes kept
// before the pause), so it never reads a page past the stretch.
function firstReadLikes({ budget = 0, likeCount = null, overrun = OVERRUN_PAGES } = {}) {
  if (!(budget > 0)) return 0;
  const inStretch = Math.ceil(budget * LIKES_PER_POST_READ);
  const read = (Math.ceil(inStretch / LIKES_PAGE) + overrun) * LIKES_PAGE;
  return Number.isFinite(likeCount) ? Math.min(likeCount, read) : read;
}

// THE FIRST READ's X cost: `budget` posts and mentions read back (estimatePull: with the threads around them and the
// people in them) and `likes` of your likes read to reconcile, each a post (your own likes are an Owned Read for the
// app's owner). Pure.
const pullCost = (budget, likes = 0, { owned = false } = {}) => estimatePull(budget, { owned }) + likes * (owned ? PRICE.owned : PRICE.post);

// X serves roughly a user's latest 3,200 posts and 800 mentions through these timelines, never more: nobody reads more
// than ~4,000, however much they've posted.
const X_POST_LIMIT = 3200;
const X_MENTION_LIMIT = 800;

// Stretches of time (1 day, 1 week, 1 month of posts), sized from the
// account's pace (`perDay`: its posts + the replies and mentions to it a day, services/estimator.js). Without a pace,
// counts (they were 300 / 1,000, then 1,000 / 2,500).
const DAY_TIERS = [
  { key: "day", days: 1, label: "1 day" },
  { key: "week", days: 7, label: "1 week" },
  { key: "month", days: 30, label: "1 month" },
];
const COUNT_TIERS = [
  { key: "1000", budget: 1000, label: "1,000 posts", detail: "Up to 1,000 posts and mentions" },
  { key: "2500", budget: 2500, label: "2,500 posts", detail: "Up to 2,500 posts and mentions" },
];

// The options for someone with `postCount` posts (X's tweet_count; unknown → assume the most) and, when known, a pace
// of `perDay` posts and mentions a day. A tier that would reach as far as everything X serves anyway becomes that
// ("everything X serves"), and any longer one is dropped, so no two options do the same thing. `owned`: the app owner,
// whose timeline and mentions are Owned Reads (lib/pricing.js), so its estimates are lower. Each option carries the
// likes it reconciles over the same stretch (firstReadLikes, `likeCount` the account's own when known), in its price and
// said in its detail. THE DETAIL IS WHAT YOU'RE BUYING, in one line and nothing else (the start page:
// people don't read long text, so each option says plainly what it buys): the
// budget is a hard depth, so "up to"; the likes an estimate, so "about".
function historyOptions(postCount, { owned = false, perDay = null, likeCount = null } = {}) {
  const posts = Number.isFinite(postCount) ? postCount : X_POST_LIMIT;
  const servedPosts = Math.min(X_POST_LIMIT, posts);
  const all = servedPosts + X_MENTION_LIMIT;
  const n = (v) => v.toLocaleString("en-US");
  // Everything, said as its two parts: the posts are a real count (X's tweet_count, capped by what X serves), the
  // mentions only a ceiling (X doesn't say how many someone has until they're read).
  const allDetail = posts > X_POST_LIMIT ? `Your latest ${n(servedPosts)} posts (X's limit) and up to ${n(X_MENTION_LIMIT)} mentions` : `Your ${n(servedPosts)} posts and up to ${n(X_MENTION_LIMIT)} mentions`;
  const options = [];
  if (perDay > 0) {
    for (const t of DAY_TIERS) {
      const budget = Math.max(5, Math.round(t.days * perDay));
      if (budget >= all) {
        // This stretch reaches past what X serves: it IS everything.
        options.push({ key: "all", budget: all, label: `${t.label}, as far as X serves`, detail: allDetail });
        break;
      }
      options.push({ key: t.key, budget, label: t.label, detail: `Up to ${n(budget)} posts and mentions` });
    }
  } else {
    options.push(...COUNT_TIERS.filter((t) => t.budget < all));
    options.push({ key: "all", budget: all, label: "Everything X serves", detail: allDetail });
  }
  return options.map((o) => {
    const likes = firstReadLikes({ budget: o.budget, likeCount });
    return { ...o, likes, detail: likes ? `${o.detail} · about ${n(likes)} of your likes` : o.detail, estimate: pullCost(o.budget, likes, { owned }) };
  });
}

module.exports = { historyOptions, firstReadLikes, pullCost, DAY_TIERS, X_POST_LIMIT, X_MENTION_LIMIT, LIKES_PAGE };
