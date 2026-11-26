// verify-private: PRIVATE ACCOUNTS in the shared store (services/accountData.js visibleTo) against the real database,
// on throwaway accounts it creates and removes. A follows a private account P; P replies to B in a thread A and B are
// both in, and A's context read stored that reply (seenBy A). B must never get it: not in its posts, its conversations,
// a lookup by id, its Inbox's cards or its Inbox count; A must. The same reply from a PUBLIC author is drawn for B (the
// filter hides by privacy, not by who read it), and once X shows the private reply to B (storeContext with B), B gets
// it. Each check is made to differ between the two sides: P's reply is seeded on A's side only. Part of
// `npm run verify:db`. Needs MONGO_URI; writes only rows with its own random ids.
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const config = require("../config");
const { connect } = require("../lib/db");
const mongoose = require("mongoose");
const { accountPosts, postsInConversations, postsById } = require("../services/accountData");
const { inboxCards } = require("../services/conversations");
const { refreshOwed } = require("../services/inboxCount");
const { storeContext, syncContext } = require("../services/sync");
const { setLike, setRepost, sendReply, goneCheck } = require("../services/extras");
const Account = require("../models/Account");
const Person = require("../models/Person");
const Post = require("../models/Post");
const SyncState = require("../models/SyncState");
const LiveEvent = require("../models/LiveEvent");

const rnd = () => crypto.randomBytes(4).readUInt32BE(0);
const uid = (n) => `98${String(rnd()).padStart(10, "0")}${n}`;
const [A, B, P, Q] = [uid(1), uid(2), uid(3), uid(4)];
// Post ids are X snowflakes minted now (the Inbox compares them with its start), each distinct.
let seq = 0;
const snow = () => String(((BigInt(Date.now()) - 1288834974657n) << 22n) + BigInt(rnd() % 1000) * 4096n + BigInt(++seq));
const [ROOT, A1, B1, P1, Q1, B2, PX] = [snow(), snow(), snow(), snow(), snow(), snow(), snow()];
const ids = [ROOT, A1, B1, P1, Q1, B2, PX]; // PX: a parent B2 answers that X won't show B (never seeded)

let checks = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  checks++;
};
const has = (posts, id) => posts.some((p) => p._id === id);

const post = (id, authorId, extra) => ({ _id: id, authorId, text: `verify-private ${id}`, createdAt: new Date(), conversationId: ROOT, ...extra });
const replyTo = (parent, userId) => ({ inReplyToUserId: userId, referenced: [{ type: "replied_to", id: parent }] });

async function seed() {
  const long = new Date(Date.now() - 30 * 864e5);
  for (const id of [A, B]) {
    await Account.collection.insertOne({ _id: id, username: `verify-private-${id}`, createdAt: long, features: { inbox: { on: true, since: long, first: long } } });
    await SyncState.collection.insertOne({ _id: id });
  }
  await Person.collection.insertMany([
    { _id: P, username: `verify-private-p-${P}`, protected: true },
    { _id: Q, username: `verify-private-q-${Q}`, protected: false },
  ]);
  await Post.collection.insertMany([
    post(ROOT, Q, { seenBy: [A, B] }), // a public thread both are in
    post(A1, A, { accounts: [{ id: A, kind: "own" }], ...replyTo(ROOT, Q) }),
    post(B1, B, { accounts: [{ id: B, kind: "own" }], ...replyTo(ROOT, Q) }),
    post(P1, P, { seenBy: [A], ...replyTo(B1, B) }), // the private reply to B, which only A's read brought in
    post(Q1, Q, { seenBy: [A], ...replyTo(B1, B) }), // the same from a public author
    post(B2, B, { accounts: [{ id: B, kind: "own" }], ...replyTo(PX, P) }), // B answers a post of P's nobody stored
  ]);
}

async function cleanup() {
  await Promise.all([
    Account.deleteMany({ _id: { $in: [A, B] } }),
    SyncState.deleteMany({ _id: { $in: [A, B] } }),
    Person.deleteMany({ _id: { $in: [P, Q] } }),
    Post.deleteMany({ _id: { $in: ids } }),
    LiveEvent.deleteMany({ accountId: { $in: [A, B] } }),
  ]);
}

const cardIds = (rows) => rows.flatMap((r) => [...(r.topic || []), ...(r.chat || [])].map((m) => m.id));

