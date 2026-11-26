// Accounts: creating one from a sign-in, and handing the sync a working X access token.
// Reads config (the X app credentials + the token key), so it's for the entry points and routes; services/sync.js
// never imports it — callers pass runSync a getToken function built here.
"use strict";

const config = require("../config");
const { createSealer } = require("../lib/crypto");
const { refreshTokens, revokeToken, creditBalance } = require("../lib/x");
const Account = require("../models/Account");
const LiveEvent = require("../models/LiveEvent");

const sealer = createSealer(config.tokenKey);
const REFRESH_EARLY_MS = 5 * 60 * 1000; // refresh when under 5 minutes are left, so a run never starts on a dying token

// runSync recognises this by its code (it doesn't import this module), and skips the account.
class NeedsReauth extends Error {
  constructor(message) {
    super(message);
    this.code = "NEEDS_REAUTH";
  }
}

function sealTokens(t) {
  return { access: sealer.seal(t.accessToken), refresh: sealer.seal(t.refreshToken), expiresAt: t.expiresAt, scope: t.scope };
}

// An admin (config.admins, ADMIN_IDS): the Admin page (routes/admin.js) and its sidebar item. By the account's X user
// id, which never changes hands (a username does: verify-security checks a renamed account isn't one).
const isAdmin = (account) => !!(account && account._id && config.admins.has(String(account._id)));

// The site's own X account (SITE_X, a handle: the site holds it on X, so it can't change hands), whose one grant also
// sends the waitlist's DMs (features.SCOPES_SITE). `user`: X's /users/me, or an Account.
const isSiteAccount = (user) => !!(config.siteX && user && String(user.username || "").toLowerCase() === config.siteX.toLowerCase());
// Does a grant's scope string (X's, kept on Account.tokens.scope) include `scope`?
const hasScope = (scopes, scope) => String(scopes || "").split(/\s+/).includes(scope);

// Sign-in may create an account only for the allowlist (config.signup: X user ids, or usernames); an existing account
// always may. An id is the safe entry: a username changes hands on X, so whoever renames their own account to an
// allowlisted handle that hasn't signed up yet would get in.
function maySignIn(existing, username, userId) {
  if (existing || config.signup.anyone) return true;
  return config.signup.ids.has(String(userId || "")) || config.signup.usernames.has(String(username).toLowerCase());
}

