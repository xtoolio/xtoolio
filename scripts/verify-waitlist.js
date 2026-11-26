// verify-waitlist: THE WAITLIST (services/waitlist.js) against a TEST database: joining keeps who someone is (and a
// second sign-in refreshes it, keeping when they joined), nobody is let in until an admin grants them, a grant is once
// (a second press changes nothing) and lets exactly that person in, signing up is recorded, and the Admin page's two
// lists (Waiting oldest first, Granted latest first) and their counts; an INVITE by handle (X stubbed): unknown, an
// account already, someone who never joined (a row made, granted), again (already in), someone waiting (granted); and
// THE INVITE LINKS: one per account, never your own, more sign-ins at once than places (exactly the limit get in),
// the same person twice, the page and Settings' view. Refuses any database whose name doesn't say
// "test" (on production it would let real people in). Part of `npm run verify:db`. Writes only rows with its own
// random ids, and deletes them.
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const mongoose = require("mongoose");
const config = require("../config");
const { connect } = require("../lib/db");
const waitlist = require("../services/waitlist");
const Waitlist = require("../models/Waitlist");
const Account = require("../models/Account");
const InviteCode = require("../models/InviteCode");
const BalanceEntry = require("../models/BalanceEntry");
const invites = require("../services/invites");

const rnd = () => crypto.randomBytes(4).readUInt32BE(0);
const users = [1, 2, 3].map((i) => ({
  id: `96${String(rnd()).padStart(10, "0")}${i}`,
  username: `verify-waitlist-${i}`,
  name: `Verify ${i}`,
  profile_image_url: `https://pbs.twimg.com/profile_images/1/verify${i}_normal.jpg`,
  public_metrics: { followers_count: i * 100 },
}));
const guests = [6, 7, 8, 9, 0, 1].map((i) => ({ id: `97${String(rnd()).padStart(10, "0")}${i}`, username: `verify-guest-${i}`, name: `Guest ${i}` }));
const [newcomer, member] = [4, 5].map((i) => ({ id: `96${String(rnd()).padStart(10, "0")}${i}`, username: `verify-wl-${i}-${rnd() % 1000}`, name: `Verify ${i}` }));

let checks = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  checks++;
};

