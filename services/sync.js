// The sync engine, per account: pull the account's posts and mentions from X into the shared store, then the
// thread context around them, then the profiles of everyone involved — all within hard per-run caps (X bills
// per returned post / user), all with the account's OWN token.
//
// Callers: the scheduler (services/scheduler.js, each account on its own chosen interval), the "Sync now" button
// and a new sign-in (web.js), and the CLI (scripts/sync.js). They pass settings in, including getToken
// (services/accounts.js accessToken); this module never reads config, so `npm run verify` can load its pure
// helpers with no .env or database. The caller owns the Mongo connection.
//
// ONE RUN PER ACCOUNT AT A TIME: runSync takes a lock on the account's SyncState doc (`runningUntil`) with an
// atomic update, so a scheduled run, a button press and a CLI run can't interleave their since_id/until_id
// bookkeeping. The lock is a lease the run keeps alive (lib/heartbeat.js): a run whose process died lets it lapse
// within LEASE_MS.
//
// Posts: two streams (your posts incl. replies = "own", your "mention"s), each a forward pass (since_id) then a
// backfill (until_id) until X's history limit (~3,200 posts / ~800 mentions). The streams take turns page by
// page, each page asking for at most an even share of the remaining cap (pageShare), so a small cap samples both.
// State is saved after every page, so a capped or failed run resumes.
//
// Context, within its own per-run cap (contextCap, separate from the timeline cap): the parent of every stored reply and whatever timeline posts
// quote, fetched by id (100 per request) as stream "context", newest first. Each round's new posts feed the next,
// so chains walk up until they reach the thread's first post or one X won't serve. Never counted on the leaderboard.
//
// Profiles: the account, everyone on its leaderboard, then everyone else in its threads, whose profile was never
// fetched or is older than the profile policy allows for their place (services/syncPrefs.js PROFILES), in
// that order, 100 per request, within the user cap. Profiles are shared too: a person another account already
// looked up recently costs nothing.
"use strict";

const { createClient, ReadCapReached, notFound } = require("../lib/x");
const Account = require("../models/Account");
const Post = require("../models/Post");
const Person = require("../models/Person");
const Follow = require("../models/Follow");
const SyncState = require("../models/SyncState");
const LiveEvent = require("../models/LiveEvent");
const { leaderboard } = require("./people");
const { members: circleMembers } = require("./circle");
const { active, modulesOn, firstOn, pullDue } = require("./features");
const further = require("./further");
const { runLikes, yourRepostOp, signalsFor } = require("./extras");
const Repost = require("../models/Repost");
const { inboxStart } = require("./inbox");
const { X_POST_LIMIT, X_MENTION_LIMIT } = require("./history");
const pause = require("./pause");
const { accountPosts, postsInConversations } = require("./accountData");
const { refreshOwedSafely } = require("./inboxCount");
const { metered } = require("./usage");
const { PROFILES, profileTtlMs, LOOKED_UP_ONCE } = require("./syncPrefs");

const { LEASE_MS, heartbeat } = require("../lib/heartbeat");

// How many posts one page may ask for: an even share of what's left of the
// cap across the streams still running, within X's 5..100 page size. Without
// this the first page takes min(100, cap) and a small cap never reaches the
// second stream (the first real run read 100 own posts and 0 mentions).
function pageShare(room, liveStreams) {
  return Math.min(100, Math.max(5, Math.floor(room / liveStreams)));
}

// A backward (history) page's size within the account's remaining depth, or 0 = the chosen depth is reached,
// stop reading backwards. X's smallest page is 5, so fewer than 5 left also stops.
function backfillPageSize(share, depthLeft) {
  return depthLeft < 5 ? 0 : Math.min(share, depthLeft);
}

// The timeline cap for one run. While the account's chosen history isn't fully read (a first pull, or one an X
// outage cut short), ANY run — scheduled, Sync now, the first one — is sized to finish it (the remaining depth,
// plus the normal top-up room for new posts); after that, the normal top-up cap. So an interrupted pull resumes
// at full speed on the next pass instead of 100 posts every 15 minutes, and there's no separate "first pull"
// path to keep in step. Thread context has its own cap (contextCap), so it never competes with this.
// THE RESUME READ (SyncState.resume, services/pause.js) is sized the same way: what it was priced on, on top.
function runReadCap(readCap, budget, state, { floorId } = {}) {
  const depthLeft = budget - (state.backfillRead || 0);
  // A stream is done going back unless it stopped at the Inbox's floor and there's no floor now (People turned on).
  const done = (s) => s && s.backfillDone && !(s.floorReached && !floorId);
  const historyLeft = depthLeft >= 5 && !(done(state.own) && done(state.mention));
  const resumeLeft = state.resume ? state.resume.budget || 0 : 0;
  return (historyLeft ? readCap + depthLeft : readCap) + resumeLeft;
}

