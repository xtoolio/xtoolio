// services/deleteAccount.js — DELETING AN ACCOUNT, whole (a full delete, with cascade):
// Settings' Delete account (POST /account/delete, routes/account.js), the ONLY way an account is deleted: self-serve,
// never by request (no "delete by DM" anywhere, Terms and Privacy included). ONE list, CASCADE, is
// what an account owns; planFor counts it and the delete removes it (scripts/verify-delete.js checks both).
//
// What stays, by design (Privacy says so): PUBLIC X content in the SHARED store. Posts read as thread context (no
// account's feed) and public profiles (Person) are kept once for every account (models/Post.js `accounts`); another
// account's conversations may show them. Your own feeds' posts (your timeline, your mentions) are deleted unless
// another account's own feed has them too, and then only your membership goes. A follow pair (Follow) is a fact about
// two people, shown to both: it's deleted unless the other one is still an account here. Likes, reposts and follow
// events another account recorded about YOU (you liked their post) are theirs and stay.
//
// The order is what makes it safe against everything else running:
//   1. THE RUN LOCK, held for good (sync.acquire with a long lease): no sync, Sync now or mentions check starts, and a
//      running one is waited for (they take seconds; LOCK_WAIT_MS). Busy past that: nothing is touched, try again.
//   2. X: the grant revoked (accounts.revokeGrant: nothing can mint a token or subscribe again), then every live
//      subscription deleted (live.dropSubs, the app's token). X unreachable: stop here, nothing deleted yet.
//   3. Stripe: the customer deleted (its saved card goes; Stripe keeps its invoices and receipts, as the law needs).
//   4. The Account doc FIRST: every door (pages, presses, /mcp, the scheduler, Live's ingest) looks the account up
//      and finds nothing from here on. Then the rest of CASCADE, posts last (a live event ingested in the instant
//      before step 4 would have added its membership by then).
// After step 4 there's no going back (the Account doc is gone, so nobody can press Delete again), so each step of the
// rest is RETRIED (STEP_TRIES, a database blip) and every step runs even if one before it failed; one that still fails
// is logged "[delete] … NOT deleted" with the account id, for the operator to clear from the log.
"use strict";

const mongoose = require("mongoose");
const Account = require("../models/Account");
const SyncState = require("../models/SyncState");
const Post = require("../models/Post");
const Like = require("../models/Like");
const Repost = require("../models/Repost");
const Follow = require("../models/Follow");
const FollowEvent = require("../models/FollowEvent");
const TagRead = require("../models/TagRead");
const InboxMark = require("../models/InboxMark");
const InboxUndo = require("../models/InboxUndo");
const Draft = require("../models/Draft");
const Feedback = require("../models/Feedback");
const FeedbackShot = require("../models/FeedbackShot");
const AgentToken = require("../models/AgentToken");
const AgentGrant = require("../models/AgentGrant");
const OAuthClient = require("../models/OAuthClient");
const OAuthRequest = require("../models/OAuthRequest");
const UsageEntry = require("../models/UsageEntry");
const BalanceEntry = require("../models/BalanceEntry");
const LiveEvent = require("../models/LiveEvent");
const LivePending = require("../models/LivePending");
const Presence = require("../models/Presence");
const Waitlist = require("../models/Waitlist");
const WaitlistDm = require("../models/WaitlistDm");
const InviteCode = require("../models/InviteCode");
const RateWindow = require("../models/RateWindow");
const HandleEstimate = require("../models/HandleEstimate");

const LOCK_WAIT_MS = 30 * 1000; // a sync that finds something takes ~3–22 s (p50 / p90)
const HELD_FOR_GOOD_MS = 24 * 60 * 60 * 1000; // the lock's lease once deleting: the SyncState doc goes with the rest

// A raw collection, for the ones with no model: the session store's, and two left from removed features.
const raw = (name) => mongoose.connection.db.collection(name);

// The follow pairs to delete: this account on either end, unless the other end is still an account (it's theirs too).
async function pairFilter(id) {
  const edges = await Follow.find({ $or: [{ followerId: id }, { followeeId: id }] }, "followerId followeeId").lean();
  const others = [...new Set(edges.map((e) => (e.followerId === id ? e.followeeId : e.followerId)))];
  const members = new Set((await Account.find({ _id: { $in: others, $ne: id } }, "_id").lean()).map((a) => a._id));
  return { _id: { $in: edges.filter((e) => !members.has(e.followerId === id ? e.followeeId : e.followerId)).map((e) => e._id) } };
}