(async () => {
  await connect(config);
  try {
    await seed();
    const [accA, accB] = await Promise.all([Account.findById(A).lean(), Account.findById(B).lean()]);

    // B: the private reply nowhere; the public one everywhere.
    const bPosts = await accountPosts(B);
    ok(!has(bPosts, P1), "B's posts must not hold the private reply");
    ok(has(bPosts, Q1), "B's posts hold the public reply (the filter hides by privacy, not by reader)");
    const bConv = await postsInConversations(B, [ROOT]);
    ok(!has(bConv, P1), "B's conversation must not hold the private reply");
    ok(has(bConv, Q1) && has(bConv, A1), "B's conversation holds the public posts");
    ok((await postsById(B, [P1])).length === 0, "B can't look the private reply up by id");
    ok((await postsById(B, [Q1])).length === 1, "B can look the public reply up by id");
    const bCards = cardIds((await inboxCards(accB, { drawn: (rows) => new Set(rows.map((r) => r.conversationId)) })).rows);
    ok(!bCards.includes(P1), "B's Inbox must not draw the private reply");
    ok(bCards.includes(Q1), "B's Inbox draws the public reply");
    const owedHidden = await refreshOwed(B);

    // A, who X showed it to: everywhere.
    ok(has(await postsInConversations(A, [ROOT]), P1), "A's conversation holds the private reply it read");
    ok((await postsById(A, [P1])).length === 1, "A can look the private reply up by id");

    // THE WRITES (♥, ↻, a reply) see what the pages see: B pressing on the private reply it can't see is "missing", and
    // X is never asked (they used to look it up bare, X refused, and goneCheck marked it gone for A too).
    const noX = async () => {
      throw new Error("asked X");
    };
    ok((await setLike({ accountId: B, postId: P1, on: true, getToken: noX })) === "missing", "B's ♥ on the private reply is missing, X not asked");
    ok((await setRepost({ accountId: B, postId: P1, on: true, getToken: noX })) === "missing", "B's ↻ on the private reply is missing, X not asked");
    await assert.rejects(sendReply({ accountId: B, postId: P1, text: "hi", getToken: noX }), (e) => e.code === "NO_POST", "B's reply to the private reply: no such post, X not asked");
    checks++;
    // X refusing an ACCOUNT ("Authorization Error") marks nothing gone; X saying it doesn't exist does.
    const xSays = (title, type) => ({ remainingContext: () => 100, postsByIds: async (batch) => ({ posts: [], missing: batch.map((id) => ({ id, title, detail: "verify-private", type })) }) });
    const refused = xSays("Authorization Error", "https://api.twitter.com/2/problems/not-authorized-for-resource");
    ok((await goneCheck(refused, P1, { status: 403 })) === false, "goneCheck: X refusing B is not 'gone'");
    ok(!(await Post.findById(P1, "gone").lean()).gone, "the private reply stays drawn for A");
    ok(has(await postsInConversations(A, [ROOT]), P1), "A still has it after B's refused press");
    // The context pass the same way: B answering PX, which X won't show B, stores no placeholder (a placeholder counts as
    // "have", so A, who can see it, would never fetch it); X's "doesn't exist" does store one.
    await syncContext(refused, B, { fetched: 0, gone: 0 });
    ok(!(await Post.exists({ _id: PX })), "context: a post X won't show B leaves no placeholder");
    await syncContext(xSays("Not Found Error", "https://api.twitter.com/2/problems/resource-not-found"), B, { fetched: 0, gone: 0 });
    ok(!!(await Post.findById(PX, "gone").lean()).gone, "context: a post X says doesn't exist is stored gone");

    // The private author made public: B's count gains exactly that reply (the count follows the same rule).
    await Person.updateOne({ _id: P }, { $set: { protected: false } });
    ok((await refreshOwed(B)) > owedHidden, "B's Inbox count must leave out the private reply (it rises once the author is public)");
    ok(has(await accountPosts(B), P1), "a public author's reply is drawn for B");
    await Person.updateOne({ _id: P }, { $set: { protected: true } });

    // X shows the private reply to B (its own context read): stored as seen by B too, and B gets it.
    await storeContext([{ id: P1, text: "verify-private", author_id: P, conversation_id: ROOT, created_at: new Date().toISOString() }], B);
    const doc = await Post.findById(P1, "seenBy text").lean();
    ok(doc.seenBy.includes(A) && doc.seenBy.includes(B), "storeContext adds the reader to seenBy without dropping the others");
    ok(doc.text === `verify-private ${P1}`, "storeContext never overwrites a stored post");
    ok(has(await accountPosts(B), P1), "once X showed it to B, B gets the private reply");
    console.log(`verify-private: ${checks} checks pass`);
  } finally {
    await cleanup();
    await mongoose.disconnect();
  }
})().catch((e) => {
  console.error(`verify-private FAILED: ${e.message}`);
  process.exit(1);
});