const newer = (a, b) => !b || BigInt(a) > BigInt(b);
const older = (a, b) => !b || BigInt(a) < BigInt(b);

// Timeline posts: refresh the shared fields and ADD this account's membership — never replace the doc, which
// would drop other accounts' memberships. A post stored earlier as someone's context gains membership here.
// → the posts (X's shape) this account didn't have before.
async function store(posts, accountId, kind) {
  if (!posts.length) return [];
  const had = new Set((await Post.find({ _id: { $in: posts.map((p) => p.id) }, "accounts.id": accountId }, "_id").lean()).map((p) => p._id));
  await Post.bulkWrite(
    posts.map((p) => {
      const { _id, ...fields } = Post.fromApi(p);
      return {
        updateOne: {
          filter: { _id },
          update: { $set: fields, $unset: { gone: 1 }, $addToSet: { accounts: { id: accountId, kind } } },
          upsert: true,
        },
      };
    }),
    { ordered: false }
  );
  // A post of yours that reposts another is the ↻'s state on that post (models/Repost.js; extras.yourRepostOp), from
  // the timeline read or Live's post.create, whichever brings it.
  if (kind === "own") {
    const ops = posts
      .filter((p) => p.author_id === accountId)
      .map((p) => [p, (p.referenced_tweets || []).find((r) => r.type === "retweeted")])
      .filter(([, r]) => r)
      .map(([p, r]) => yourRepostOp(accountId, r.id, null, p.created_at));
    if (ops.length) await Repost.bulkWrite(ops, { ordered: false });
  }
  return posts.filter((p) => !had.has(p.id));
}

// A post that just reached an account, told to its open pages (services/livePush.js → public/js/live.js): someone
// else's is the Inbox's news ("N new · Show"), yours (made on X) lands in place under what it answers (`replyOf`:
// public/js/live.js → post-actions.js xtoolioYourReply: a reply made through "On X" should appear here),
// else a conversation's pill. THE note for a NEW post, whoever found it: Live's ingest, the mentions
// check, a sync's forward read (never its history: that isn't news). X's shape.
function announce(accountId, post, kind) {
  const conversationId = post.conversation_id || post.id;
  const replyOf = ((post.referenced_tweets || []).find((r) => r.type === "replied_to") || {}).id;
  if (kind === "own") return LiveEvent.note(accountId, "post", { postId: post.id, conversationId, ...(replyOf && { replyOf }) });
  // A repost that reached the mentions ("RT @x: … @you …") isn't in the Inbox (people.exchangeWith): nothing new to show.
  if ((post.referenced_tweets || []).some((r) => r.type === "retweeted")) return null;
  return LiveEvent.note(accountId, "inbox", { postId: post.id, conversationId, personId: post.author_id });
}

// The FORWARD half of a stream (what's newer than what's stored), never its backfill: the mentions check reads only
// what's new. `read(req)` reads and stores one page; `saved()` runs after the stream's state took that page (the gap
// bookkeeping, streamSteps). → nothing; the reads are the caller's.
async function readForward(steps, read, saved) {
  for (let step = steps.next(); !step.done && step.value.phase === "forward"; ) {
    const page = await read(step.value);
    step = steps.next(page);
    await saved();
  }
  steps.return();
}

// Posts that only explain a thread (what a post replies to or quotes): stored if new, NEVER overwriting a post someone's
// timeline stored (or its memberships): $setOnInsert. THE context writer: the context pass and live events both use
// it. `accountId` is whose read (or whose live event) brought them: X showed them to that account, so it joins the
// post's `seenBy` even when the post was already stored (a private account's post is drawn only for those it was shown
// to: services/accountData.js visibleTo). → the stored docs.
async function storeContext(posts, accountId) {
  if (!accountId) throw new Error("storeContext needs the account X returned the posts to");
  const docs = posts.map((p) => Post.fromApi(p));
  if (docs.length) await Post.bulkWrite(docs.map((doc) => ({ updateOne: { filter: { _id: doc._id }, update: { $setOnInsert: doc, $addToSet: { seenBy: accountId } }, upsert: true } })), { ordered: false });
  return docs;
}

