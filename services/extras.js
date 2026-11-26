// Running the opt-in extras (services/features.js says what they are). Every read is recorded on the usage ledger
// (services/usage.js): Likes into its sync run's meter, a likers check, a like and a reply each as their own metered
// unit.
// Follows have no runner: their status comes with every profile read (models/Follow.js). Settings come in as
// arguments (no config here), like services/sync.js.
"use strict";

const { createClient, ReadCapReached, notFound } = require("../lib/x");
const { postsById } = require("./accountData");
const { WRITE_LIMITS, RESERVE } = require("../lib/writeLimits");
const { metered } = require("./usage");
const RateWindow = require("../models/RateWindow");
const UsageEntry = require("../models/UsageEntry");
const Like = require("../models/Like");
const Repost = require("../models/Repost");
const Follow = require("../models/Follow");
const Post = require("../models/Post");
const Person = require("../models/Person");
const LiveGap = require("../models/LiveGap");
const LiveState = require("../models/LiveState");
const LiveEvent = require("../models/LiveEvent");

// THE two ways a like is stored (a Like is per account: likes are private on X), whoever learned of it: the likes pass,
// the likers check, a live event (services/live.js). Upserts, so learning it twice stores it once.
//   yourLikeOp — the account liked someone's post. Seeing it from X clears `fromApp` (a like sent from xtoolio that the
//                new-likes pass mustn't stop on).
//   likerOp    — someone liked the account's own post.
// `likedAt`: when it happened, where X said (a live event); stored over a like first learned without one.
const at = (likedAt) => (likedAt && !Number.isNaN(new Date(likedAt).getTime()) ? { likedAt: new Date(likedAt) } : null);
const yourLikeOp = (accountId, postId, authorId, likedAt) => ({
  updateOne: { filter: { accountId, postId, likerId: accountId }, update: { $setOnInsert: { authorId, seenAt: new Date() }, $unset: { fromApp: "" }, ...(at(likedAt) && { $set: at(likedAt) }) }, upsert: true },
});
const likerOp = (accountId, postId, likerId, likedAt) => ({
  updateOne: { filter: { accountId, postId, likerId }, update: { $setOnInsert: { authorId: accountId, seenAt: new Date() }, ...(at(likedAt) && { $set: at(likedAt) }) }, upsert: true },
});

// THE two ways a repost is stored (models/Repost.js, Like's twin), whoever learned of it: Live's post.repost.create,
// your own timeline read (services/sync.js store: a post of yours that reposts another), the ↻ press (setRepost).
//   yourRepostOp — the account reposted someone's post (clears `fromApp`: the timeline has it now)
//   reposterOp   — someone reposted the account's own post
const reposted = (when) => (when && !Number.isNaN(new Date(when).getTime()) ? { repostedAt: new Date(when) } : null);
const yourRepostOp = (accountId, postId, authorId, when) => ({
  updateOne: { filter: { accountId, postId, reposterId: accountId }, update: { $setOnInsert: { seenAt: new Date(), ...(authorId && { authorId }) }, $unset: { fromApp: "" }, ...(reposted(when) && { $set: reposted(when) }) }, upsert: true },
});
const reposterOp = (accountId, postId, reposterId, when) => ({
  updateOne: { filter: { accountId, postId, reposterId }, update: { $setOnInsert: { authorId: accountId, seenAt: new Date() }, ...(reposted(when) && { $set: reposted(when) }) }, upsert: true },
});

// Who liked a reply settles within about a day; it's checked once, after that.
const LIKERS_AFTER_MS = 24 * 3600 * 1000;

// When the stream carries like events: the replies whose first day (LIKERS_AFTER_MS) overlapped a stretch X's stream
// wasn't connected (models/LiveGap.js), plus the current one if it's down now, as createdAt ranges for a $or. [] =
// none: nothing to check.
async function likersWindows() {
  const gaps = await LiveGap.find({ to: { $gte: new Date(Date.now() - 3 * LIKERS_AFTER_MS) } }, "from to").lean();
  const now = await LiveState.findById("stream", "connectedAt beatAt").lean();
  if (now && !now.connectedAt) gaps.push({ from: now.beatAt || new Date(0), to: new Date() });
  return gaps.map((g) => ({ createdAt: { $gte: new Date(new Date(g.from).getTime() - LIKERS_AFTER_MS), $lte: g.to } }));
}
// liking_users allows 75 requests per 15 minutes per user (one per reply): at most a window's worth is queued per
// run, and lib/x.js stops on X's own count before the window runs out (it used to be a fixed 40 a run, which two runs
// in one window — a restart, a Sync now press — pushed into 429s).
const LIKERS_POSTS_PER_RUN = 75;

