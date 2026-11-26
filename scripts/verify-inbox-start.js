// verify-inbox-start: WHERE A NEW INBOX STARTS (services/inboxStart.js) against the real database, on a throwaway
// account it creates and removes: 45 replies to it, Get started's `inboxFrom.want` 20. While its first read runs nothing
// is fixed and nothing counts; once read, the Inbox holds exactly the newest 20 (cards and red count), "Load earlier"
// offers 20, adds 20, then the last 5, then nothing. An account from before (no inboxFrom) keeps its week. Part of
// `npm run verify:db`. Needs MONGO_URI; writes only rows with its own random ids.
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const mongoose = require("mongoose");
const config = require("../config");
const { connect } = require("../lib/db");
const inboxStart = require("../services/inboxStart");
const { inboxCards } = require("../services/conversations");
const { refreshOwed } = require("../services/inboxCount");
const Account = require("../models/Account");
const Person = require("../models/Person");
const Post = require("../models/Post");
const SyncState = require("../models/SyncState");
const LiveEvent = require("../models/LiveEvent");

const rnd = () => crypto.randomBytes(4).readUInt32BE(0);
const uid = (n) => `97${String(rnd()).padStart(10, "0")}${n}`;
const [ME, THEM] = [uid(1), uid(2)];
const N = 45;
// 45 replies an hour apart, the newest an hour ago: each its own conversation (a card each), X snowflake ids.
const snowAt = (ms, i) => String(((BigInt(Math.floor(ms)) - 1288834974657n) << 22n) + BigInt(i));
const replies = Array.from({ length: N }, (_, i) => {
  const at = Date.now() - (i + 1) * 3600e3;
  const id = snowAt(at, i + 1);
  return { _id: id, authorId: THEM, text: `verify-inbox-start ${i}`, createdAt: new Date(at), conversationId: id, mentions: [{ id: ME, username: "me", start: 0, end: 3 }], accounts: [{ id: ME, kind: "mention" }] };
});

let checks = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  checks++;
};
const fresh = () => Account.findById(ME, Account.REQUEST_FIELDS).lean();
const cards = async () => (await inboxCards(await fresh())).rows.length;