// One stream as a sequence of page steps. Each call to next() reads ONE page.
function* streamSteps(x, state, key, kind, { floorId } = {}) {
  const s = state[key];

  // Forward: newer than what we have. X pages newest-first, so a pass cut
  // short (cap, 429) has read the top of the new posts and left a gap below
  // them. newestId only advances once the gap is closed; until then the pass
  // remembers what it read (gapTop = newest, gapUntil = oldest) and the next
  // run resumes BELOW gapUntil instead of re-reading from the top. Without
  // this, more new posts than one run's cap would be re-read forever.
  if (s.newestId) {
    let token;
    let top = s.gapTop || s.newestId;
    const untilId = s.gapUntil; // undefined = a fresh pass, starting from now
    do {
      const page = yield { phase: "forward", kind, sinceId: s.newestId, untilId, paginationToken: token };
      for (const p of page.posts) {
        if (newer(p.id, top)) top = p.id;
        if (older(p.id, s.gapUntil)) s.gapUntil = p.id;
      }
      s.gapTop = top;
      token = page.nextToken;
    } while (token);
    s.newestId = top;
    s.gapTop = undefined;
    s.gapUntil = undefined;
  }

  // Backfill: older than what we have, until X runs out, or, with a `floorId` (the Inbox without People: a week before
  // joining), until the floor (since_id). A stream that stopped at the floor reopens once there's no floor (People
  // turned on: its chosen depth, or X's limit, is the stop now).
  const reopen = s.floorReached && !floorId;
  if (!s.backfillDone || reopen) {
    let token;
    const untilId = s.oldestId; // undefined on the very first run = start from now
    do {
      const page = yield { phase: "backfill", kind, untilId, sinceId: floorId, paginationToken: token };
      for (const p of page.posts) {
        if (older(p.id, s.oldestId)) s.oldestId = p.id;
        if (newer(p.id, s.newestId)) s.newestId = p.id;
      }
      token = page.nextToken;
    } while (token);
    s.backfillDone = true;
    s.floorReached = !!floorId;
  }
}

// Which people need a profile lookup, kept in the given order (the account, then its leaderboard, then everyone
// else in its threads) so a capped run covers the top first: the account itself every run (its header's counts;
// X bills it once a day however often it's read), anyone never fetched, or older than the profile policy allows for
// their place (services/syncPrefs.js profileTtlMs: your top N, everyone else).
// `fetchedAt` is a Map of id → Date.
function profilesToFetch(rankedIds, fetchedAt, now, { prefs = PROFILES } = {}) {
  return rankedIds.filter((id, index) => {
    const at = fetchedAt.get(id);
    return !at || at.getTime() < now - profileTtlMs(index, prefs);
  });
}

// Which posts the context pass wants next: what each DRAWN post answers (replied_to) and quotes, minus what's stored.
// Drawn (`drawn(post)`, default every one) = in the account's conversations, where pages draw it with its quote card:
// a context post quotes too (a post you'd replied to, itself a quote, drew no quote card when only your own posts' and mentions' quotes were read). A post
// fetched AS a quote is a quote card, drawn alone, so it walks nothing (its own thread and quote were read before for
// nothing). Newest referencing post first, so a capped run fills recent threads first.
function contextToFetch(posts, have, drawn = () => true) {
  const want = new Set();
  const newestFirst = [...posts].sort((a, b) => (BigInt(a._id) < BigInt(b._id) ? 1 : -1));
  for (const p of newestFirst) {
    if (!drawn(p)) continue;
    for (const r of p.referenced || []) {
      if ((r.type === "replied_to" || r.type === "quoted") && !have.has(r.id)) want.add(r.id);
    }
  }
  return [...want];
}

// Fill `tally` as it goes so a capped run still reports what it did.
// The first round is everything stored in the account's threads (not just its own posts), so a chain a capped
// run left half-walked is picked up from wherever it stopped.
async function syncContext(x, accountId, tally) {
  const mine = await Post.find({ "accounts.id": accountId }, "conversationId").lean();
  const conversations = [...new Set(mine.map((p) => p.conversationId).filter(Boolean))];
  // Drawn: in one of the account's conversations (a parent is in its child's; a quote usually isn't: a card).
  const inThreads = new Set(conversations);
  const drawn = (p) => inThreads.has(p.conversationId);
  for (let round = await postsInConversations(accountId, conversations); ; ) {
    const refs = [...new Set(round.flatMap((p) => (p.referenced || []).map((r) => r.id)))];
    const have = new Set((await Post.find({ _id: { $in: refs } }, "_id").lean()).map((p) => p._id));
    const todo = contextToFetch(round, have, drawn);
    if (!todo.length) return;
    const fetched = [];
    for (let i = 0; i < todo.length; ) {
      // At least 1, so an exhausted cap throws ReadCapReached from the door.
      const batch = todo.slice(i, i + Math.max(1, Math.min(100, x.remainingContext())));
      const { posts, missing } = await x.postsByIds(batch);
      const docs = await storeContext(posts, accountId);
      // Only what X says doesn't exist becomes a placeholder (lib/x.js notFound). A post X won't show THIS account (a
      // protected author) is left unstored: a placeholder counts as "have" above, so the author's followers would never
      // fetch it. It's asked again next run (X bills only what it returns).
      const gone = missing.filter(notFound);
      if (gone.length) {
        await Post.bulkWrite(
          gone.map((m) => ({ updateOne: { filter: { _id: m.id }, update: { $setOnInsert: { gone: { title: m.title, detail: m.detail } } }, upsert: true } })),
          { ordered: false }
        );
      }
      fetched.push(...docs.map((d) => ({ ...d, stream: "context" })));
      tally.fetched += docs.length;
      tally.gone += gone.length;
      i += batch.length;
    }
    round = fetched;
  }
}

