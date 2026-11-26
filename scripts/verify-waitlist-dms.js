// verify-waitlist-dms: THE WAITLIST'S "YOU'RE IN" DMs (services/waitlistDms.js) against a TEST database, X stubbed:
// the sender is the site's own account, and nothing is queued while its grant lacks dm.write or X refused it (the
// Admin page says which); a Grant queues exactly that person, once (a second queue adds
// nothing; someone who already has an account gets none); the send goes in the order queued, a refusal is kept with
// X's reason and doesn't stop the queue, "dm-duplicate" counts as sent, X's limit puts the row back and stops; a
// person's "Send again" requeues them; the Admin page's per-person states; the follow check (checkFollows) reads X's
// connection_status into `follows` and refreshes who they are for whoever is due (never checked; not following, joined
// under a day ago, read over an hour ago), never once X refused the grant. Refuses a non-test database (on
// production it would DM people). Part of `npm run verify:db`.
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const mongoose = require("mongoose");
const config = require("../config");
const { connect } = require("../lib/db");
const waitlist = require("../services/waitlist");
const dms = require("../services/waitlistDms");
const Waitlist = require("../models/Waitlist");
const WaitlistDm = require("../models/WaitlistDm");
const { SCOPES_ALL, SCOPES_SITE } = require("../services/features");
const Account = require("../models/Account");
const UsageEntry = require("../models/UsageEntry");

const rnd = () => crypto.randomBytes(4).readUInt32BE(0);
const users = [1, 2, 3, 4].map((i) => ({ id: `95${String(rnd()).padStart(10, "0")}${i}`, username: `verify-dms-${i}` }));
const ids = users.map((u) => u.id);

let checks = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  checks++;
};

