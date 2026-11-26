// Live: X pushes what happens (replies, mentions, your posts, likes) and xtoolio stores it within seconds. docs/LIVE.md
// is the design and ACTIVITY-API.md the spike's evidence. Sync stays as the catch-up (history, thread context,
// profiles, anything sent while nobody was connected: pay-per-use can't backfill the stream).
//
// Runs in the worker (app.js, where the scheduler runs, when config.x.bearerToken is set):
//   • THE stream: one connection for the app (lib/x.js activityStream), every account's events on it, reconnecting
//     forever; its health in LiveState (the header reads it).
//   • ingest: each event stored through the SAME writers sync uses (sync.store, sync.storeContext, Person.store,
//     extras.yourLikeOp / likerOp, Follow.fromEvent; a follow event is also a FollowEvent row, the Follows page), and
//     what X billed noted in LivePending.
//   • subscriptions: per account, made with ITS token, kept equal to desiredSubs (ensureSubs; the rules, pure, are
//     services/liveRules.js). Anything that changes
//     the desired set sets `Account.live.due` in its own write (sign-in, an extra on or off, history chosen, X refusing
//     the token); the worker watches accounts (a change stream) and ensures within seconds. An hourly pass ensures
//     every account too (a pause or top-up, a missed flag) and turns LivePending into ledger units (flushPending).
"use strict";

const crypto = require("crypto");
const config = require("../config");
const Account = require("../models/Account");
const Like = require("../models/Like");
const Person = require("../models/Person");
const LiveState = require("../models/LiveState");
const LiveGap = require("../models/LiveGap");
const LivePending = require("../models/LivePending");
const LiveEvent = require("../models/LiveEvent");
const { activity, activityStream, eventContents } = require("../lib/x");
const { heartbeat } = require("../lib/heartbeat");
const { stopping } = require("../lib/shutdown");
const { accessToken, meterSettings } = require("./accounts");
const pause = require("./pause");
const { metered, firstToday } = require("./usage");
const { store, storeContext, announce } = require("./sync");
const { refreshOwedSafely } = require("./inboxCount");
const { refreshUnseenSafely } = require("./unseenCount");
const { TAG, EVENT, directionOf, desiredSubs, diffSubs, likeOpFor, repostOpFor, followEventFor } = require("./liveRules");
const Repost = require("../models/Repost");
const Follow = require("../models/Follow");
const FollowEvent = require("../models/FollowEvent");

// Make X's subscriptions for this account match desiredSubs. Its own token when it has one; else (X refused it) the
// app's Bearer token, which can still list and delete, so a signed-out account stops receiving (and costing).
const ensuring = new Set();
async function ensureSubs(accountId) {
  if (ensuring.has(accountId)) return;
  ensuring.add(accountId);
  try {
    // Claim the flag first: one set again while this runs is a new change, and the watcher sees it.
    const account = await Account.findOneAndUpdate({ _id: accountId }, { $unset: { "live.due": "" } }, { projection: "username tokens.scope needsReauth history features balanceMicros pause live.subs", returnDocument: "after" }).lean();
    if (!account) return;
    // Out of balance, or HELD (THE PAUSE, services/pause.js): no subscriptions, so X delivers and bills nothing.
    const dry = meterSettings().billing.paused(account);
    const want = desiredSubs(account, { paused: dry || pause.held(account, dry) });
    const token = await accessToken(accountId).catch(() => null);
    const auth = token || config.x.bearerToken;
    // X allows ONE subscription per event type per user (a second is refused with a 400, seen).
    const have = (await activity.list(auth, accountId)).filter((s) => s.tag === TAG);
    const { keep, create, remove } = diffSubs(have, want, (account.live && account.live.subs) || []);
    for (const s of remove) await activity.unsubscribe(auth, s.subscription_id);
    if (create.length && !token) throw new Error("no usable token to subscribe with (sign in again)");
    const made = [];
    for (const eventType of create) made.push(await activity.subscribe(token, { eventType, userId: accountId, tag: TAG, direction: directionOf(eventType) }));
    const subs = [...keep, ...made].map((s) => ({ eventType: s.event_type, id: s.subscription_id, ...(directionOf(s.event_type) && { direction: directionOf(s.event_type) }) }));
    await Account.updateOne({ _id: accountId }, { $set: { "live.subs": subs, "live.ensuredAt": new Date() }, $unset: { "live.error": "" } });
    if (create.length || remove.length) console.log(`[live] @${account.username}: ${subs.map((s) => s.eventType).join(", ") || "no subscriptions"} (+${create.length} −${remove.length})`);
  } catch (err) {
    console.error(`[live] subscriptions for ${accountId}: ${err.message}`);
    await Account.updateOne({ _id: accountId }, { $set: { "live.error": String(err.message).slice(0, 300), "live.ensuredAt": new Date() } }).catch(() => {});
  } finally {
    ensuring.delete(accountId);
  }
}