// A page of your likes is newest-LIKE first, so the new ones are everything before the first like already
// stored. → { fresh, reachedKnown }
function untilKnown(posts, known) {
  const i = posts.findIndex((p) => known.has(p.id));
  return i === -1 ? { fresh: posts, reachedKnown: false } : { fresh: posts.slice(0, i), reachedKnown: true };
}

// The new-likes check, page by page: X's smallest page first (a run usually finds a like or two), full pages only
// once a whole page turned out new.
const NEW_LIKES_FIRST_PAGE = 10;
const newLikesPageSize = (pagesRead) => (pagesRead === 0 ? NEW_LIKES_FIRST_PAGE : 100);

// What a run reads of your likes, from where the look back stands (SyncState.likes):
//   forward  — new likes, newest first until one already stored. With the look back, only once it has begun: before
//              that, the look back starts at the top and reads the new ones itself.
//   backfill — the look back (People's: "You liked" counts your whole history), from the saved token (none = the
//              top), until the cap or X has nothing older. Never without `lookBack` (Liking alone: the ♥ needs only
//              what you like from now on).
function likesPlan(likes, { lookBack = true } = {}) {
  const begun = !!(likes.backfillToken || likes.backfillDone || likes.backfillRead);
  return { forward: begun || !lookBack, backfill: lookBack && !likes.backfillDone, from: likes.backfillToken || undefined };
}

// YOUR LIKES RECONCILE EXACTLY TO YOUR HISTORY (a day of posts is a day of likes): the look back reads your likes back to the history's start
// (`floorId`: the oldest of your posts and mentions the history read, services/sync.js) and no further, ever, so what
// "how far back?" quoted is what's read, and the Inbox (which never starts before the history) knows every like you gave
// in it. Past it = X has nothing older, or a whole page of likes is of posts older than it: the list runs newest LIKE
// first and a like comes after its post, so by then the likes are almost surely older too (X gives no time for a like;
// the rule is an inference, a whole page of 100 to make it a safe one). No floor yet: only X's end stops it. Pure.
const pastFloor = (page, floorId) => !page.nextToken || (!!floorId && page.posts.length > 0 && page.posts.every((p) => BigInt(p.id) < BigInt(floorId)));

// The look back after one page: resume from X's next token, or done (X has nothing older, or past the history's start:
// pastFloor). Done at the history's start, X's next token is KEPT: reading further back (services/further.js) reopens
// the look back there instead of from your newest like (re-reading, and paying again for, every like already read).
// A first read that reconciles (`reconciled` false) is reconciled once it's done. Pure.
function afterBackfillPage(likes, page, floorId = null) {
  const done = pastFloor(page, floorId);
  const next = { backfillToken: page.nextToken || undefined, backfillRead: (likes.backfillRead || 0) + page.posts.length, backfillDone: done };
  if (likes.reconciled === false) next.reconciled = done;
  else if (likes.reconciled === true) next.reconciled = true;
  return next;
}

// A first read's reconciling reads past the per-run limit (likesCap) to reach the history's start in ONE run, up to this
// many likes (a safety bound; THE CEILING bounds the money).
const LIKES_FIRST_READ_MAX = 20000;