// Fill `tally` as it goes so a capped run still reports what it did.
// `selfOnly`: the account reads no conversations (Likes or Follows alone): just its own profile.
async function syncProfiles(x, accountId, tally, { prefs, selfOnly = false, circleSize }) {
  let ranked = [accountId];
  if (!selfOnly) {
    const posts = await accountPosts(accountId);
    const conversations = [...new Set(posts.map((p) => p.conversationId).filter(Boolean))];
    const threadPosts = await Post.find({ conversationId: { $in: conversations } }, "authorId referenced").lean();
    const inThreads = threadPosts.map((p) => p.authorId).filter(Boolean);
    // And whoever wrote a post the threads QUOTE, last: a quote card names its author (such cards used to read
    // "id <number>"; a quoted post sits in another conversation, so its author was never in the list).
    const quotedIds = [...new Set(threadPosts.flatMap((p) => (p.referenced || []).filter((r) => r.type === "quoted").map((r) => r.id)))];
    const quoted = quotedIds.length ? (await Post.find({ _id: { $in: quotedIds } }, "authorId").lean()).map((p) => p.authorId).filter(Boolean) : [];
    const board = leaderboard(posts, accountId);
    // THE CIRCLE's members (the closeness order: the likes on your posts count, services/circle.js), right after the
    // board: someone in it only by liking is on no board, and needs a profile for their face.
    const inCircle = circleMembers(board, circleSize, (await signalsFor(accountId)).likes.ofYou).map((r) => r.id);
    ranked = [...new Set([accountId, ...board.map((r) => r.id), ...inCircle, ...inThreads, ...quoted])];
    // A public circle follows the ranking (writes only when it's public and changed).
    await Account.keepCircle(accountId, inCircle);
  }
  // How fresh each person is FOR THIS ACCOUNT: when it last checked the pair (their follow status comes with the
  // profile, and only this account's own read says how they relate to it), else when anyone last read the profile.
  // So another account refreshing someone's shared profile doesn't leave this account's follow status stale.
  const [known, pairs] = await Promise.all([
    Person.find({ _id: { $in: ranked } }, "fetchedAt").lean(),
    Follow.find({ followeeId: accountId, followerId: { $in: ranked } }, "followerId checkedAt").lean(),
  ]);
  const freshness = new Map(known.map((p) => [p._id, p.fetchedAt]));
  for (const f of pairs) freshness.set(f.followerId, f.checkedAt);
  const todo = profilesToFetch(ranked, freshness, Date.now(), { prefs });
  tally.due = todo.length;

  // The account's own profile, when due, is read on its own (the Runs table says "your profile"); then everyone else.
  const groups = todo[0] === accountId ? [{ ids: [accountId], what: "self" }, { ids: todo.slice(1), what: "profiles" }] : [{ ids: todo, what: "profiles" }];
  for (const g of groups) {
    for (let i = 0; i < g.ids.length; ) {
      // At most 100 a request; at least 1, so an exhausted cap throws ReadCapReached from the door.
      const batch = g.ids.slice(i, i + Math.max(1, Math.min(100, x.remainingUsers())));
      await storeProfiles(await x.usersByIds(batch, { what: g.what }), tally, accountId);
      i += batch.length;
    }
  }
}

// ONE person's profile, re-read now (the refresh button beside a follower count: on a card, on their page). Its own
// metered unit, gated and charged like any other (the settings come from services/accounts.js syncSettings). X bills
// it once a day however often it's pressed. → { fetched, gone }
async function refreshProfile({ accountId, personId, getToken, ownerId = null, billing = null }) {
  const token = await getToken();
  return metered({ accountId, kind: "profile", label: "Profile refresh", billing }, async (meter) => {
    const tally = { fetched: 0, gone: 0 };
    await storeProfiles(await createClient({ token, meter, ownerId, readCap: 0, userCap: 1 }).usersByIds([personId]), tally, accountId);
    return tally;
  });
}

// One lookup's answer into Person, and each person's follow status with `viewerId` (the account whose token read
// them) into Follow (and the tally). THE place profiles a sync or a ↻ read are saved.
async function storeProfiles({ users, missing }, tally, viewerId) {
  const now = new Date();
  // Person.store also refreshes the header of any signed-in account among them (yours included).
  await Person.store(users, now);
  await Follow.record(viewerId, users, now);
  // Keep whatever we knew before; just record that X won't serve them now.
  if (missing.length) {
    await Person.bulkWrite(
      missing.map((m) => ({ updateOne: { filter: { _id: m.id }, update: { $set: { gone: { title: m.title, detail: m.detail }, fetchedAt: now } }, upsert: true } })),
      { ordered: false }
    );
  }
  tally.fetched += users.length;
  tally.gone += missing.length;
}