// Every subscription of this account's on X, gone (deleting an account, services/deleteAccount.js). With the APP's
// Bearer token, which lists and deletes any user's (ensureSubs' fallback), so it runs AFTER the grant is revoked: from
// then on nothing (a concurrent ensureSubs) can subscribe again. → how many went. Throws when X can't be asked; the
// caller stops before deleting anything, rather than leave X sending (and billing) events for an account that's gone.
async function dropSubs(accountId) {
  if (!config.x.bearerToken) return 0; // no Live on this deployment, so nothing was ever subscribed
  const have = (await activity.list(config.x.bearerToken, accountId)).filter((s) => s.tag === TAG);
  for (const s of have) await activity.unsubscribe(config.x.bearerToken, s.subscription_id);
  return have.length;
}

// What X billed for an event, onto the ledger at the next flush (a duplicate delivery is the same row: only the
// delivery that inserts it counts, so a reload's two streams delivering one event bill it once here).
// EVERY DELIVERED EVENT IS BILLED (a one-off audit against X's balance): X says events are "billed per
// event delivered", and they are: never skipped because the same post was read earlier that UTC day (the ledger once
// priced those as $0, which the audit corrected; this was before any account was charged). Billed on every delivery,
// plus like events at their price (lib/pricing.js likeEvent), the ledger matches X's daily spend closely; a day with
// many restarts runs higher (two connections at once can each deliver, and bill, the same event). The delivery still MARKS
// the post read today (firstToday), so a sync reading it later that day stays $0, as the same fit supports.
async function notePending(accountId, ev, resourceId, now = new Date()) {
  const pending = { accountId, what: ev.what, resourceId };
  const r = await LivePending.updateOne(pending, { $setOnInsert: { cls: ev.cls, at: now } }, { upsert: true });
  if (r.upsertedCount) await firstToday(ev.resource, [resourceId], now);
}

// How close two follow events of one person, one way, must be to be one (ingest: X sent one unfollow twice).
const FOLLOW_ECHO_MS = 10 * 1000;