// Likes for one run, in two halves the sync turns on separately (docs/MODULES.md decision 1):
//   yours  — your new likes, and with `lookBack` the look back through older ones (a page at a time, resumed across
//            runs until X has nothing older): People and Liking
//   likers — who liked your replies that are a day old and not checked yet: the Likes module
// Returns the tally. `likesCap` is the liked posts read per run, forward and back together, except while a FIRST READ
// reconciles (SyncState.likes.reconciled false): then the look back goes on past it until it reaches the history's start
// (`floorId`), so the Inbox opens knowing every like you gave in it. Either way the look back ends there (pastFloor).
// `meter` is the sync run's.
// THE RESUME READ (SyncState.resume, services/pause.js) reconciles your NEW likes the same way, to its own moment
// (`resume.floorId`): full pages from the top, until a like already stored (null floor: everything since the pause) or a
// whole page of likes of posts older than the moment (pastFloor, the first read's rule), past likesCap like a first
// read; then `likesDone`, which (with its posts read) lets the Inbox open. A run stopped part way (X's limit) leaves
// it, and the next run's check from the top stops at what this one stored: the rest of that stretch isn't read.
async function runLikes({ accountId, token, meter, ownerId, state, yours = true, lookBack = true, likers = true, likesCap, likersUserCap, likesLive = false, floorId = null }) {
  // READ FURTHER BACK's likes stage (services/further.js) reconciles like a first read, to the new start, without
  // holding any page.
  const reconciling = !!(state.likes && state.likes.reconciled === false) || state.furtherStage === "likes";
  const resuming = !!(yours && state.resume && !state.resume.likesDone);
  const x = createClient({ token, meter, ownerId, readCap: reconciling || resuming ? Math.max(likesCap, LIKES_FIRST_READ_MAX) : likesCap, userCap: likersUserCap });
  const tally = { yourLikes: 0, likesBack: null, likersChecked: 0, likers: 0, stop: "up to date" };
  // Upserts are idempotent ($setOnInsert), so the look back can re-read likes the forward pass stored. A like sent
  // from xtoolio, now seen in X's list, stops being `fromApp`. → new ones
  const storeLikes = async (posts) => {
    const ops = posts.filter((p) => p.author_id).map((p) => yourLikeOp(accountId, p.id, p.author_id));
    return ops.length ? (await Like.bulkWrite(ops, { ordered: false })).upsertedCount : 0;
  };
  const plan = yours ? likesPlan(state.likes || {}, { lookBack }) : { forward: false, backfill: false };
  // Without the look back nothing stored may be there to stop at yet: the first run reads only X's first page (your
  // latest likes, all the ♥ needs), and every later run stops at what it stored.
  const firstOnly = plan.forward && !lookBack && !(await Like.exists({ accountId, likerId: accountId }));

  try {
    // 1. New likes, newest first, until one already stored. liked_tweets has no since_id, so this re-reads the top of
    // the list each run: the first page is X's smallest (NEW_LIKES_FIRST_PAGE), and only a page that's all new
    // leads to full pages. It used to ask for 100 every run to find a like or two: 9,600 returned posts a day per
    // account, re-billed every UTC day.
    for (let next, pages = 0; plan.forward; pages++) {
      const page = await x.likedPage(accountId, { paginationToken: next, maxResults: resuming ? 100 : newLikesPageSize(pages) });
      // A like sent from xtoolio isn't "known" here: X lists it among your likes, and stopping on it would skip the
      // likes you made on X just before it.
      const known = new Set((await Like.find({ accountId, likerId: accountId, postId: { $in: page.posts.map((p) => p.id) }, fromApp: { $ne: true } }, "postId").lean()).map((l) => l.postId));
      const { fresh, reachedKnown } = untilKnown(page.posts, known);
      tally.yourLikes += await storeLikes(fresh);
      next = page.nextToken;
      if (resuming) {
        state.resume.likesRead = (state.resume.likesRead || 0) + fresh.length;
        await state.save();
        await LiveEvent.note(accountId, "pull");
      }
      if (reachedKnown || !next || firstOnly || (resuming && pastFloor(page, state.resume.floorId))) break;
    }
    // Your new likes are read to the resume's moment (or there were none to read this way: the look back from the top
    // reads them). The Inbox may open once its posts are read too (services/sync.js).
    if (resuming) {
      state.resume.likesDone = true;
      await state.save();
    }

    // 2. The look back, resumed from its saved place; the place is saved after every page, and it ends at the history's
    // start. Reconciling, each page is news to the progress page (LiveEvent "pull").
    for (let from = plan.from; plan.backfill; ) {
      // The look back through your likes is history: a bulk read, charged at the bulk markup (services/balance.js).
      await meter.bulkRead("Your history");
      let page;
      try {
        page = await x.likedPage(accountId, { paginationToken: from });
      } catch (err) {
        // A saved token X no longer accepts: start the look back from the top next run (re-reading stored likes
        // costs reads but stores nothing twice).
        if (err.status === 400 && from) {
          state.set("likes.backfillToken", undefined);
          await state.save();
          throw Object.assign(new Error("X refused the saved place in your likes; the next run looks back from the top"), { status: 400, transient: true });
        }
        throw err;
      }
      tally.yourLikes += await storeLikes(page.posts);
      state.set("likes", afterBackfillPage(state.likes || {}, page, floorId));
      await state.save();
      if (reconciling) await LiveEvent.note(accountId, "pull");
      if (state.likes.backfillDone) break;
      from = page.nextToken;
    }
  } catch (err) {
    if (!(err instanceof ReadCapReached) && err.status !== 429 && !err.transient) throw err;
    tally.stop = err.message;
  }
  tally.likesBack = state.likes && { read: state.likes.backfillRead, done: !!state.likes.backfillDone };

  try {
    // 2. Who liked your replies (your own posts only: X hides the likers of anyone else's). With Live's like events on
    // (`likesLive`), likes on your posts already arrived, free, as they happened: only a reply whose first day
    // overlapped a stretch the stream wasn't connected (likersWindows) is read, ~$0.01 a liker. It used to read every
    // reply, an account's biggest line, for what Live had said for free.
    const windows = likers && likesLive ? await likersWindows() : null;
    const due = !likers || (windows && !windows.length) ? [] : await Post.find(
      { authorId: accountId, inReplyToUserId: { $exists: true, $ne: accountId }, likersCheckedAt: { $exists: false }, createdAt: { $lte: new Date(Date.now() - LIKERS_AFTER_MS) }, ...(windows && { $or: windows }) },
      "_id"
    )
      .sort({ createdAt: -1 })
      .limit(LIKERS_POSTS_PER_RUN)
      .lean();
    for (const post of due) {
      tally.likers += await storeLikers(x, accountId, post._id);
      tally.likersChecked++;
    }
  } catch (err) {
    if (!(err instanceof ReadCapReached) && err.status !== 429 && !err.transient) throw err;
    tally.stop = err.message;
  }

  return { ...tally, usage: { ...x.usage } };
}