// A capped or rate-limited stop is a clean exit with progress saved;
// anything else is a real failure.
function stopReason(err) {
  if (err instanceof ReadCapReached) return err.ceiling ? err.message : `${err.message} (run again to continue)`;
  if (err.status === 429) return `rate limited by X${err.rateLimitReset ? ` until ${err.rateLimitReset.toLocaleTimeString()}` : ""} (progress saved)`;
  if (err.transient) return `X is having trouble (${err.message}); progress saved, the next pass continues`;
  throw err;
}

// Take the run lock, or null if another run holds it. The doc is created first (an upsert can't race the
// lock filter), then claimed atomically: only one caller's filter can match a free lock. `leaseMs`: how long it's
// held without a beat (deleting an account holds it for good: services/deleteAccount.js).
async function acquire(accountId, leaseMs = LEASE_MS) {
  await SyncState.updateOne({ _id: accountId }, { $setOnInsert: { lastRunAt: null } }, { upsert: true });
  const now = new Date();
  return SyncState.findOneAndUpdate(
    { _id: accountId, $or: [{ runningUntil: null }, { runningUntil: { $lt: now } }] },
    { $set: { runningUntil: new Date(now.getTime() + leaseMs) } },
    { returnDocument: "after" }
  );
}

// How far back this account's conversations are read (the Inbox and People share them), or null when neither is active
// (Likes or Follows alone read no timeline at all):
//   People with its history chosen — that depth (Account.history.budget, services/history.js)
//   the Inbox otherwise           — back to a week before joining (`floorId`, inbox.inboxStart: where the Inbox
//                                   starts), within X's own limits; People chosen later reads on from there
function depthFor(acct) {
  const budget = acct.history && acct.history.budget;
  if (active(acct, "people") && budget) return { budget };
  if (active(acct, "inbox")) return { budget: X_POST_LIMIT + X_MENTION_LIMIT, floorId: inboxStart({ joinedAt: firstOn(acct, "inbox") }) };
  return null;
}

// One sync run for one account. Returns a summary, or { skipped } when another run holds the lock, the account
// hasn't picked a module, it can't get a token (getToken throws an error with code NEEDS_REAUTH: it must sign in
// again), or its balance ran out (metered throws OUT_OF_BALANCE before the first read).
//
// What it reads follows the modules (services/features.js, docs/MODULES.md): the account's timeline, mentions, the
// posts around them and the people in them with the Inbox or People (depthFor); the profile tiers with People; the
// posts you like with People or Liking; who liked your replies with Likes. Every run reads the account's own profile
// (the header's counts).
//
// Depth: reading BACKWARDS stops at depthFor's budget (counted in SyncState.backfillRead across every run; that stream
// is then marked backfillDone + budgetReached) or floor. Reading FORWARDS (new posts) is never limited by it.
//
// byHand: the "Sync now" button (POST /sync); only the ledger's label differs.
//
// METERED: the run is one unit on the usage ledger (services/usage.js metered), opened after the lock and token and
// before the first read; every read records into it, the Likes extra's included. ownerId / billing come from
// services/accounts.js meterSettings (Owned-Read pricing, the charge on close).
async function runSync({ accountId, getToken, readCap, contextCap, userCap, extras = {}, byHand = false, ownerId = null, billing = null }) {
  const acct = await Account.findById(accountId, "history inboxFrom features tokens.scope live.subs createdAt circle.size pause balanceMicros").lean();
  if (!acct || !modulesOn(acct).length) return { accountId, skipped: "hasn't picked what to use" };
  // THE PAUSE (services/pause.js): held, nothing is read. Its balance back within a day of running out: the pause just
  // ends, and this run catches up as it always did.
  if (acct.pause && acct.pause.at) {
    const dry = !!(billing && billing.paused && billing.paused(acct));
    if (pause.held(acct, dry)) return { accountId, skipped: "paused" };
    if (acct.pause.why === "balance" && !dry) await pause.resumeQuietly(accountId);
  }
  const depth = depthFor(acct);
  return underLock(accountId, getToken, async (state, token) => {
    const result = await metered({ accountId, kind: "sync", label: byHand ? "Sync now" : "Sync", billing }, (meter) =>
      runPasses({ accountId, token, meter, ownerId, state, acct, depth, readCap, contextCap, userCap, extras })
    );
    // The Inbox tab's count: what came in adds likes and replies owed, your likes and replies read from X take some off
    // (services/inboxCount.js). Not the Likes tab's: only a live like counts there (services/likes.js TIMED), and the
    // likers check's finds never do.
    if (active(acct, "inbox")) await refreshOwedSafely(accountId);
    await LiveEvent.note(accountId, "sync"); // its open pages: the header's "Synced just now" (services/livePush.js)
    return result;
  });
}