(async () => {
  await connect(config);
  if (!/test/i.test(mongoose.connection.name)) {
    console.log(`verify-waitlist-dms: skipped (database "${mongoose.connection.name}" isn't a test database: the sender is shared)`);
    return mongoose.disconnect();
  }
  if (!config.siteX) {
    console.log("verify-waitlist-dms: skipped (SITE_X is unset: there's no sender to connect)");
    return mongoose.disconnect();
  }
  // THE SENDER is the site's own account (SITE_X): this database's, its grant's scope and state put back after; or a
  // throwaway one made for the run (its handle in another case: found in any case). Stubbed sends and reads never
  // open its tokens.
  const siteBefore = await Account.findOne({ username: config.siteX }, "_id needsReauth tokens.scope").collation({ locale: "en", strength: 2 }).lean();
  const siteId = siteBefore ? siteBefore._id : `95${String(rnd()).padStart(10, "0")}9`;
  const setSite = (scope, needsReauth = false) => Account.updateOne({ _id: siteId }, { $set: { "tokens.scope": scope, needsReauth } });
  const startedAt = new Date();
  try {
    if (!siteBefore) await Account.collection.insertOne({ _id: siteId, username: config.siteX.toUpperCase(), createdAt: new Date(), tokens: {} });
    for (const u of users) await waitlist.join(u);

    // Signed in before it asked for dm.write: DMs off, a Grant queues nothing; the panel says why.
    await setSite(SCOPES_ALL.join(" "));
    await waitlist.grant(users[0].id, "verify");
    ok(!(await dms.isOn({ fresh: true })) && (await dms.queue(users[0].id)) === false, "no dm.write on the site account's grant: DMs off, nothing queued");
    ok((await dms.panel()).why === "scope", "the Admin page says it signed in before it could send DMs");
    await setSite(SCOPES_SITE.join(" "), true);
    ok(!(await dms.isOn({ fresh: true })) && (await dms.panel()).why === "reauth", "X refused its grant: DMs off, and the page says so");

    // Its one grant with SCOPES_SITE: DMs on.
    await setSite(SCOPES_SITE.join(" "));
    ok(await dms.isOn({ fresh: true }), "DMs are on");
    ok((await dms.panel()).on, "the Admin page says on");

    // #4 already has an account (an invitee): no DM for them.
    await Account.collection.insertOne({ _id: users[3].id, username: users[3].username, createdAt: new Date() });
    for (const u of users.slice(0, 3)) ok((await dms.queue(u.id)) === true, `Grant queues ${u.username}'s DM`);
    ok((await dms.queue(users[3].id)) === false, "someone who already has an account gets none");
    ok((await dms.queue(users[0].id)) === false, "the same person again: nothing more (one per person, ever)");

    // The send, X stubbed: #1 refused (doesn't follow), #2 sent, #3 X already has (dm-duplicate).
    const asked = [];
    const send = async (to, text) => {
      asked.push({ to, text });
      if (to === users[0].id) throw Object.assign(new Error("X API 403"), { status: 403, problem: "dm-recipient-not-accepting", detail: "You do not have permission to DM one or more participants." });
      if (to === users[2].id) throw Object.assign(new Error("X API 403"), { status: 403, problem: "dm-duplicate", detail: "duplicate" });
      return { eventId: `e-${to}`, conversationId: "c" };
    };
    const r1 = await dms.sendDue({ send });
    ok(asked.map((a) => a.to).join() === ids.slice(0, 3).join(), "sent in the order queued, and a refusal doesn't stop the queue");
    ok(asked[1].text === dms.textFor() && asked[1].text.includes(config.siteDomain) && !/#\d/.test(asked[1].text), "THE text: the site, no number");
    ok(r1.sent === 2 && r1.refused === 1, "two sent (one as X's duplicate), one refused");
    const refused = await WaitlistDm.findById(users[0].id).lean();
    ok(refused.status === "refused" && refused.problem === "dm-recipient-not-accepting", "the refusal keeps X's reason");
    ok((await dms.sendDue({ send })).sent === 0 && asked.length === 3, "nothing queued: the next tick sends nothing");

    const states = await dms.dmsOf(ids);
    ok(states.get(users[1].id).status === "sent" && states.get(users[0].id).status === "refused" && /follow/.test(states.get(users[0].id).why) && !states.has(users[3].id), "the Admin page's states: sent, refused in words, none");

    // Send again: that one person back in the queue; X's limit this time puts it back and stops the tick.
    ok((await dms.retry(users[1].id)) === false, "Send again on a DM that went out: nothing");
    ok((await dms.retry(users[0].id)) === true, "Send again requeues the refused one");
    ok((await dms.sendDue({ send: async () => Promise.reject(Object.assign(new Error("X API 429"), { status: 429 })) })).sent === 0, "X's limit: nothing sent");
    const back = await WaitlistDm.findById(users[0].id).lean();
    ok(back.status === "queued" && back.tries === 1, "X's limit puts the row back, its try not counted");
    ok((await dms.sendDue({ send: async () => ({ eventId: "followed-since" }) })).sent === 1, "the next tick sends it (they follow now)");

    // A claim left by a dead worker goes back to the queue.
    await WaitlistDm.updateOne({ _id: users[1].id }, { $set: { status: "sending", claimedAt: new Date(Date.now() - 10 * 60e3) } });
    await dms.sendDue({ send: async () => ({ eventId: "again" }) });
    ok((await WaitlistDm.findById(users[1].id).lean()).status === "sent", "a stale claim is picked up again");

    // WHO FOLLOWS, checked by itself: X's connection_status ("followed_by": they follow the sender) into `follows`, with
    // who they are refreshed; someone signed up isn't read; X's "missing" gets followsAt alone. Only this run's people
    // answer the stub (anyone else on the test database's list comes back as neither, so their rows are left alone).
    await waitlist.signedUp(users[3].id);
    let readIds = [];
    const read = async (batch) => {
      readIds.push(...batch);
      const mine = batch.filter((id) => ids.includes(id) && id !== users[2].id);
      return {
        users: mine.map((id, i) => ({ id, username: users.find((u) => u.id === id).username, name: `Checked ${i}`, connection_status: id === users[1].id ? ["followed_by", "following"] : [] })),
        missing: batch.includes(users[2].id) ? [{ id: users[2].id, title: "Not Found Error" }] : [],
      };
    };
    await dms.checkFollows({ read });
    ok(readIds.includes(users[0].id) && readIds.includes(users[1].id) && !readIds.includes(users[3].id), "everyone not checked and not signed up is read; the one signed up isn't");
    const [f0, f1, f2] = await Promise.all([0, 1, 2].map((i) => Waitlist.findById(users[i].id).lean()));
    ok(f1.follows === true && f0.follows === false && f1.followsAt && /^Checked/.test(f0.name), "follows from X's connection_status, and who they are refreshed");
    ok(f2.followsAt && f2.follows === undefined, "someone X won't return is marked checked, follows left unknown");

    readIds = [];
    await dms.checkFollows({ read });
    ok(!ids.some((id) => readIds.includes(id)), "the next tick: nobody of theirs is due (just checked, or X won't return them)");
    await Waitlist.updateOne({ _id: users[0].id }, { $set: { followsAt: new Date(Date.now() - 2 * 3600e3) } });
    await Waitlist.updateOne({ _id: users[1].id }, { $set: { followsAt: new Date(Date.now() - 2 * 3600e3) } });
    readIds = [];
    await dms.checkFollows({ read });
    ok(readIds.includes(users[0].id) && !readIds.includes(users[1].id), "an hour on: the one not following is checked again, the follower isn't");
    await Waitlist.updateOne({ _id: users[0].id }, { $set: { followsAt: new Date(Date.now() - 2 * 3600e3), joinedAt: new Date(Date.now() - 2 * 86400e3) } });
    readIds = [];
    await dms.checkFollows({ read });
    ok(!readIds.includes(users[0].id), "joined over a day ago: not checked again (the DM is the check)");

    // X refused the site account's grant: the check reads nothing (sign in again).
    await setSite(SCOPES_SITE.join(" "), true);
    ok((await dms.checkFollows()) === null, "X refused its grant: the follow check refuses");
    console.log(`verify-waitlist-dms: ${checks} checks pass`);
  } finally {
    await WaitlistDm.deleteMany({ _id: { $in: ids } });
    await Waitlist.deleteMany({ _id: { $in: ids } });
    await Account.deleteMany({ _id: { $in: ids } });
    await UsageEntry.deleteMany({ kind: { $in: ["dm", "waitlist"] }, startedAt: { $gte: startedAt } });
    if (siteBefore) await Account.updateOne({ _id: siteId }, { $set: { "tokens.scope": siteBefore.tokens && siteBefore.tokens.scope, needsReauth: !!siteBefore.needsReauth } });
    else await Account.deleteOne({ _id: siteId });
    await mongoose.disconnect();
  }
})().catch((e) => {
  console.error(`verify-waitlist-dms FAILED: ${e.message}`);
  process.exit(1);
});