(async () => {
  await connect(config);
  try {
    const long = new Date(Date.now() - 60 * 864e5);
    await Account.collection.insertOne({ _id: ME, username: `verify-inbox-start-${ME}`, createdAt: long, features: { inbox: { on: true, since: long, first: long } }, inboxFrom: { want: inboxStart.FIRST_REPLIES } });
    await SyncState.collection.insertOne({ _id: ME, lastRunAt: null, mention: { oldestId: replies[N - 1]._id } });
    await Person.collection.insertOne({ _id: THEM, username: `verify-inbox-start-them-${THEM}` });
    await Post.collection.insertMany(replies);

    // The first read still going: nothing fixed, nothing counted.
    ok((await refreshOwed(ME)) === 0, "while the first read runs, the red count is 0");
    ok(!(await fresh()).inboxFrom.id, "while the first read runs, nothing is fixed");

    // Read: the newest 20, fixed.
    await SyncState.updateOne({ _id: ME }, { $set: { lastRunAt: new Date() } });
    ok((await cards()) === 20, `the new Inbox holds the newest 20 (got ${await cards()})`);
    const fixed = (await fresh()).inboxFrom.id;
    ok(fixed === replies[19]._id, "the start is the 20th newest reply, fixed on the account");
    ok((await refreshOwed(ME)) === 20, "the red count counts those 20 (a reply each: this account's likes aren't read)");
    // A new reply arriving doesn't move the start (cards never drop out).
    ok((await inboxStart.startFor(await fresh())) === fixed, "the start stays where it was fixed");

    // Load earlier: 20, 20 more, then the last 5, then none.
    ok((await inboxStart.moreFor(await fresh(), fixed)) === 20, "Load offers 20 earlier");
    ok((await inboxStart.loadMore(await fresh())) === 20 && (await cards()) === 40, "Load adds 20: 40 cards");
    ok((await inboxStart.moreFor(await fresh(), await inboxStart.startFor(await fresh()))) === 5, "then offers the last 5");
    ok((await inboxStart.loadMore(await fresh())) === 5 && (await cards()) === N, "adds the last 5: every reply");
    ok((await inboxStart.moreFor(await fresh(), await inboxStart.startFor(await fresh()))) === 0, "then nothing left to load (the reach)");
    ok((await inboxStart.loadMore(await fresh())) === 0 && (await cards()) === N, "a press with nothing left changes nothing");

    // THE WINDOW, Last 24 hours: only the replies of the last day (23 of the hourly ones), counted the same; no Load;
    // and turned off, everything is back (the window never moved the stored start).
    await Account.updateOne({ _id: ME }, { $set: { inboxWithin: "1d" } });
    ok((await cards()) === 23, `Last 24 hours: the last day's 23 (got ${await cards()})`);
    ok((await refreshOwed(ME)) === 23, "the red count follows the window");
    ok((await inboxStart.moreFor(await fresh(), await inboxStart.startFor(await fresh()))) === 0 && (await inboxStart.loadMore(await fresh())) === 0, "no Load earlier while the window is on");
    // The window is a view of the Inbox: a conversation drawn whole (a post's page) still shows an older reply waiting.
    const old = replies[30];
    const page = (await inboxCards(await fresh(), { only: new Set([old.conversationId]), history: true })).rows[0];
    ok(page && !page.settled && page.waitingReplies > 0, "with the window on, a 31-hour-old reply on its own page is still waiting, not settled");
    await Account.updateOne({ _id: ME }, { $unset: { inboxWithin: 1 } });
    ok((await cards()) === N && (await refreshOwed(ME)) === N, "the window off: every reply again, and the count");

    // READ FURTHER BACK (services/further.js): while it runs, no Load earlier (its likes aren't reconciled that far);
    // done, the Inbox's start stays where it was, unless it was asked to take the replies (then back to the oldest
    // mention read: every reply waits).
    const further = require("../services/further");
    const reachState = { mention: { oldestId: replies[N - 1]._id } };
    const ask = async (inbox) => Account.updateOne({ _id: ME }, { $set: { "inboxFrom.id": replies[19]._id, history: { budget: 20, further: { from: 20, inbox, at: new Date() } } } });
    await ask(false);
    ok((await inboxStart.moreFor(await fresh(), replies[19]._id)) === 0 && (await inboxStart.loadMore(await fresh())) === 0, "no Load earlier while reading further back");
    await further.finish(await fresh(), reachState);
    ok((await cards()) === 20 && !(await fresh()).history.further, "done without the Inbox: the ask goes, the Inbox's start stays (20 cards)");
    await ask(true);
    await further.finish(await fresh(), reachState);
    ok((await cards()) === N && (await refreshOwed(ME)) === N, "done with the Inbox: its start moves back, every reply waits, and the count");
    await Account.updateOne({ _id: ME }, { $unset: { history: 1 } });

    // An account from before: its week, and no Load.
    await Account.updateOne({ _id: ME }, { $unset: { inboxFrom: 1 } });
    ok((await cards()) === N, "an account from before keeps its start (a week before joining, here every reply)");
    ok((await inboxStart.moreFor(await fresh(), "0")) === 0, "an account from before is offered no Load");
    console.log(`verify-inbox-start: ${checks} checks pass`);
  } finally {
    await Promise.all([
      Account.deleteMany({ _id: ME }),
      SyncState.deleteMany({ _id: ME }),
      Person.deleteMany({ _id: THEM }),
      Post.deleteMany({ _id: { $in: replies.map((r) => r._id) } }),
      LiveEvent.deleteMany({ accountId: ME }),
    ]);
    await mongoose.disconnect();
  }
})().catch((e) => {
  console.error(`verify-inbox-start FAILED: ${e.message}`);
  process.exit(1);
});
