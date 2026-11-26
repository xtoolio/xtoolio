// THE WAITLIST (launch readiness; reshaped: a DM to each person let in, no
// public numbers; an admin chooses whom to let in, by hand at first). Sign-up stays closed to anyone not invited (ALLOWED_USERNAMES): instead of refusing them, a sign-in puts
// them ON THE WAITLIST (who they are, when they joined) and their X sign-in is revoked at once (routes/auth.js). An
// admin GRANTS people one at a time (Admin → Waitlist, routes/admin.js), and each grant sends them a "you're in" DM
// from the site's own X account (services/waitlistDms.js). Someone granted signs in again and gets an account like any
// invitee. No numbers, no line, nothing posted publicly. Sign-up open to anyone ("*") never reaches here.
"use strict";

const Waitlist = require("../models/Waitlist");
const Person = require("../models/Person");
const Account = require("../models/Account");
const { createClient } = require("../lib/x");
const { metered } = require("./usage");

// Who someone is, as X said (its /users/me or a profile read): the fields a row keeps.
const profileOf = (user) => ({
  username: user.username,
  name: user.name || undefined,
  image: Person.imageOf(user.profile_image_url),
  followers: user.public_metrics ? user.public_metrics.followers_count : undefined,
});

// On the waitlist, joining if they aren't (a second sign-in refreshes who they are, keeps when they joined). → the row
async function join(user) {
  return Waitlist.findOneAndUpdate({ _id: user.id }, { $set: profileOf(user), $setOnInsert: { joinedAt: new Date() } }, { upsert: true, returnDocument: "after" }).lean();
}

// Where someone stands: on the list, and whether they've been let in. null: not on it.
async function standing(id) {
  if (!id) return null; // no place to look up (a visitor who hasn't joined): no query
  const row = await Waitlist.findById(String(id), "username grantedAt").lean();
  return row ? { username: row.username, granted: !!row.grantedAt } : null;
}

// May this X user make an account because an admin let them in?
const isGranted = async (id) => !!(await Waitlist.exists({ _id: String(id), grantedAt: { $exists: true } }));

// They made their account (the sign-in that let them in). → nothing
const signedUp = (id) => Waitlist.updateOne({ _id: id, signedUpAt: { $exists: false } }, { $set: { signedUpAt: new Date() } });

// Admin → Grant: let one person in. Once (a second press changes nothing). → the row as granted, or null (not on it)
async function grant(id, by) {
  await Waitlist.updateOne({ _id: String(id), grantedAt: { $exists: false } }, { $set: { grantedAt: new Date(), grantedBy: by } });
  return Waitlist.findById(String(id)).lean();
}

// Admin → INVITE: let someone in by their @handle, before they've joined. X is asked who the handle is NOW (a handle
// changes hands, so a row or account under that name may be someone else): one profile read with the admin's own
// token ($0.01, deduped per UTC day), the platform's cost (kind "invite", no account: Admin → P&L's Invites row). Then by their X id: an
// account already → nothing; on the waitlist → granted (their profile refreshed); not → a row made for them, marked
// `invitedAt`, granted. Their sign-in then makes an account like any Grant's (routes/auth.js isGranted), and the
// worker reads whether they follow the site's account as it does for anyone who joins (waitlistDms checkFollows).
// `lookup` is for verify only (a stub of the client's userByUsername).
// → { status: "invited" | "granted" | "already" | "account" | "unknown", row? }
async function invite(handle, { by, token, lookup = null }) {
  const label = `Waitlist: invite @${handle}`; // named first: verify-billing reads metered()'s options up to their first }
  const user = await metered({ kind: "invite", label, dropEmpty: true }, async (meter) => {
    const x = lookup ? { userByUsername: lookup } : createClient({ token: await token(), meter, readCap: 0, userCap: 1 });
    return x.userByUsername(handle);
  });
  if (!user) return { status: "unknown" };
  return admit(user, by);
}

// LET SOMEONE IN by an invite (the admin's, or a link: services/invites.js), as X says who they are. An account
// already → nothing; on the waitlist → granted; not → a row made for them (`invitedAt`) and granted. `invitedBy`: the
// account whose link it was (set on their row either way; a link is only redeemed by someone not yet granted).
// → { status: "invited" | "granted" | "already" | "account", row? }
async function admit(user, by, { invitedBy } = {}) {
  if (await Account.exists({ _id: user.id })) return { status: "account" };
  const now = new Date();
  const set = { ...profileOf(user), ...(invitedBy ? { invitedBy } : {}) };
  const before = await Waitlist.findOneAndUpdate({ _id: user.id }, { $set: set, $setOnInsert: { joinedAt: now, invitedAt: now } }, { upsert: true, returnDocument: "before" }).lean();
  if (before && before.grantedAt) return { status: "already", row: before };
  return { status: before ? "granted" : "invited", row: await grant(user.id, by) };
}

// THE INVITE CREDIT (config.billing.inviteCreditUsd, INVITE_CREDIT_USD): an admin's Invite PROMISES it on the person's
// row (`creditMicros`; an invite link never does, nor a Grant), and their first sign-in PAYS it, once: THE one mover
// (billing.credit, a "credit" row on their statement, keyed "invite-credit:<id>", so a second sign-in or a retry moves
// nothing), then `creditedAt`. Promised again (pressed twice, or for someone invited before the credit existed) changes
// nothing once paid. Never the owner (it isn't charged).
async function promiseCredit(id, micros) {
  if (!(micros > 0)) return;
  await Waitlist.updateOne({ _id: String(id), creditedAt: { $exists: false } }, { $set: { creditMicros: micros } });
}
// → the move (null: nothing promised, already paid, or the owner)
async function payCredit(id, billing) {
  const row = await Waitlist.findOne({ _id: String(id), creditMicros: { $gt: 0 }, creditedAt: { $exists: false } }, "creditMicros").lean();
  if (!row || billing.isOwner(String(id))) return null;
  const moved = await billing.credit(String(id), row.creditMicros, { kind: "credit", ref: `invite-credit:${id}`, label: `$${(row.creditMicros / 1e6).toFixed(2)} credit: welcome` });
  await Waitlist.updateOne({ _id: String(id) }, { $set: { creditedAt: new Date() } });
  return moved;
}

// The Admin page's two lists. Waiting: who's been there longest first. Granted: the latest first. At most SHOWN.
const SHOWN = 500;
const VIEWS = {
  waiting: { filter: { grantedAt: { $exists: false } }, sort: { joinedAt: 1 } },
  granted: { filter: { grantedAt: { $exists: true } }, sort: { grantedAt: -1 } },
};
async function list(view) {
  const v = VIEWS[view] || VIEWS.waiting;
  const [rows, waiting, granted] = await Promise.all([
    Waitlist.find(v.filter).sort(v.sort).limit(SHOWN).lean(),
    Waitlist.countDocuments(VIEWS.waiting.filter),
    Waitlist.countDocuments(VIEWS.granted.filter),
  ]);
  return { rows, counts: { waiting, granted } };
}

module.exports = { profileOf, join, standing, isGranted, signedUp, grant, invite, admit, promiseCredit, payCredit, list, VIEWS };