// Who liked one of your posts, asked of X now and stored; the post is marked checked. THE one way likers are read:
// the daily check above and the ↻ in a conversation both use it. → how many likers X returned.
async function storeLikers(x, accountId, postId) {
  const users = await x.likingUsers(postId);
  if (users.length) {
    await Like.bulkWrite(users.map((u) => likerOp(accountId, postId, u.id)), { ordered: false });
    // Their profiles came with them (already paid for): stored like any profile read, follow status included.
    const now = new Date();
    await Person.store(users, now);
    await Follow.record(accountId, users, now);
  }
  await Post.updateOne({ _id: postId }, { $set: { likersCheckedAt: new Date() } });
  return users.length;
}

// The ♥ in a conversation: like (on = true) or unlike a post on X as this account, then record it as a Like the
// pages show at once. Only someone else's post that's stored; a press that matches what's already recorded sends
// nothing (a double press pays once). One metered unit (kind "like"), gated and charged like any other; `account`
// must have Liking active (the caller checks). Settings from services/accounts.js syncSettings. `meter`: a bulk press's
// own unit (web.js /inbox/like-all: ONE ledger row for the press: 44 rows of "Like · liked 1 post" for one
// press didn't read as one action), recorded into in place of a unit of its own.
// → "liked" | "unliked" | "same" | "missing" | "gone" (X refused, and X no longer serves the post: deleted since,
// now marked gone: goneCheck)

// A WRITE X REFUSED ON A POST: is the post still there? (a bulk like once skipped someone's reply, deleted since,
// and the card kept it as owed forever: X sends no deletions, so a deleted reply waited in the Inbox until you acted.)
// Only a refusal with a reason (a 4xx, not X's rate limit) is asked about, by ONE lookup by id (X bills a post it
// returns, $0.005; one it won't return costs nothing). X saying it won't serve it → the post is marked `gone`, as the
// sync's context pass marks what X won't serve (and a later read that gets it back clears the mark: sync.store), and
// true. Anything else, false: the caller's error stands. A gone post owes nothing (inbox.standingOf).
// ONLY X's "doesn't exist" marks it (lib/x.js notFound): the post is shared, and X refusing THIS account (a protected
// author it doesn't follow) said nothing about it for the accounts that can see it.
async function goneCheck(x, postId, err) {
  if (!err || !(err.status >= 400 && err.status < 500) || err.status === 429 || err.paced) return false;
  const { missing } = await x.postsByIds([String(postId)]).catch(() => ({ missing: [] }));
  const m = missing.find((g) => g.id === String(postId));
  if (!notFound(m)) return false;
  await Post.updateOne({ _id: String(postId) }, { $set: { gone: { title: m.title, detail: m.detail } } });
  return true;
}
// A post a write may act on: stored AND one this account may see (accountData.visibleTo, the rule every page uses). A
// protected author's post that only a follower's read brought in is "missing" here, as on every page.
const writable = async (accountId, postId, fields) => (await postsById(accountId, [String(postId)], fields))[0] || null;

