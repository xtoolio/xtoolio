// verify-delete: DELETING AN ACCOUNT (services/deleteAccount.js) against the real database, on two throwaway accounts
// it creates and removes: A is deleted, B must come through untouched. Both are seeded in EVERY place the cascade
// covers (so a filter that matched too much shows as B losing rows, and one that matched nothing as A keeping them),
// plus the shared-store cases: a post only A's feed had (deleted), one A and B both had (A unlinked, kept), a context
// post (kept), follow pairs with a stranger (deleted) and with B (kept), an app only A approved (deleted) and one both
// did (kept). X and Stripe are stubbed. Part of `npm run verify:db`. Needs MONGO_URI; writes only `verify-delete-…` rows.
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const mongoose = require("mongoose");
const config = require("../config");
const { connect } = require("../lib/db");
const { deleteAccount, planFor } = require("../services/deleteAccount");
const { acquire } = require("../services/sync");
const M = (name) => require(`../models/${name}`);

const rnd = () => crypto.randomBytes(4).readUInt32BE(0);
const A = `99${String(rnd()).padStart(10, "0")}1`;
const B = `99${String(rnd()).padStart(10, "0")}2`;
const STRANGER = `99${String(rnd()).padStart(10, "0")}3`;
const tag = `verify-delete-${rnd()}`;
const user = (id) => `${tag}-${id === A ? "a" : "b"}`;
const raw = (name) => mongoose.connection.db.collection(name);
const oid = () => new mongoose.Types.ObjectId();

let checks = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  checks++;
};

// One account's rows in every per-account place. → nothing (the counts are read back by planFor and by hand).
async function seed(id) {
  const now = new Date();
  await M("Account").collection.insertOne({ _id: id, username: user(id), createdAt: now });
  await M("SyncState").collection.insertOne({ _id: id });
  await M("HandleEstimate").collection.insertOne({ _id: user(id).toLowerCase(), expireAt: new Date(Date.now() + 3600e3) });
  await M("TagRead").collection.insertOne({ _id: `${id}:${tag}`, accountId: id, at: now });
  for (const name of ["Like", "Repost", "FollowEvent", "InboxMark", "InboxUndo", "Draft", "Feedback", "FeedbackShot", "LiveEvent", "LivePending", "UsageEntry", "BalanceEntry"]) {
    await M(name).collection.insertOne({ _id: name === "FollowEvent" ? `${tag}-${id}` : oid(), accountId: id, postId: `${tag}`, at: now });
  }
  await M("AgentToken").collection.insertOne({ _id: crypto.createHash("sha256").update(`${tag}${id}`).digest("hex"), accountId: id });
  await M("OAuthRequest").collection.insertOne({ _id: `${tag}-${id}`, clientId: `${tag}-shared`, accountId: id });
  await M("Presence").collection.insertOne({ _id: id, until: now });
  await M("Waitlist").collection.insertOne({ _id: id, username: user(id), joinedAt: now });
  await M("WaitlistDm").collection.insertOne({ _id: id, username: user(id), status: "sent", queuedAt: now }); // never "queued": no worker sends it
  await M("RateWindow").collection.insertOne({ _id: `${id} /users/:id/tweets`, remaining: 1 });
  // Each one's invite link, the OTHER having come in through it (so each is also on someone's link).
  await M("InviteCode").collection.insertOne({ _id: `${tag}-ic-${id}`, accountId: id, used: [{ id: id === A ? B : A, username: user(id === A ? B : A), at: now }], createdAt: now });
  await raw("follows").insertOne({ accountId: id, userId: STRANGER, kind: tag });
  await raw("conversationmarks").insertOne({ accountId: id, conversationId: tag });
  await raw("sessions").insertOne({ _id: `${tag}-${id}`, expires: new Date(Date.now() + 3600e3), session: JSON.stringify({ cookie: {}, accountId: id }) });
  await M("Follow").collection.insertOne({ _id: `${id}>${STRANGER}`, followerId: id, followeeId: STRANGER, follows: true });
  await M("Post").collection.insertOne({ _id: `${tag}-only-${id}`, accounts: [{ id, kind: "own" }] });
}

const rowsOf = async (id) => Object.fromEntries((await planFor(id)).map((r) => [r.label, r.n]));

const STUBS = { isOwner: () => false, revokeGrant: async () => true, dropSubs: async () => 2, forgetCustomer: async () => false };

