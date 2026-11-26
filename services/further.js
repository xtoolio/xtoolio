// services/further.js — READ FURTHER BACK: more of your history after the first read, chosen from Your circle.
//
// A first read of "1 day" builds a circle from one day of conversations, which for most people is a handful of faces
// (rings are drawn only when full: services/circle.js). This is the way to fill it in: the first read's own stretches
// (services/history.js, sized from your pace), each priced for what's BEYOND what's read, at the onboarding markup (BULK_MARKUP_PCT: reading history).
//
// THE MECHANISM is the first read's: `Account.history.budget` is how deep the backward read goes (services/sync.js
// runPasses), so a deeper read raises it and REOPENS the streams that stopped because they reached it (`budgetReached`;
// one X ran out on stays done). Asking writes the account only (`history.further` { from, inbox, at }); the SYNC, under
// its lock, takes it in STAGES on SyncState.furtherStage:
//   posts — the streams reopened, reading back from where they stopped (state.backfillRead counts on), until both are
//           done again;
//   likes — then your likes' look back reopens from its kept place (services/extras.js), to the history's NEW start, so
//           nothing older shows as owing a like you gave (only once the posts are in: the likes stop at the oldest post
//           read so far);
//   done  — the account's `history.further` goes, and, when asked (`inbox`), THE INBOX'S START moves back to the oldest
//           mention read, so those replies wait in the Inbox (services/inboxStart.js).
// Nothing holds the pages meanwhile (it isn't a first read: features.firstReadGoing never sees it); the Inbox's "Load
// earlier" waits (inboxStart.moreFor), its cards' likes not yet reconciled that far. The worker starts it within seconds
// (services/scheduler.js); a run stopped part way carries on at the next regular run, as a first read does.
"use strict";

const Account = require("../models/Account");
const { historyOptions, firstReadLikes, pullCost, LIKES_PAGE, X_POST_LIMIT, X_MENTION_LIMIT } = require("./history");

const STREAMS = ["own", "mention"];

// Can more be read: a stream stopped because it reached the chosen depth (not because X had nothing older). Pure.
const canReadFurther = (state) => STREAMS.some((k) => state && state[k] && state[k].budgetReached);

// WHAT'S LEFT TO READ, counted, not inferred from the depth: a stream X ran out on has nothing left; one stopped at the
// depth has what X serves of it (your posts: X's post count, at most X_POST_LIMIT; mentions: X_MENTION_LIMIT) minus what's
// stored of it (`stored`: { own, mention }, the account's posts by membership). The depth alone counted a stream X had
// run out on as all still to read: an account with every post read was offered hundreds "more". Pure.
function leftToRead(account, state, stored = {}) {
  const posts = Math.min(X_POST_LIMIT, Number.isFinite(account.postCount) ? account.postCount : X_POST_LIMIT);
  const own = state && state.own && state.own.budgetReached ? Math.max(0, posts - (stored.own || 0)) : 0;
  const mention = state && state.mention && state.mention.budgetReached ? Math.max(0, X_MENTION_LIMIT - (stored.mention || 0)) : 0;
  return own + mention;
}
// Less than this left: nothing is offered (not worth a read, or a price).
const MIN_LEFT = 50;