// Apps (claude.ai, ChatGPT…) that registered only to connect to this account: no other account approved them.
async function clientFilter(id) {
  const mine = (await AgentGrant.find({ accountId: id }, "clientId").lean()).map((g) => g.clientId);
  const shared = new Set(await AgentGrant.distinct("clientId", { clientId: { $in: mine }, accountId: { $ne: id } }));
  return { _id: { $in: mine.filter((c) => !shared.has(c)) } };
}

// THE CASCADE: [label, how to count, how to delete], every place an account's data lives (models/*, the session
// store, and the old `follows` / `conversationmarks` collections left from removed features). A new model keyed by an
// account joins this list in the same commit (verify-security fails on a model with an `accountId` field this file
// doesn't require; one keyed by `_id` = the account, as SyncState, Presence and RateWindow are, it can't see).
const CASCADE = [
  ["follow pairs", async (id) => Follow.countDocuments(await pairFilter(id)), async (id) => Follow.deleteMany(await pairFilter(id))],
  ["apps registered only for you", async (id) => OAuthClient.countDocuments(await clientFilter(id)), async (id) => OAuthClient.deleteMany(await clientFilter(id))],
  ...[
    ["agent connections (apps)", AgentGrant],
    ["agent connections (tokens)", AgentToken],
    ["agent sign-ins in progress", OAuthRequest],
    ["drafts", Draft],
    ["feedback you sent", Feedback],
    ["feedback screenshots", FeedbackShot],
    ["Inbox marks", InboxMark],
    ["Inbox undos", InboxUndo],
    ["likes", Like],
    ["reposts", Repost],
    ["follow events", FollowEvent],
    ["who-they-tag reads", TagRead],
    ["live updates", LiveEvent],
    ["live events not yet billed", LivePending],
    ["usage records", UsageEntry],
    ["balance records", BalanceEntry],
  ].map(([label, Model]) => [label, (id) => Model.countDocuments({ accountId: id }), (id) => Model.deleteMany({ accountId: id })]),
  ["old follow snapshots", (id) => raw("follows").countDocuments({ accountId: id }), (id) => raw("follows").deleteMany({ accountId: id })],
  ["old conversation marks", (id) => raw("conversationmarks").countDocuments({ accountId: id }), (id) => raw("conversationmarks").deleteMany({ accountId: id })],
  ["rate-limit windows", (id) => RateWindow.countDocuments({ _id: { $regex: `^${id} ` } }), (id) => RateWindow.deleteMany({ _id: { $regex: `^${id} ` } })],
  ["presence", (id) => Presence.countDocuments({ _id: id }), (id) => Presence.deleteMany({ _id: id })],
  ["waitlist place", (id) => Waitlist.countDocuments({ _id: id }), (id) => Waitlist.deleteMany({ _id: id })],
  ["waitlist DM", (id) => WaitlistDm.countDocuments({ _id: id }), (id) => WaitlistDm.deleteMany({ _id: id })],
  ["your invite link", (id) => InviteCode.countDocuments({ accountId: id }), (id) => InviteCode.deleteMany({ accountId: id })],
  // Signed up through someone else's link: their place stays taken, but who took it is forgotten.
  ["you, on the invite link you came through", (id) => InviteCode.countDocuments({ "used.id": id }), (id) => InviteCode.updateMany({ "used.id": id }, { $set: { "used.$[u].id": null, "used.$[u].username": null } }, { arrayFilters: [{ "u.id": id }] })],
  // connect-mongo keeps each session as a JSON string; a signed-in one carries "accountId":"<id>" (ids are digits).
  ["signed-in sessions", (id) => raw("sessions").countDocuments({ session: { $regex: `"accountId":"${id}"` } }), (id) => raw("sessions").deleteMany({ session: { $regex: `"accountId":"${id}"` } })],
  ["sync state", (id) => SyncState.countDocuments({ _id: id }), (id) => SyncState.deleteMany({ _id: id })],
  // Posts LAST (the header comment, step 4): only yours → deleted; also someone else's feed's → your membership pulled.
  ["posts only your feeds had", (id) => Post.countDocuments({ "accounts.id": id, "accounts.1": { $exists: false } }), (id) => Post.deleteMany({ "accounts.id": id, "accounts.1": { $exists: false } })],
  ["posts shared with another account (yours unlinked)", (id) => Post.countDocuments({ "accounts.id": id, "accounts.1": { $exists: true } }), (id) => Post.updateMany({ "accounts.id": id }, { $pull: { accounts: { id } } })],
];

// What deleting this account would remove, by CASCADE's own counts (scripts/verify-delete.js reads it before and after
// a delete). → [{ label, n }]
async function planFor(accountId) {
  const id = String(accountId);
  const account = await Account.findById(id, "username").lean();
  const rows = [{ label: "the account", n: account ? 1 : 0 }];
  if (account) rows.push({ label: "its front-page estimate", n: await HandleEstimate.countDocuments({ _id: account.username.toLowerCase() }) });
  for (const [label, count] of CASCADE) rows.push({ label, n: await count(id) });
  return rows;
}