async function setLike({ accountId, postId, on, getToken, ownerId = null, billing = null, meter = null }) {
  const post = await writable(accountId, postId, "authorId gone");
  if (!post || !post.authorId || post.authorId === accountId) return "missing";
  if (post.gone) return "gone";
  const key = { accountId, postId, likerId: accountId };
  if (!!(await Like.exists(key)) === on) return "same";
  const token = await getToken();
  const write = async (m) => {
    const x = createClient({ token, meter: m, ownerId, readCap: 0, userCap: 0, contextCap: 1 });
    try {
      await x.setLike(accountId, postId, on);
      return "done";
    } catch (err) {
      if (await goneCheck(x, postId, err)) return "gone";
      throw err;
    }
  };
  const result = meter ? await write(meter) : await metered({ accountId, kind: "like", label: on ? "Like" : "Unlike", billing }, write);
  if (result === "gone") return "gone";
  if (on) await Like.updateOne(key, { $setOnInsert: { authorId: post.authorId, seenAt: new Date(), fromApp: true } }, { upsert: true });
  else await Like.deleteOne(key);
  return on ? "liked" : "unliked";
}

// THE ↻ (the Reposting add-on): repost someone's post on X as this account (on = true), or undo it, then record it at
// once, so the button and every page show it before the next sync reads your timeline. Repeat-safe like the ♥: a press
// matching what's recorded sends nothing. One metered unit (kind "repost"), gated and charged; the caller checks
// Reposting is active. A post deleted on X is marked gone (goneCheck). Undone on X itself, a repost stays recorded here
// (X sends no deletions); pressing ↻ then sends an undo X answers harmlessly.
// → "reposted" | "unreposted" | "same" | "missing" | "gone"
async function setRepost({ accountId, postId, on, getToken, ownerId = null, billing = null }) {
  const post = await writable(accountId, postId, "authorId gone");
  if (!post || !post.authorId || post.authorId === accountId) return "missing";
  if (post.gone) return "gone";
  const key = { accountId, postId, reposterId: accountId };
  if (!!(await Repost.exists(key)) === on) return "same";
  const token = await getToken();
  const result = await metered({ accountId, kind: "repost", label: on ? "Repost" : "Undo repost", billing }, async (m) => {
    const x = createClient({ token, meter: m, ownerId, readCap: 0, userCap: 0, contextCap: 1 });
    try {
      await x.setRepost(accountId, postId, on);
      return "done";
    } catch (err) {
      if (await goneCheck(x, postId, err)) return "gone";
      throw err;
    }
  });
  if (result === "gone") return "gone";
  if (on) await Repost.updateOne(key, { $setOnInsert: { authorId: post.authorId, seenAt: new Date(), repostedAt: new Date(), fromApp: true } }, { upsert: true });
  else await Repost.deleteOne(key);
  return on ? "reposted" : "unreposted";
}

// Of these posts, the ones this account reposted (the ↻'s state). → Set of post ids
async function repostedByYou(accountId, postIds) {
  if (!postIds.length) return new Set();
  return new Set((await Repost.find({ accountId, reposterId: accountId, postId: { $in: postIds } }, "postId").lean()).map((r) => r.postId));
}