// THE RUN LOCK around `fn(state, token)` (runSync, checkMentions): the account's SyncState claimed (acquire), kept while
// this process runs, its token, then released. → fn's result, or { skipped } when another run holds the lock, the
// account must sign in again (NEEDS_REAUTH), or the gate refused it (OUT_OF_BALANCE, services/usage.js metered).
async function underLock(accountId, getToken, fn) {
  const state = await acquire(accountId);
  if (!state) return { accountId, skipped: "another sync is running" };
  // Keep the lease while this process runs. A beat only extends a lock that's still held, so one landing after the
  // release below can't take it back.
  const stopBeat = heartbeat(() => SyncState.updateOne({ _id: accountId, runningUntil: { $ne: null } }, { $set: { runningUntil: new Date(Date.now() + LEASE_MS) } }));
  try {
    let token;
    try {
      token = await getToken();
    } catch (err) {
      if (err.code === "NEEDS_REAUTH") return { accountId, skipped: err.message };
      throw err;
    }
    return await fn(state, token);
  } catch (err) {
    if (err.code === "OUT_OF_BALANCE") return { accountId, skipped: err.message };
    throw err;
  } finally {
    stopBeat();
    await SyncState.updateOne({ _id: accountId }, { $unset: { runningUntil: 1 } });
  }
}

// THE MENTIONS CHECK: new mentions of the account, read FORWARD only, while someone has xtoolio open
// (services/mentionsCheck.js decides when). X's live stream doesn't push every reply that reaches you: post.reply.create
// is "Direct replies only (does not fire for replies to replies)", and post.mention.create "Does not fire for implicit
// mentions carried by replies" (docs.x.com, X Activity API), i.e. the "@them @you" X puts at the head of a reply further
// down your thread: 0 of 96 arrived live (docs/ACTIVITY-API.md). X's mentions FEED carries them. So: the mention
// stream's forward half under the sync's own lock and gap rules, what the new posts reply to or quote (one round; the
// sync's context pass walks the rest), the profiles of anyone new in them, then the open pages hear (announce) and the
// Inbox's count moves. Its own metered unit, gated and charged like a sync; one that read nothing leaves no row
// (`dropEmpty`: it runs every 30 s while a tab is open). → { added } or { skipped }
async function checkMentions({ accountId, getToken, readCap, contextCap, userCap, ownerId = null, billing = null }) {
  const acct = await Account.findById(accountId, "history features tokens.scope createdAt needsReauth pause balanceMicros resumedAt").lean();
  if (!acct || acct.needsReauth || !depthFor(acct)) return { accountId, skipped: "reads no conversations" };
  if (pause.held(acct, !!(billing && billing.paused && billing.paused(acct)))) return { accountId, skipped: "paused" }; // THE PAUSE
  const known = await SyncState.findById(accountId, "lastRunAt mention.newestId").lean();
  // Before the first read (or one just asked for) there's no "new" to read forward from: that read is the sync's.
  if (!known || !(known.mention && known.mention.newestId) || pullDue(acct, known)) return { accountId, skipped: "its first read isn't done" };

  return underLock(accountId, getToken, async (state, token) => {
    const fresh = [];
    let stop = "up to date";
    await metered({ accountId, kind: "sync", label: "Mentions check", billing, dropEmpty: true }, async (meter) => {
      const x = createClient({ token, meter, ownerId, readCap, contextCap, userCap });
      try {
        const steps = streamSteps(x, state, "mention", "mentions");
        await readForward(
          steps,
          async (req) => {
            const page = await x.timelinePage(accountId, "mentions", { ...req, maxResults: 100 });
            fresh.push(...(await store(page.posts, accountId, "mention")));
            return page;
          },
          async () => {
            state.markModified("mention");
            await state.save();
          }
        );
        if (!fresh.length) return;
        // What they answer or quote, so the card has it; the people in them we've never looked up.
        const docs = fresh.map((p) => Post.fromApi(p));
        const refs = [...new Set(docs.flatMap((d) => (d.referenced || []).map((r) => r.id)))];
        const have = new Set((await Post.find({ _id: { $in: refs } }, "_id").lean()).map((p) => p._id));
        const todo = contextToFetch(docs, have).slice(0, x.remainingContext());
        const context = todo.length ? await storeContext((await x.postsByIds(todo.slice(0, 100))).posts, accountId) : [];
        const authors = [...new Set([...docs, ...context].map((d) => d.authorId).filter(Boolean))];
        const looked = new Set((await Person.find({ _id: { $in: authors } }, "_id").lean()).map((p) => p._id));
        const unknown = authors.filter((id) => !looked.has(id)).slice(0, Math.min(100, x.remainingUsers()));
        if (unknown.length) await storeProfiles(await x.usersByIds(unknown), { fetched: 0, gone: 0 }, accountId);
      } catch (err) {
        stop = stopReason(err);
      }
    });
    for (const p of fresh) await announce(accountId, p, "mention");
    if (fresh.length) await refreshOwedSafely(accountId);
    return { accountId, added: fresh.length, stop };
  });
}