class DeleteRefused extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// The real X / Stripe / owner steps (a test passes its own). Lazy: they read config.
function realDeps() {
  const { isOwner, revokeGrant } = require("./accounts");
  return { isOwner, revokeGrant, dropSubs: require("./live").dropSubs, forgetCustomer: require("./billing").forgetCustomer };
}

// Delete it. `deps` (default realDeps; a test passes stubs so it runs without X or Stripe):
//   isOwner(id), revokeGrant(id) → bool, dropSubs(id) → n, forgetCustomer(account) → bool
// → { username, revoked, subs, stripe, removed: [{ label, n }] }. Throws DeleteRefused: "owner" (the app's own
// account pays X and reads its balance: never deleted here), "busy" (a sync held the lock past LOCK_WAIT_MS), "x" (X
// couldn't be asked to drop the subscriptions), "gone" (no such account).
async function deleteAccount(accountId, { deps = realDeps(), log = () => {}, waitMs = LOCK_WAIT_MS } = {}) {
  const id = String(accountId);
  const { acquire } = require("./sync"); // lazy: sync.js pulls in most of services/
  if (deps.isOwner(id)) throw new DeleteRefused("owner", "The app owner's account can't be deleted: it pays X and reads its balance.");
  const account = await Account.findById(id, "username stripeCustomerId").lean();
  if (!account) throw new DeleteRefused("gone", "No such account.");

  // 1. The lock, for good.
  const until = Date.now() + waitMs;
  while (!(await acquire(id, HELD_FOR_GOOD_MS))) {
    if (Date.now() > until) throw new DeleteRefused("busy", "A sync is running for this account. Try again in a minute.");
    await new Promise((r) => setTimeout(r, 1000));
  }
  log("holding the sync lock");

  // 2. X. The grant first, then the subscriptions with the app's token.
  const revoked = await deps.revokeGrant(id);
  log(revoked ? "revoked xtoolio's access on X" : "no access on X to revoke (or X refused: they can remove it in X's settings)");
  let subs;
  try {
    subs = await deps.dropSubs(id);
  } catch (err) {
    await SyncState.updateOne({ _id: id }, { $unset: { runningUntil: 1 } }); // let go: nothing is deleted yet
    throw new DeleteRefused("x", `X didn't answer about live updates (${err.message}). Try again in a minute.`);
  }
  log(`deleted ${subs} live subscription${subs === 1 ? "" : "s"} on X`);

  // 3. Stripe. Its failing never keeps the account: it's logged, for the operator to delete the customer by hand.
  let stripe = false;
  try {
    stripe = await deps.forgetCustomer(account);
    if (stripe) log("deleted the Stripe customer (its card goes; Stripe keeps invoices and receipts)");
  } catch (err) {
    console.error(`[delete] @${account.username}: Stripe customer ${account.stripeCustomerId} NOT deleted (${err.message}): delete it in Stripe's dashboard`);
  }

  // 4. The account (its failing throws: nothing past this point has happened, and the person can press Delete again),
  // then everything it owned, each step retried and none skipped because another failed.
  await Account.deleteOne({ _id: id });
  const steps = [["its front-page estimate", () => HandleEstimate.deleteMany({ _id: account.username.toLowerCase() })], ...CASCADE.map(([label, , remove]) => [label, () => remove(id)])];
  const removed = [{ label: "the account", n: 1 }];
  const failed = [];
  for (const [label, run] of steps) {
    try {
      const r = await retried(run);
      removed.push({ label, n: r.deletedCount ?? r.modifiedCount ?? 0 });
    } catch (err) {
      failed.push(label);
      console.error(`[delete] account ${id} (@${account.username}): ${label} NOT deleted after ${STEP_TRIES} tries (${err.message})`);
    }
  }
  log(failed.length ? `deleted @${account.username}, except: ${failed.join(", ")} (logged)` : `deleted @${account.username}`);
  return { username: account.username, revoked, subs, stripe, removed, failed };
}

// A step of the cascade, tried up to STEP_TRIES times (a database blip), STEP_WAIT_MS apart.
const STEP_TRIES = 3;
const STEP_WAIT_MS = 2000;
async function retried(run) {
  for (let i = 1; ; i++) {
    try {
      return await run();
    } catch (err) {
      if (i >= STEP_TRIES) throw err;
      await new Promise((r) => setTimeout(r, STEP_WAIT_MS));
    }
  }
}

module.exports = { deleteAccount, planFor, DeleteRefused, LOCK_WAIT_MS };