(async () => {
  await connect(config);
  try {
    await seed(A);
    await seed(B);
    // The shared cases.
    await M("Post").collection.insertMany([
      { _id: `${tag}-both`, accounts: [{ id: A, kind: "own" }, { id: B, kind: "mention" }] },
      { _id: `${tag}-context`, accounts: [] },
    ]);
    await M("Follow").collection.insertMany([
      { _id: `${A}>${B}`, followerId: A, followeeId: B, follows: true },
      { _id: `${B}>${A}`, followerId: B, followeeId: A, follows: false },
    ]);
    await M("Like").collection.insertOne({ _id: oid(), accountId: B, likerId: A, postId: `${tag}-b-post` }); // B's record of A's like
    await M("OAuthClient").collection.insertMany([{ _id: `${tag}-only-a`, info: {} }, { _id: `${tag}-shared`, info: {} }]);
    const hashes = () => ({ accessHash: crypto.randomBytes(32).toString("hex"), refreshHash: crypto.randomBytes(32).toString("hex") }); // unique indexes
    await M("AgentGrant").collection.insertMany([
      { _id: oid(), accountId: A, clientId: `${tag}-only-a`, ...hashes() },
      { _id: oid(), accountId: A, clientId: `${tag}-shared`, ...hashes() },
      { _id: oid(), accountId: B, clientId: `${tag}-shared`, ...hashes() },
    ]);

    const before = await rowsOf(A);
    const bBefore = await rowsOf(B);
    for (const [label, n] of Object.entries(before)) ok(n > 0, `seeded nothing for "${label}": the test doesn't cover it`);
    ok(before["follow pairs"] === 1, `A's pairs to delete: only the stranger's (B is an account): ${before["follow pairs"]}`);
    ok(before["apps registered only for you"] === 1, "only the app A alone approved goes");
    ok(before["posts only your feeds had"] === 1 && before["posts shared with another account (yours unlinked)"] === 1, "posts: one only A's, one shared");

    // Refusals leave everything.
    await assert.rejects(deleteAccount(A, { deps: { ...STUBS, isOwner: () => true } }), (e) => e.code === "owner");
    ok(true);
    const held = await acquire(A); // a sync running
    ok(!!held, "took A's lock as a sync would");
    await assert.rejects(deleteAccount(A, { deps: STUBS, waitMs: 1500 }), (e) => e.code === "busy");
    ok((await M("Account").countDocuments({ _id: A })) === 1, "busy: the account is still there");
    await M("SyncState").updateOne({ _id: A }, { $unset: { runningUntil: 1 } }); // the sync ends
    await assert.rejects(deleteAccount(A, { deps: { ...STUBS, dropSubs: async () => { throw new Error("X down"); } } }), (e) => e.code === "x");
    ok((await M("Account").countDocuments({ _id: A })) === 1, "X down: the account is still there");
    ok(!(await M("SyncState").findById(A, "runningUntil").lean()).runningUntil, "X down: the lock is let go");

    // The delete.
    const calls = [];
    const done = await deleteAccount(A, { deps: { ...STUBS, revokeGrant: async (id) => (calls.push(["revoke", id]), true), dropSubs: async (id) => (calls.push(["subs", id]), 2) } });
    ok(calls[0][0] === "revoke" && calls[1][0] === "subs", "the grant is revoked before the subscriptions are dropped");
    ok(done.subs === 2 && done.revoked === true, "reports X's side");
    ok(done.failed.length === 0, `no step failed (${done.failed.join(", ")})`);
    const after = await rowsOf(A);
    for (const [label, n] of Object.entries(after)) ok(n === 0, `"${label}" left ${n} for A`);
    ok((await M("Post").countDocuments({ _id: `${tag}-only-${A}` })) === 0, "A's own-feed post is deleted");
    const both = await M("Post").findById(`${tag}-both`).lean();
    ok(both && both.accounts.length === 1 && both.accounts[0].id === B, "the shared post stays, with only B");
    ok((await M("Post").countDocuments({ _id: `${tag}-context` })) === 1, "the context post stays");
    ok((await M("Follow").countDocuments({ _id: { $in: [`${A}>${B}`, `${B}>${A}`] } })) === 2, "pairs with B (still an account) stay");
    ok((await M("Follow").countDocuments({ _id: `${A}>${STRANGER}` })) === 0, "the pair with a stranger goes");
    ok((await M("OAuthClient").countDocuments({ _id: `${tag}-shared` })) === 1, "the app B approved too stays");
    ok((await M("Like").countDocuments({ accountId: B, likerId: A })) === 1, "B's record of A's like stays");
    const bLink = await M("InviteCode").findById(`${tag}-ic-${B}`).lean();
    ok(bLink && bLink.used.length === 1 && bLink.used[0].id === null && bLink.used[0].username === null, "B's link keeps A's place taken, but forgets it was A");

    // B untouched: every count the same, except what A's going makes B's alone (the pairs with A, now a non-member;
    // the shared post, now only B's feed's; the app only B approves now).
    const bAfter = await rowsOf(B);
    const moved = { "follow pairs": 2, "posts only your feeds had": 1, "posts shared with another account (yours unlinked)": -1, "apps registered only for you": 1, "you, on the invite link you came through": -1 };
    for (const [label, n] of Object.entries(bBefore)) ok(bAfter[label] === n + (moved[label] || 0), `B's "${label}" went ${n} → ${bAfter[label]}`);

    // Again: nothing left to find.
    await assert.rejects(deleteAccount(A, { deps: STUBS }), (e) => e.code === "gone");
    ok(true);
    console.log(`verify-delete: ${checks} checks pass`);
  } finally {
    // Clean up: B through the same delete, then whatever the shared cases left.
    await deleteAccount(B, { deps: STUBS }).catch(() => {});
    await deleteAccount(A, { deps: STUBS }).catch(() => {});
    await M("Post").deleteMany({ _id: { $regex: `^${tag}` } });
    await M("Follow").deleteMany({ $or: [{ followerId: { $in: [A, B] } }, { followeeId: { $in: [A, B] } }] });
    await M("OAuthClient").deleteMany({ _id: { $regex: `^${tag}` } });
    await M("Like").deleteMany({ likerId: A });
    await mongoose.disconnect();
  }
})().catch((e) => {
  console.error(`verify-delete FAILED: ${e.message}`);
  process.exit(1);
});