// One event from the stream into the store, through sync's own writers. An event for an account xtoolio doesn't have
// (deleted since) is dropped. → what it stored, for the log.
async function ingest(data) {
  const ev = EVENT.get(data.event_type);
  const accountId = data.filter && data.filter.user_id;
  if (!ev || !accountId || !(await Account.exists({ _id: accountId }))) return null;
  const { posts, users } = eventContents(data);
  const now = new Date();
  // Events carry everyone's profile: a free refresh, except your own counts (X's snapshot from some moment; a follow
  // moves them by flipping its pair below, models/Follow.js fromEvent).
  if (users.length) await Person.store(users, now, { counts: false });
  let resourceId;
  if (ev.kind) {
    const [post, ...context] = posts;
    if (!post) return null;
    const fresh = await store([post], accountId, ev.kind);
    if (context.length) await storeContext(context, accountId);
    resourceId = post.id;
    // The open pages hear of it (services/sync.js announce), once: a duplicate delivery, or a post the mentions check
    // or a sync stored first, isn't news again.
    if (fresh.length) await announce(accountId, post, ev.kind);
    // The Inbox tab's count (services/inboxCount.js): theirs adds what you owe, yours (a reply made on X) answers some.
    await refreshOwedSafely(accountId);
  } else if (ev.resource === "follow") {
    // Someone following or unfollowing the account, or the account following someone: the event row (the Follows
    // page), the pair's state as of then (models/Follow.js), and the open pages.
    const row = followEventFor(data, accountId);
    if (!row) return null;
    // The same person, the same way, within FOLLOW_ECHO_MS of one already stored is that one again (an
    // unfollow arrived as TWO events, two event_uuids, created_at 18 ms apart, and the Follows page listed it twice;
    // most likely a restart's two workers each connected for a moment, unverified). Not stored, shown or counted; still
    // on the ledger below (X billed it). Two deliveries landing at the very same moment can still both pass.
    const echo = await FollowEvent.exists({ accountId, personId: row.personId, direction: row.direction, kind: row.kind, _id: { $ne: row._id }, at: { $gte: new Date(row.at.getTime() - FOLLOW_ECHO_MS), $lte: new Date(row.at.getTime() + FOLLOW_ECHO_MS) } });
    if (!echo) {
      const fresh = await FollowEvent.updateOne({ _id: row._id }, { $setOnInsert: row }, { upsert: true });
      const [follower, followee] = row.direction === "in" ? [row.personId, accountId] : [accountId, row.personId];
      await Follow.fromEvent(follower, followee, row.kind === "follow", row.at);
      if (fresh.upsertedCount) {
        await LiveEvent.note(accountId, "follow", { eventId: row._id, toYou: row.direction === "in" });
        if (row.direction === "in") await refreshUnseenSafely(accountId, "follows");
      }
    }
    resourceId = row._id;
  } else if (ev.row === "repost") {
    // Someone reposted your post: a Repost (models/Repost.js), the original kept as context so the Likes row has words
    // to show, never the repost itself (liveRules EVENTS). The Likes page and its tab's count, as a like on your post.
    const op = repostOpFor(data, accountId);
    if (!op) {
      console.error(`[live] post.repost.create for ${accountId}: unreadable payload (keys ${Object.keys(data.payload || {}).join(",")}; includes ${Object.keys(data.includes || {}).join(",")})`);
      return null;
    }
    const original = posts.filter((p) => p.id === op.updateOne.filter.postId);
    if (original.length) await storeContext(original, accountId);
    const r = await Repost.bulkWrite([op], { ordered: false });
    if (r.upsertedCount) {
      const likes = await refreshUnseenSafely(accountId, "likes", { quiet: true });
      await LiveEvent.note(accountId, "repost", { postId: op.updateOne.filter.postId, ...(typeof likes === "number" && { likes }) });
    }
    resourceId = data.payload.id;
  } else {
    if (posts.length) await storeContext(posts, accountId); // the liked post, so the like has something to show on
    const op = likeOpFor(data.payload, accountId);
    if (op) {
      await Like.bulkWrite([op], { ordered: false });
      // On one of your posts (not your own like): the Likes page's news, and its tab's count, which rides IN the like
      // event (`likes`), not a separate "count" event: a page with that post on it watched the like arrive (it marks it
      // viewed, /posts/viewed), so it leaves the sidebar's number alone; any other page takes it. Two events made the
      // badge light up and go out again on the page you were reading (a badge must never flash).
      const toYou = op.updateOne.filter.likerId !== accountId;
      const likes = toYou ? await refreshUnseenSafely(accountId, "likes", { quiet: true }) : null;
      await LiveEvent.note(accountId, "like", { postId: op.updateOne.filter.postId, toYou, ...(typeof likes === "number" && { likes }) });
      if (!toYou) await refreshOwedSafely(accountId); // your like, made on X: the Inbox's count of likes owed
    }
    resourceId = data.payload && data.payload.id;
  }
  if (resourceId) await notePending(accountId, ev, resourceId, now);
  await LiveState.updateOne({ _id: "stream" }, { $set: { lastEventAt: now } });
  return `${ev.type} for ${accountId}`;
}