(async () => {
  await connect(config);
  if (!/test/i.test(mongoose.connection.name)) {
    console.log(`verify-waitlist: skipped (database "${mongoose.connection.name}" isn't a test database)`);
    return mongoose.disconnect();
  }
  const ids = users.map((u) => u.id);
  try {
    for (const u of users) await waitlist.join(u);
    const first = await Waitlist.findById(users[0].id).lean();
    ok(first.username === users[0].username && first.name === "Verify 1" && /_bigger\.jpg$/.test(first.image) && first.followers === 100 && first.joinedAt, "joining keeps who they are (the picture at X's 73px size) and when");
    await waitlist.join({ ...users[0], name: "Renamed" });
    const again = await Waitlist.findById(users[0].id).lean();
    ok(again.name === "Renamed" && +again.joinedAt === +first.joinedAt, "a second sign-in refreshes who they are and keeps when they joined");
    ok(!("n" in again), "no number");

    ok(!(await waitlist.isGranted(users[0].id)), "nobody's in until an admin grants them");
    ok((await waitlist.standing(users[0].id)).granted === false && (await waitlist.standing("nobody")) === null, "standing: on it, not granted; someone not on it has none");

    const g = await waitlist.grant(users[1].id, "admin-1");
    ok(g && g.grantedAt && g.grantedBy === "admin-1", "Grant lets them in, recording who");
    ok((await waitlist.isGranted(users[1].id)) && !(await waitlist.isGranted(users[0].id)) && !(await waitlist.isGranted(users[2].id)), "exactly that person is in");
    const at = g.grantedAt;
    ok(+(await waitlist.grant(users[1].id, "admin-2")).grantedAt === +at, "a second Grant changes nothing");
    ok((await waitlist.grant("nobody-here", "admin-1")) === null, "Grant on someone not on the list: nothing");

    await waitlist.signedUp(users[1].id);
    ok((await Waitlist.findById(users[1].id).lean()).signedUpAt, "signing up is recorded");

    const waiting = await waitlist.list("waiting");
    const mine = waiting.rows.filter((r) => ids.includes(r._id)).map((r) => r._id);
    ok(mine.join() === [users[0].id, users[2].id].join(), "Waiting: the two not granted, who's waited longest first");
    const granted = await waitlist.list("granted");
    ok(granted.rows.some((r) => r._id === users[1].id) && !granted.rows.some((r) => r._id === users[0].id), "Granted: the one granted");
    ok(waiting.counts.waiting >= 2 && waiting.counts.granted >= 1, "the counts the tabs wear");

    // INVITE by @handle (X stubbed: who the handle is NOW is X's answer, by id).
    const byHandle = new Map([...users, newcomer, member].map((u) => [u.username.toLowerCase(), u]));
    const lookup = async (h) => byHandle.get(h.toLowerCase()) || null;
    const inv = (h) => waitlist.invite(h, { by: "admin-1", lookup });
    ok((await inv("verify-nobody")).status === "unknown", "a handle X doesn't have: nothing");
    await Account.create({ _id: member.id, username: member.username });
    ok((await inv(member.username)).status === "account" && !(await Waitlist.exists({ _id: member.id })), "someone with an account already: nothing, no row");
    const fresh = await inv(newcomer.username.toUpperCase());
    ok(fresh.status === "invited" && fresh.row.invitedAt && fresh.row.grantedAt && fresh.row.grantedBy === "admin-1" && +fresh.row.joinedAt === +fresh.row.invitedAt, "someone who never joined: a row made for them, invited and granted");
    ok(await waitlist.isGranted(newcomer.id), "an invitee is let in");
    ok((await inv(newcomer.username)).status === "already", "inviting them again: already in");
    const listed = await inv(users[0].username);
    ok(listed.status === "granted" && listed.row.grantedAt && !listed.row.invitedAt && +listed.row.joinedAt === +first.joinedAt, "someone already waiting: granted, keeping when they joined, not marked invited");

    // THE INVITE CREDIT: promised on the row by an admin's Invite, paid ONCE at their first sign-in (THE one mover).
    {
      const billing = require("../services/billing");
      await Account.create({ _id: newcomer.id, username: newcomer.username, balanceMicros: 0 });
      ok((await waitlist.payCredit(newcomer.id, billing)) === null, "nothing promised: nothing paid");
      await waitlist.promiseCredit(newcomer.id, 50e6);
      const paid = await waitlist.payCredit(newcomer.id, billing);
      const bal = async () => (await Account.findById(newcomer.id, "balanceMicros").lean()).balanceMicros;
      ok(paid && (await bal()) === 50e6 && (await Waitlist.findById(newcomer.id).lean()).creditedAt, "promised $50: paid at sign-in, the balance $50");
      ok((await waitlist.payCredit(newcomer.id, billing)) === null && (await bal()) === 50e6, "a second sign-in pays nothing");
      await waitlist.promiseCredit(newcomer.id, 80e6);
      ok((await Waitlist.findById(newcomer.id).lean()).creditMicros === 50e6 && (await waitlist.payCredit(newcomer.id, billing)) === null && (await bal()) === 50e6, "promised again once paid: nothing changes");
      ok(await BalanceEntry.exists({ accountId: newcomer.id, kind: "credit", ref: `invite-credit:${newcomer.id}` }), "a credit row on their statement");
    }

    // THE INVITE LINKS (services/invites.js): `member` (an account) has a link with config.invites.perAccount places.
    if (invites.enabled()) {
      const max = config.invites.perAccount;
      const code = (await invites.codeFor(member.id))._id;
      ok(invites.CODE.test(code) && (await invites.codeFor(member.id))._id === code, "one link per account, made once");
      ok((await invites.redeem(code, member)) === null, "you can't take a place on your own link");
      ok((await invites.redeem(code, guests[0])) === member.id && (await invites.redeem(code, guests[0])) === null, "the same person never takes two places");
      // More sign-ins at once than the places left: exactly that many get one.
      const rest = guests.slice(1);
      const won = await Promise.all(rest.map((g) => invites.redeem(code, g)));
      ok(won.filter((w) => w === member.id).length === max - 1, `${rest.length} at once, ${max - 1} places left: exactly ${max - 1} let in`);
      const winner = rest[won.indexOf(member.id)];
      ok((await invites.redeem(code, rest[won.indexOf(null)])) === null, "a full link takes no one");
      const doc = await InviteCode.findById(code).lean();
      ok(doc.used.length === max && new Set(doc.used.map((u) => u.id)).size === max, "each place once, never past the limit");
      const a = await waitlist.admit(winner, member.id, { invitedBy: member.id });
      ok(a.status === "invited" && a.row.invitedBy === member.id && a.row.grantedBy === member.id && (await waitlist.isGranted(winner.id)), "the link's guest is let in, by that account");
      const page = await invites.pageFor(code);
      ok(page && page.from.id === member.id && page.open === false && (await invites.pageFor("nope")) === null, "the page: whose link, and that it's used up; a bad code is none");
      const view = await invites.viewFor({ _id: member.id });
      ok(view.left === 0 && view.max === max && view.url.endsWith(`/i/${code}`) && view.people.length === max, "Settings: none left, and who came in");
    } else console.log("verify-waitlist: invite links off here (sign-up open, or INVITES_PER_ACCOUNT=0): not checked");
    console.log(`verify-waitlist: ${checks} checks pass`);
  } finally {
    await Waitlist.deleteMany({ _id: { $in: [...ids, newcomer.id, member.id, ...guests.map((g) => g.id)] } });
    await InviteCode.deleteMany({ accountId: member.id });
    await Account.deleteOne({ _id: member.id, username: member.username });
    await Account.deleteOne({ _id: newcomer.id, username: newcomer.username });
    await BalanceEntry.deleteMany({ accountId: newcomer.id });
    await mongoose.disconnect();
  }
})().catch((e) => {
  console.error(`verify-waitlist FAILED: ${e.message}`);
  process.exit(1);
});