async function saveSignIn(user, tokens) {
  return Account.findOneAndUpdate(
    { _id: user.id },
    {
      $set: {
        username: user.username,
        ...Account.selfFields(user),
        postCount: user.public_metrics && user.public_metrics.tweet_count,
        likeCount: user.public_metrics && user.public_metrics.like_count,
        tokens: sealTokens(tokens),
        needsReauth: false,
        lastLoginAt: new Date(),
        "live.due": true, // a new grant (scopes may differ): the worker re-ensures its live subscriptions (services/live.js)
      },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  ).lean();
}

// A usable access token for this account, refreshing (and saving X's rotated pair) when it's about to expire.
// Throws NeedsReauth when X refuses the refresh; the account is marked so the scheduler stops trying.
//
// X ROTATES refresh tokens, so two refreshes racing on one account (a sync + the owner's balance reading, a button
// press + the scheduler, web + worker) would have the second refused and wrongly sign the account out. So: one
// refresh per account at a time in this process (inFlight), and a refused refresh first re-reads the account —
// if another process already saved a newer pair, that's the token, not a reason to sign out.
const inFlight = new Map();
function accessToken(accountId) {
  const id = String(accountId);
  if (!inFlight.has(id)) inFlight.set(id, freshToken(id).finally(() => inFlight.delete(id)));
  return inFlight.get(id);
}

async function freshToken(id) {
  const doc = await Account.findById(id, "tokens needsReauth").lean();
  if (!doc || !doc.tokens || !doc.tokens.access || doc.needsReauth) throw new NeedsReauth("sign in again to resume syncing");
  if (doc.tokens.expiresAt && doc.tokens.expiresAt.getTime() - Date.now() > REFRESH_EARLY_MS) return sealer.open(doc.tokens.access);

  let fresh;
  try {
    fresh = await refreshTokens(config.x, sealer.open(doc.tokens.refresh));
  } catch (err) {
    if (err.status === 400 || err.status === 401) {
      const now = await Account.findById(id, "tokens").lean();
      const rotated = now && now.tokens && now.tokens.expiresAt && doc.tokens.expiresAt && now.tokens.expiresAt > doc.tokens.expiresAt;
      if (rotated) return sealer.open(now.tokens.access); // another process refreshed first
      await Account.updateOne({ _id: id }, { $set: { needsReauth: true, "live.due": true } }); // its live subscriptions go too
      throw new NeedsReauth(`X refused the token refresh (${err.message}); sign in again to resume syncing`);
    }
    throw err; // X down, network: try again next tick
  }
  await Account.updateOne({ _id: id }, { $set: { tokens: sealTokens(fresh) } });
  return fresh.accessToken;
}

// End xtoolio's access on X (deleting an account, services/deleteAccount.js): both tokens revoked, the refresh token
// first (it IS the grant). → true when X took it; false when there was nothing to revoke or X refused (the person can
// still remove the app in X's settings; the account and its sealed tokens are deleted either way).
async function revokeGrant(accountId) {
  const acct = await Account.findById(accountId, "tokens").lean();
  if (!acct || !acct.tokens || !acct.tokens.refresh) return false;
  try {
    await revokeToken(config.x, sealer.open(acct.tokens.refresh), "refresh_token");
    await revokeToken(config.x, sealer.open(acct.tokens.access)).catch(() => {}); // usually gone with the grant already
    return true;
  } catch (err) {
    console.error(`[accounts] revoking ${accountId}'s grant on X: ${err.message}`);
    return false;
  }
}

// The app owner (config.x.ownerId): the developer account that pays X. Its own reads are Owned Reads, and only it
// sees the real balance (the Usage page).
const isOwner = (accountId) => !!config.x.ownerId && accountId === config.x.ownerId;

// X's real credit balance, read with the owner's token by THE BALANCE CLOCK (services/balanceClock.js, once a minute).
// null when no owner is configured. Each reading is also kept on the owner's account (Account.xBalance) for the
// header.
async function readOwnerBalance() {
  if (!config.x.ownerId) return null;
  const b = await creditBalance(await accessToken(config.x.ownerId));
  if (b && Number.isFinite(b.usd)) {
    const was = await Account.findOneAndUpdate({ _id: config.x.ownerId }, { $set: { xBalance: { usd: b.usd, at: new Date() } } }, { projection: { xBalance: 1 } })
      .lean()
      .catch((e) => console.error(`[accounts] saving the header's X balance failed: ${e.message}`));
    // The owner's open pages hear of a change (services/livePush.js), not of every reading.
    if (was && (!was.xBalance || was.xBalance.usd !== b.usd)) await LiveEvent.note(config.x.ownerId, "balance");
  }
  return b && { ...b, owner: config.x.ownerId }; // whose balance it is: the clock measures moves per owner
}

// What every metered unit needs from config (services/usage.js metered + lib/x.js createClient): the owner (Owned
// Reads) and billing (each unit an account runs is charged to its balance when it closes).
const meterSettings = () => ({ ownerId: config.x.ownerId, billing: require("./billing") });

// The settings every runSync caller passes for one account (the scheduler, Sync now, a new sign-in, the CLI).
function syncSettings(accountId, readCap = config.sync.readCap) {
  return {
    accountId,
    getToken: () => accessToken(accountId),
    readCap,
    contextCap: config.sync.contextCap,
    userCap: config.sync.userCap,
    extras: { likesCap: config.extras.likesCap, likersUserCap: config.extras.likersUserCap },
    ...meterSettings(),
    // An Owned Read is X's price only when the token IS the owner's as well as the user read (X: "when {id} is the
    // authenticated user AND the app's owner"): another account reading the owner's posts (a Likestorm, Who they tag)
    // pays the post price, so its client prices it that way.
    ownerId: isOwner(accountId) ? config.x.ownerId : null,
  };
}

module.exports = { maySignIn, isAdmin, isSiteAccount, hasScope, saveSignIn, accessToken, revokeGrant, syncSettings, meterSettings, isOwner, readOwnerBalance, NeedsReauth };