// The choices beyond what's read (`account`: history.budget, postCount, likeCount; `state`: its SyncState; `stored`: its
// posts by membership, leftToRead), each a total depth (`budget`) priced for the rest: the posts and mentions between the
// two depths, AT MOST WHAT'S LEFT (the first stretch reaching it becomes "Everything X serves", and nothing past it),
// and your likes over that stretch in X's whole pages (history.firstReadLikes). A look back that finished before its
// place was kept (accounts from before) reads its likes again from the top to get there: that's in the price too. []
// when less than MIN_LEFT is left. Pure.
function options(account, state, { owned = false, perDay = null, stored = {} } = {}) {
  const current = (account.history && account.history.budget) || 0;
  if (!current || !canReadFurther(state)) return [];
  const left = leftToRead(account, state, stored);
  if (left < MIN_LEFT) return [];
  const likes = (state && state.likes) || {};
  const again = likes.backfillDone && !likes.backfillToken ? Math.ceil((likes.backfillRead || 0) / LIKES_PAGE) * LIKES_PAGE : 0;
  const cap = Number.isFinite(account.likeCount) ? account.likeCount : Infinity;
  const n = (v) => v.toLocaleString("en-US");
  const tiers = historyOptions(account.postCount, { owned, perDay, likeCount: account.likeCount });
  // The stretches stop at a month when a month doesn't reach what X serves; past them (a history already deeper than a
  // month) the rest is still there to read: everything X serves closes the list.
  const all = Math.min(X_POST_LIMIT, Number.isFinite(account.postCount) ? account.postCount : X_POST_LIMIT) + X_MENTION_LIMIT;
  if (!tiers.some((o) => o.key === "all")) tiers.push({ key: "all", budget: all, label: "Everything X serves" });
  // Capped at what's left: the first stretch that reaches it is everything, and nothing longer is offered.
  const capped = [];
  for (const o of tiers.filter((t) => t.budget > current)) {
    if (o.budget - current < left) capped.push(o);
    else {
      capped.push({ key: "all", budget: current + left, label: "Everything X serves" });
      break;
    }
  }
  return capped.map((o) => {
      const more = o.budget - current;
      const read = Math.min(cap, firstReadLikes({ budget: more, likeCount: account.likeCount }) + again);
      return { key: o.key, budget: o.budget, label: o.label, likes: read, detail: `Up to ${n(more)} more posts and mentions${read ? ` · about ${n(read)} of your likes` : ""}`, estimate: pullCost(more, read, { owned }) };
    });
}

// THE ASK: a choice from `options` (recomputed by the caller, never taken from a form), once at a time. `inbox`: move
// the Inbox's start back when it's done. → true when recorded (false: one already going, or the depth moved meanwhile).
async function ask(account, choice, { inbox = false } = {}) {
  const current = account.history && account.history.budget;
  const r = await Account.updateOne(
    { _id: account._id, "history.budget": current, "history.further": { $exists: false } },
    { $set: { "history.budget": choice.budget, "history.further": { from: current, inbox: !!inbox, at: new Date() } } }
  );
  return r.modifiedCount === 1;
}

// THE STAGES, on the run's SyncState (services/sync.js runPasses calls these in order). Pure on `state`; the sync saves.
// Begin: reopen the streams that stopped at the old depth. → the keys reopened
function begin(state) {
  const reopened = STREAMS.filter((k) => state[k] && state[k].budgetReached);
  for (const k of reopened) Object.assign(state[k], { backfillDone: false, budgetReached: false });
  state.furtherStage = "posts";
  return reopened;
}
// After the posts: both streams done going back → the likes' look back reopens (from its kept place), or, without one
// (`lookBack` false), it's done.
function afterPosts(state, { lookBack }) {
  if (state.furtherStage !== "posts" || !STREAMS.every((k) => !state[k] || state[k].backfillDone)) return;
  if (lookBack) {
    state.likes = state.likes || {};
    state.likes.backfillDone = false;
    state.furtherStage = "likes";
  } else state.furtherStage = "done";
}
// After the likes: the look back done again (to the new start) → done.
function afterLikes(state) {
  if (state.furtherStage === "likes" && state.likes && state.likes.backfillDone) state.furtherStage = "done";
}

// Done: the account's ask goes; asked, the Inbox's start moves back to the oldest mention read (only an account whose
// start is fixed, inboxFrom.id: one from before keeps its week; and only ever back). Keyed by the ask's `at`, so an ask
// made meanwhile isn't swallowed.
async function finish(acct, state) {
  const further = acct.history && acct.history.further;
  if (!further) return;
  const reach = state.mention && state.mention.oldestId;
  const from = acct.inboxFrom && acct.inboxFrom.id;
  const back = further.inbox && from && reach && BigInt(reach) < BigInt(from);
  await Account.updateOne({ _id: acct._id, "history.further.at": further.at }, { $unset: { "history.further": 1 }, ...(back && { $set: { "inboxFrom.id": reach } }) });
}

// Where an ask stands, for Your circle: null when none; else how much of the new stretch is read and whether the likes
// are being checked. `state`: backfillRead, furtherStage. Pure.
function progress(account, state) {
  const further = account.history && account.history.further;
  if (!further) return null;
  const of = Math.max(0, (account.history.budget || 0) - (further.from || 0));
  const read = Math.min(of, Math.max(0, ((state && state.backfillRead) || 0) - (further.from || 0)));
  return { read, of, likes: !!(state && state.furtherStage === "likes"), inbox: !!further.inbox };
}

module.exports = { canReadFurther, leftToRead, MIN_LEFT, options, ask, begin, afterPosts, afterLikes, finish, progress, STREAMS };
