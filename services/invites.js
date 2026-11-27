// THE INVITE LINKS: every account has one link (/i/<code>, models/InviteCode.js) and config.invites.perAccount (5)
// people can sign up through it, skipping the waitlist. Quiet by design: it sits in Settings → Invites, nowhere else.
// Only while sign-up isn't open to anyone (`enabled`).
//
//   THE PAGE     /i/<code> (routes/auth.js): who invited you, and Sign in with X carrying the code (?invite=). A link
//                whose places are taken, or that doesn't exist, says so and offers the waitlist.
//   REDEEM       the sign-in's callback, ONLY for someone who wouldn't otherwise get in (not an account, not
//                allowlisted, not granted): one place taken atomically (never past the limit, never twice by the same
//                person), then their waitlist row granted, `invitedBy` the inviter (services/waitlist.js admit), and the
//                sign-in goes on to make their account. Someone who's in anyway takes no place.
// Nothing here talks to X: the invitee's own sign-in already said who they are.
"use strict";

const crypto = require("crypto");
const config = require("../config");
const InviteCode = require("../models/InviteCode");
const Account = require("../models/Account");
const BalanceEntry = require("../models/BalanceEntry");

const CODE = /^[A-Za-z0-9_-]{12}$/;
const newCode = () => crypto.randomBytes(9).toString("base64url"); // 12 characters, 72 random bits

const enabled = () => !config.signup.anyone && config.invites.perAccount > 0;
const linkOf = (code) => `${config.appOrigin}/i/${code}`;

// WHO MAY INVITE, where the site charges: an account that has PAID (a top-up or an auto-refill: real money, never a
// credit given), an admin, or the owner. Until this every account had a link, those who came in through one too, so
// one person with five spare X accounts let in 25, then 125, past the waitlist with no admin and no money. With billing
// off (a copy that charges nobody) everyone may, as before. Checked when the link is shown, opened and used.
async function mayInvite(accountId) {
  const id = String(accountId);
  if (!config.billing.enabled || config.admins.has(id) || id === config.x.ownerId) return true;
  return !!(await BalanceEntry.exists({ accountId: id, kind: { $in: ["topup", "auto-refill"] } }));
}

// This account's code, made the first time it's asked for (two at once: the unique accountId keeps one). → the doc
async function codeFor(accountId) {
  const id = String(accountId);
  const have = await InviteCode.findOne({ accountId: id }).lean();
  if (have) return have;
  try {
    return (await InviteCode.create({ _id: newCode(), accountId: id, createdAt: new Date() })).toObject();
  } catch (err) {
    if (err.code === 11000) return InviteCode.findOne({ accountId: id }).lean();
    throw err;
  }
}

// Settings → Invites: the link, how many places are left, and who came in through it (their faces). null: invites off.
async function viewFor(account) {
  if (!enabled()) return null;
  const max = config.invites.perAccount;
  if (!(await mayInvite(account._id))) return { locked: true, max };
  const doc = await codeFor(account._id);
  const used = doc.used || [];
  const who = new Map((await Account.find({ _id: { $in: used.map((u) => u.id) } }, "username name image").lean()).map((a) => [a._id, a]));
  return {
    url: linkOf(doc._id),
    max,
    left: Math.max(0, max - used.length),
    // Who came in, as they are now; someone who deleted their account since still holds the place, unnamed, unshown.
    people: used.filter((u) => u.id).map((u) => {
      const a = who.get(u.id);
      return { id: u.id, username: (a && a.username) || u.username, profile: a ? { name: a.name, image: a.image } : null };
    }),
  };
}

// The invite page's facts for a code: whose it is and whether a place is left. null: no such link (or invites off).
async function pageFor(code) {
  if (!enabled() || !CODE.test(String(code))) return null;
  const doc = await InviteCode.findById(String(code)).lean();
  if (!doc) return null;
  const from = await Account.findById(doc.accountId, "username name image").lean();
  if (!from) return null;
  const open = (doc.used || []).length < config.invites.perAccount && (await mayInvite(doc.accountId));
  return { code: doc._id, from: { id: from._id, username: from.username, profile: { name: from.name, image: from.image } }, open };
}

// Take one place on `code` for X user `user` (the sign-in's /users/me). Atomic: never past the limit, never twice for the
// same person. → the inviter's account id, or null (no such link, full, or invites off)
async function redeem(code, user) {
  if (!enabled() || !CODE.test(String(code || ""))) return null;
  const link = await InviteCode.findById(String(code), "accountId").lean();
  if (!link || !(await mayInvite(link.accountId))) return null; // its owner may not invite (hasn't paid): no place taken
  const doc = await InviteCode.findOneAndUpdate(
    { _id: String(code), accountId: { $ne: String(user.id) }, "used.id": { $ne: String(user.id) }, $expr: { $lt: [{ $size: "$used" }, config.invites.perAccount] } },
    { $push: { used: { id: String(user.id), username: user.username, at: new Date() } } },
    { returnDocument: "after", projection: { accountId: 1 } }
  ).lean();
  return doc ? doc.accountId : null;
}

module.exports = { CODE, enabled, mayInvite, codeFor, viewFor, pageFor, redeem };