// THE HISTORY'S START, as an X id: the oldest post either stream has read back to (SyncState.own / .mention.oldestId).
// → id | null (nothing read yet). Pure.
function historyStartOf(state) {
  const ids = [state.own && state.own.oldestId, state.mention && state.mention.oldestId].filter(Boolean).map(BigInt);
  return ids.length ? String(ids.reduce((m, x) => (x < m ? x : m))) : null;
}

// The passes of one run, inside its metered unit (runSync holds the lock).
async function runPasses({ accountId, token, meter, ownerId, state, acct, depth, readCap, contextCap, userCap, extras }) {
  const { budget = 0, floorId } = depth || {};
  // READ FURTHER BACK (services/further.js), asked from Your circle: its first run reopens the streams that stopped at
  // the old depth (so the read cap below is sized to the rest). Without People there's no depth to deepen: it just ends.
  const askedFurther = acct.history && acct.history.further;
  if (askedFurther && !active(acct, "people")) state.furtherStage = "done";
  else if (askedFurther && !state.furtherStage) {
    further.begin(state);
    for (const k of further.STREAMS) state.markModified(k);
    await state.save();
  }
  const x = createClient({ token, meter, ownerId, readCap: depth ? runReadCap(readCap, budget, state, { floorId }) : 0, contextCap: depth ? contextCap : 0, userCap });

  // No conversations read (Likes or Follows alone): no streams, no context, and only the account's own profile.
  const streams = depth
    ? [
        { key: "own", kind: "tweets", label: "your posts", added: 0, read: 0 },
        { key: "mention", kind: "mentions", label: "mentions", added: 0, read: 0 },
      ]
    : [];
  // `forwardDone`: the stream's forward pass (everything newer than its bookmark) has run to its end, this run. THE
  // RESUME READ is over only then: a run that stopped on X's first page has read none of it.
  const pastForward = (st) => st.pending.done || st.pending.value.phase !== "forward";
  for (const st of streams) {
    st.steps = streamSteps(x, state, st.key, st.kind, { floorId });
    st.pending = st.steps.next();
    st.forwardDone = pastForward(st);
  }

  let postsStop = "up to date";
  try {
    // Round-robin one page at a time across the streams still running.
    let live = streams.filter((st) => !st.pending.done);
    while (live.length) {
      for (const st of live) {
        const req = st.pending.value;
        let size = pageShare(x.remainingPosts(), live.length);
        if (req.phase === "backfill") {
          size = backfillPageSize(size, budget - (state.backfillRead || 0));
          if (!size) {
            // The chosen depth is reached: this stream reads no further back, now or on any later run.
            st.steps.return();
            st.pending = { done: true };
            Object.assign(state[st.key], { backfillDone: true, budgetReached: true, floorReached: false });
            state.markModified(st.key);
            await state.save();
            continue;
          }
        }
        // Reading history (backward) makes this run onboarding, a bulk read: the bulk markup (services/balance.js).
        if (req.phase === "backfill") await meter.bulkRead("Your history");
        const page = await x.timelinePage(accountId, req.kind, { ...req, maxResults: size });
        st.read += page.posts.length;
        const fresh = await store(page.posts, accountId, st.key);
        st.added += fresh.length;
        // New posts read FORWARD are news to the open pages (a catch-up after X's stream was down, a reply X doesn't
        // push); history isn't.
        if (req.phase === "forward") for (const p of fresh) await announce(accountId, p, st.key);
        if (req.phase === "backfill") state.backfillRead = (state.backfillRead || 0) + page.posts.length;
        if (req.phase === "forward" && state.resume) state.resume.read = (state.resume.read || 0) + page.posts.length;
        st.pending = st.steps.next(page);
        st.forwardDone = pastForward(st);
        state.markModified(st.key);
        await state.save();
        // A page of history read (or of what a resume reads): an open progress page redraws its count (views/pulling.hbs;
        // the end of the run says "sync", which takes it on to the account's pages).
        if (req.phase === "backfill" || state.resume) await LiveEvent.note(accountId, "pull");
      }
      live = streams.filter((st) => !st.pending.done);
    }
  } catch (err) {
    postsStop = stopReason(err);
  }

  // Likes, in two halves (decision 1, docs/MODULES.md): the posts YOU like, with People ("You liked") or Liking (the ♥
  // knows what you've liked), looking back through all of them only for People; who liked YOUR replies, with the Likes
  // module. Its own client (own caps), same meter; a failure there is logged in the summary, never fails the sync.
  // RIGHT AFTER THE POSTS (once the posts are read, the likes start): a first read reconciles
  // your likes before the Inbox opens, and the progress page shows the two one after the other; the threads and people
  // after them need neither.
  // READ FURTHER BACK: the posts all in (both streams done going back) → your likes' look back reopens to the history's
  // new start, in this run's likes below.
  if (state.furtherStage === "posts") {
    further.afterPosts(state, { lookBack: active(acct, "people") });
    state.markModified("likes");
    await state.save();
  }

  let likes = null;
  const yours = active(acct, "people") || active(acct, "liking");
  if (yours || active(acct, "likes")) {
    try {
      // Live's like events on (subscribed): the likers check reads only replies a stream gap could have hidden.
      const likesLive = !!(acct.live && acct.live.subs && acct.live.subs.some((s) => s.eventType === "like.create"));
      // THE HISTORY'S START: the oldest of your posts and mentions it read. Your likes reconcile exactly to it
      // (extras.pastFloor; the Inbox, never older than the history, is covered).
      const floorId = historyStartOf(state);
      likes = await runLikes({ accountId, token, meter, ownerId, state, yours, lookBack: active(acct, "people"), likers: active(acct, "likes"), likesCap: extras.likesCap, likersUserCap: extras.likersUserCap, likesLive, floorId });
    } catch (err) {
      likes = { error: err.message };
    }
  }

  const context = { fetched: 0, gone: 0 };
  let contextStop = "up to date";
  if (depth) {
    try {
      await syncContext(x, accountId, context);
    } catch (err) {
      contextStop = stopReason(err);
    }
  }

  // Profiles: everyone in the conversations, at People's chosen freshness; with the Inbox alone, each person looked up
  // once (no tiers: those are People's). Without either, just the account's own.
  const profiles = { due: 0, fetched: 0, gone: 0 };
  let profilesStop = "up to date";
  try {
    await syncProfiles(x, accountId, profiles, { prefs: active(acct, "people") ? PROFILES : LOOKED_UP_ONCE, selfOnly: !depth, circleSize: acct.circle && acct.circle.size });
  } catch (err) {
    profilesStop = stopReason(err);
  }

  // Follows: nothing here. The Follows tab is what X's stream sends, best effort (the follower check that
  // compared X's count with the events and offered a priced "Find out who" read was deleted: the Follows tab is best
  // effort, and the bulk operations are offered only on Not following back).

  // THE RESUME READ is over once every stream read forward to its end this run (to the moment chosen) and your likes
  // are reconciled to it (none to reconcile without People or Liking: services/pause.js): the Inbox opens. Until
  // then it stays, and the next run carries on where this one stopped (sized to it: runReadCap), as an interrupted
  // first read does.
  if (state.resume) {
    if (!yours) state.resume.likesDone = true;
    if (streams.every((st) => st.forwardDone) && state.resume.likesDone) state.resume = undefined;
  }

  // READ FURTHER BACK: your likes reconciled to the new start → done: the ask goes, and the Inbox's start moves back
  // when it was asked to (runSync recounts the Inbox right after).
  further.afterLikes(state);
  if (state.furtherStage === "done") {
    await further.finish(acct, state);
    state.furtherStage = undefined;
  }

  state.lastRunAt = new Date();
  await state.save();

  return {
    accountId,
    streams: streams.map((st) => ({ label: st.label, read: st.read, added: st.added, complete: !!state[st.key].backfillDone, budgetReached: !!state[st.key].budgetReached })),
    backfill: { read: state.backfillRead || 0, budget },
    postsStop,
    context,
    contextStop,
    profiles,
    profilesStop,
    likes,
    usage: { ...x.usage },
  };
}

// The one-line version, for the scheduler's log.
function summaryLine(r, label = r.accountId) {
  if (r.skipped) return `sync ${label} skipped: ${r.skipped}`;
  const added = r.streams.map((s) => `${s.added} new ${s.label}`).join(", ");
  const likes = !r.likes ? "" : r.likes.error ? `; likes failed: ${r.likes.error}` : `; likes: ${r.likes.yourLikes} new of yours${r.likes.likesBack && !r.likes.likesBack.done ? ` (looking back: ${r.likes.likesBack.read} read)` : ""}, ${r.likes.likers} likers on ${r.likes.likersChecked} replies${r.likes.stop !== "up to date" ? ` (${r.likes.stop})` : ""}`;
  return `sync ${label}: ${added}; ${r.context.fetched} context; ${r.profiles.fetched} profiles; ${r.usage.posts} posts + ${r.usage.users} users read${likes}`;
}

module.exports = { runSync, historyStartOf, checkMentions, refreshProfile, acquire, summaryLine, streamSteps, readForward, pageShare, backfillPageSize, runReadCap, profilesToFetch, contextToFetch, syncContext, store, storeContext, storeProfiles, announce };