// Each account's pending live events as ONE short metered unit ("Live", as the header's "● Live"; formerly "Live from
// X"), charged through billing like any unit
// (at X's prices, as every unit is). The gate refusing an account leaves its rows for later and flags its
// subscriptions for removal.
async function flushPending() {
  const accounts = await LivePending.distinct("accountId");
  for (const accountId of accounts) {
    const rows = await LivePending.find({ accountId }).lean();
    if (!rows.length) continue;
    try {
      await metered({ accountId, kind: "live", label: "Live", billing: meterSettings().billing }, async (meter) => {
        const groups = new Map();
        for (const r of rows) {
          const key = `${r.what}\n${r.cls}`;
          groups.set(key, [...(groups.get(key) || []), r]);
        }
        for (const [key, group] of groups) {
          const [what, cls] = key.split("\n");
          await meter.recordCounted(what, cls, group.length, group.length); // every delivered event is billed (notePending)
        }
      });
      await LivePending.deleteMany({ _id: { $in: rows.map((r) => r._id) } });
    } catch (err) {
      if (err.code === "OUT_OF_BALANCE") await Account.updateOne({ _id: accountId }, { $set: { "live.due": true } });
      else console.error(`[live] ledger for ${accountId}: ${err.message}`);
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A connection beats every 30 s (lib/heartbeat.js): more than this since the last one is a gap worth recording.
const GAP_MIN_MS = 75 * 1000;
// After X closes the stream or it fails: 20 s while a subscription change is provisioning (X's own "try again in a
// minute"), else growing waits so an outage isn't hammered.
const BACKOFF_MS = [5000, 10000, 30000, 60000];

const setState = (update) => LiveState.updateOne({ _id: "stream" }, update, { upsert: true }).catch((e) => console.error(`[live] state: ${e.message}`));

// THE stream, until stopStream(): connect, ingest every event in order, reconnect. Its health goes to LiveState:
// `connectedAt` and a beat every 30 s while connected (lib/heartbeat.js), `connectedAt` cleared when it drops, by THIS
// connection only (`connId`): during a restart the new worker's connection opens before the old one closes (X allows
// both, a spike), and the old one's goodbye mustn't mark the stream down under the new one (the "● Live" pill
// would go, and the likers check would read it as an outage and pay to re-read likers).
let streamAbort = null;
let streamStopped = false;
async function runStream({ onFirstOpen } = {}) {
  let failures = 0;
  let opened = false;
  while (!streamStopped) {
    let stopBeat = null;
    let wait;
    const connId = crypto.randomBytes(6).toString("hex");
    // The last beat of the connection before this one (this process's, the worker it's taking over from, or one that
    // died): the gap starts there.
    const before = await LiveState.findById("stream", "beatAt").lean().catch(() => null);
    streamAbort = new AbortController();
    try {
      const onOpen = () => {
        console.log("[live] stream connected");
        const lastBeat = before && before.beatAt;
        if (lastBeat && Date.now() - lastBeat.getTime() > GAP_MIN_MS) {
          LiveGap.create({ from: lastBeat, to: new Date() }).catch((e) => console.error(`[live] recording a gap: ${e.message}`));
        }
        setState({ $set: { connectedAt: new Date(), beatAt: new Date(), connId } });
        stopBeat = heartbeat(() => setState({ $set: { beatAt: new Date() } }));
        failures = 0;
        if (!opened && onFirstOpen) onFirstOpen();
        opened = true;
        // Whatever X sent while nobody was connected (a restart, a deploy, an outage) is gone from the stream: a sync
        // reads it now rather than at the next tick (services/scheduler.js catchUp; it waits for this worker's turn).
        require("./scheduler").catchUp().catch((e) => console.error(`[live] catch-up: ${e.message}`));
      };
      for await (const data of activityStream(config.x.bearerToken, { onOpen, signal: streamAbort.signal })) {
        await ingest(data).catch((e) => console.error(`[live] ingest ${data.event_type}: ${e.message}`));
      }
      console.log("[live] X closed the stream; reconnecting");
      wait = BACKOFF_MS[0];
    } catch (err) {
      if (streamStopped) break;
      setState({ $set: { lastError: String(err.message).slice(0, 300), lastErrorAt: new Date() } });
      if (err.provisioning) wait = 20000;
      else {
        console.error(`[live] stream: ${err.message}`);
        wait = BACKOFF_MS[Math.min(failures++, BACKOFF_MS.length - 1)];
      }
    } finally {
      if (stopBeat) stopBeat();
      await LiveState.updateOne({ _id: "stream", connId }, { $unset: { connectedAt: "", connId: "" } }).catch((e) => console.error(`[live] state: ${e.message}`));
    }
    if (!streamStopped) await sleep(wait);
  }
}
// The restart's last step (app.js): close this worker's connection, after its successor's is open.
async function stopStream() {
  streamStopped = true;
  if (streamAbort) streamAbort.abort();
  // Its finally clears this connection's mark; give it a moment.
  await sleep(300);
}

// Every account whose live.due is set gets ensured: a change stream on accounts (the web process sets the flag in
// the same write as the change that needs it). Reopened if it fails; closed by stopDuties.
let accountsWatch = null;
let dutiesStopped = false;
function watchAccounts() {
  const open = () => {
    if (dutiesStopped) return;
    const changes = Account.watch([{ $match: { operationType: { $in: ["insert", "update", "replace"] } } }], { fullDocument: "updateLookup" });
    accountsWatch = changes;
    changes.on("change", (c) => {
      const doc = c.fullDocument;
      if (doc && doc.live && doc.live.due) ensureSubs(doc._id);
    });
    changes.on("error", (err) => {
      if (dutiesStopped || stopping()) return;
      console.error(`[live] watching accounts: ${err.message}; reopening in 5 s`);
      changes.close().catch(() => {});
      setTimeout(open, 5000);
    });
  };
  open();
}

// Every account, made to match (on boot, then hourly beside the ledger flush): X is the truth, so a crash mid-change,
// a pause, a top-up or a flag set while nobody watched all heal here.
async function ensureAll() {
  for (const a of await Account.find({}, "_id").lean()) await ensureSubs(a._id);
}

const HOUR_MS = 3600 * 1000;
const enabled = () => !!config.x.bearerToken;

// Two halves (app.js), so a restart has no gap: the STREAM starts at once, beside the old worker's (`onFirstOpen`: X
// accepted it, the moment the old worker may be told to stop), and the DUTIES (the accounts watch, the hourly ensure +
// ledger flush) start only once this worker holds the "worker" lease, i.e. the old one has stopped its own.
function startStream({ onFirstOpen } = {}) {
  if (!enabled()) {
    console.log("live: off (no X_BEARER_TOKEN): sync alone");
    if (onFirstOpen) onFirstOpen();
    return;
  }
  runStream({ onFirstOpen });
  console.log("live: X's activity stream (replies, mentions, your posts, likes, follows)");
}
let hourlyTimer = null;
function startDuties() {
  if (!enabled()) return;
  watchAccounts();
  const hourly = async () => {
    if (dutiesStopped) return;
    await ensureAll().catch((e) => console.error(`[live] ensuring subscriptions: ${e.message}`));
    await flushPending().catch((e) => console.error(`[live] ledger flush: ${e.message}`));
  };
  hourly();
  hourlyTimer = setInterval(hourly, HOUR_MS);
  hourlyTimer.unref();
}
async function stopDuties() {
  dutiesStopped = true;
  if (hourlyTimer) clearInterval(hourlyTimer);
  if (accountsWatch) await accountsWatch.close().catch(() => {});
}

module.exports = { ingest, notePending, ensureSubs, dropSubs, flushPending, startStream, startDuties, stopDuties, stopStream };