// HOW MANY WRITES X ALLOWS NOW (the bulk presses: the Inbox's "♥ Like N", a thread's "Follow N", the reconciler's
// unfollow), by THE table (lib/writeLimits.js). The 15-minute window is X's own count, as lib/x.js stored it from the
// last such write's response (RateWindow, per account and method: the web and the worker see the same), less the
// reserve lib/x.js keeps for a write (none: lib/x.js reserveFor); no window known, or one past its reset: a fresh one. The day (where X states one) is counted from the ledger:
// those sent from xtoolio in the last 24 hours (ones made on X itself count against X's day too, and aren't seen here:
// X's 429 is the backstop).
// → { left, windowLeft, dayLeft, resetAt (Date | null: when more come, while `left` is 0), windowEnds, afterReset }
async function writesLeft(accountId, kind) {
  const lim = WRITE_LIMITS[kind];
  // The day: the writes recorded in the last 24 hours' units of this kind (a bulk press is one unit holding many).
  const sentToday = async () => {
    const units = await UsageEntry.find({ accountId, kind: lim.ledger.kind, status: "ok", startedAt: { $gte: new Date(Date.now() - 24 * 3600 * 1000) } }, `lines.${lim.ledger.line}`).lean();
    return units.reduce((s, u) => s + (((u.lines || {})[lim.ledger.line] || {}).returned || 0), 0);
  };
  const [win, today] = await Promise.all([RateWindow.findById(`${accountId} ${lim.window}`, "remaining reset").lean(), lim.perDay ? sentToday() : 0]);
  const fresh = !win || win.reset.getTime() <= Date.now();
  const windowLeft = Math.max(0, (fresh ? lim.perWindow : win.remaining) - RESERVE);
  const dayLeft = lim.perDay ? Math.max(0, lim.perDay - today) : Infinity;
  const left = Math.min(windowLeft, dayLeft);
  // When more come: the window's reset; a spent day frees up as its oldest turn 24 hours old (said as "tomorrow").
  const resetAt = left > 0 ? null : windowLeft === 0 ? win.reset : null;
  // The page's own clock (the bulk like button): when this window ends (`windowEnds`, ms; null with none running) and
  // what's left after it (`afterReset`: a fresh window, within the day), so an open page counts back up by itself.
  const windowEnds = fresh ? null : win.reset.getTime();
  const afterReset = Math.min(lim.perWindow - RESERVE, dayLeft);
  return { left, windowLeft, dayLeft, resetAt, windowEnds, afterReset };
}

// The Follow / Following button (the Follows page; the Following extra): follow (on = true) or unfollow someone on X as
// this account, then record the pair at once (Follow.fromEvent), so the page shows it before anything else reads it;
// its flip moves the header's "following" by one (X's echo of the same follow, arriving later, finds nothing to flip).
// A press that matches what's recorded sends nothing (a double press pays once). One metered unit (kind "follow"),
// gated and charged; the caller checks Following is active. A protected account's follow waits for its approval
// ("pending": recorded as not following yet). `meter`: a bulk press's own unit (a thread's Follow N, the bulk unfollow:
// ONE ledger row for the press, as setLike). → "followed" | "pending" | "unfollowed" | "same" | "missing"
async function setFollow({ accountId, personId, on, getToken, ownerId = null, billing = null, meter = null }) {
  if (!personId || personId === accountId) return "missing";
  const edge = await Follow.findById(`${accountId}>${personId}`, "follows").lean();
  if (!!(edge && edge.follows) === on) return "same";
  const token = await getToken();
  const write = (m) => createClient({ token, meter: m, ownerId, readCap: 0, userCap: 0 }).setFollow(accountId, personId, on);
  const r = meter ? await write(meter) : await metered({ accountId, kind: "follow", label: on ? "Follow" : "Unfollow", billing }, write);
  await Follow.fromEvent(accountId, personId, on && r.following, new Date());
  return !on ? "unfollowed" : r.pending ? "pending" : "followed";
}

// The reply box (the Inbox, a conversation; the Replying extra): post `text` on X as this account, replying to
// `postId`, then store it at once as the account's own post, so every page shows it (and the Inbox counts the
// conversation answered) before the next sync, whose timeline read then writes X's full copy over it
// (sync.store $sets the shared fields). One metered unit (kind "reply"), gated and charged like any other. The caller
// checks Replying is active and the text's length. → the stored post (people.POST_FIELDS shape).
const REPLY_MAX = 4000; // X's own cap is 280 without Premium (longer with it): X refuses what's too long
// `media`: pictures already checked (lib/media.js checkAttachments' items; the Pictures add-on), uploaded to X in the
// same unit, then attached. A reply with pictures is read back from X right away (one post, $0.005, in the same unit)
// and stored through the sync's own writer, so its bubble shows the pictures now (X's addresses), not after the next
// sync; it can't be drawn from what we sent, since X hosts them.
async function sendReply({ accountId, postId, text, media = [], getToken, ownerId = null, billing = null }) {
  const parent = await writable(accountId, postId, "authorId conversationId gone");
  if (!parent || parent.gone) throw Object.assign(new Error("That post isn't stored, or isn't on X any more"), { code: "NO_POST" });
  const token = await getToken();
  const { sent, full } = await metered({ accountId, kind: "reply", label: "Reply", billing }, async (meter) => {
    // contextCap: one read for goneCheck, one more to read a reply with pictures back.
    const x = createClient({ token, meter, ownerId, readCap: 0, contextCap: media.length ? 2 : 1, userCap: 0 });
    const ids = [];
    for (const item of media) ids.push(await x.uploadMedia(item));
    const sent = await x.reply(postId, text, ids).catch(async (err) => {
      if (await goneCheck(x, postId, err)) throw Object.assign(new Error("That post isn't on X any more"), { code: "NO_POST" });
      throw err;
    });
    // The read-back is a nicety: if it fails, the reply still went out and the next sync brings its pictures.
    const full = ids.length ? await x.postsByIds([sent.id]).then((r) => r.posts[0] || null, () => null) : null;
    return { sent, full };
  });
  if (full) {
    // Lazily: services/sync.js requires this module (runLikes), so it can't be required at the top.
    await require("./sync").store([full], accountId, "own");
    return Post.findById(sent.id).lean();
  }
  const doc = {
    authorId: accountId,
    // What you wrote, not X's echo: X's `text` is HTML-escaped (&amp;) and starts with the "@them " it adds to a
    // reply, which the pages strip only with the mention offsets a full read carries (the first reply
    // showed "@them liking &amp; replying…"). The sync's own timeline read writes X's full copy over it.
    text,
    createdAt: new Date(),
    conversationId: parent.conversationId || postId,
    inReplyToUserId: parent.authorId,
    referenced: [{ type: "replied_to", id: postId }],
    mentions: [],
  };
  // $setOnInsert: if a sync somehow stored it first, X's full copy stands.
  await Post.updateOne({ _id: sent.id }, { $setOnInsert: doc, $addToSet: { accounts: { id: accountId, kind: "own" } } }, { upsert: true });
  return { _id: sent.id, ...doc };
}

// For a conversation: who liked each of these posts, as far as this account can see (likes are private on X):
// posts YOU liked (complete), and who liked YOUR posts (each reply checked once, a day after it was posted; until
// then, nobody is known). → Map postId → [likerId]
async function likersByPost(accountId, postIds) {
  const rows = postIds.length ? await Like.find({ accountId, postId: { $in: postIds } }, "postId likerId").lean() : [];
  const out = new Map();
  for (const l of rows) out.set(l.postId, [...(out.get(l.postId) || []), l.likerId]);
  return out;
}

// For the pages: one account's like counts and follow sets, as services/people.js takes them. Follows are the pairs
// with this account on one side (models/Follow.js): who follows it, and whom it follows.
async function signalsFor(accountId) {
  const [likes, followers, following] = await Promise.all([
    Like.find({ accountId }, "authorId likerId").lean(),
    Follow.find({ followeeId: accountId, follows: true }, "followerId").lean(),
    Follow.find({ followerId: accountId, follows: true }, "followeeId").lean(),
  ]);
  const byYou = new Map(); // person → how many of their posts you liked
  const ofYou = new Map(); // person → how many of your posts they liked
  for (const l of likes) {
    if (l.likerId === accountId) byYou.set(l.authorId, (byYou.get(l.authorId) || 0) + 1);
    else ofYou.set(l.likerId, (ofYou.get(l.likerId) || 0) + 1);
  }
  return {
    likes: { byYou, ofYou },
    follows: { followers: new Set(followers.map((f) => f.followerId)), following: new Set(following.map((f) => f.followeeId)) },
  };
}

module.exports = {
  goneCheck, yourLikeOp, likerOp, yourRepostOp, reposterOp, NEW_LIKES_FIRST_PAGE, untilKnown, newLikesPageSize, likesPlan, afterBackfillPage, pastFloor, LIKES_FIRST_READ_MAX, runLikes, likersByPost, setLike, setRepost, repostedByYou, writesLeft, setFollow, sendReply, REPLY_MAX, signalsFor };
