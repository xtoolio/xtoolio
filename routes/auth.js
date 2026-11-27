// Sign in with X: OAuth 2.0 authorization code + PKCE, as a confidential client (lib/x.js has the protocol).
//
//   GET  /auth/x           → a fresh state + PKCE verifier (and the browser's ?tz=) in the session, then off to X's
//                            consent screen
//   GET  /auth/x/callback  → state checked (constant-time, 10-minute window), code exchanged, who-is-this asked,
//                            the allowlist applied to NEW accounts (anyone else goes on THE WAITLIST,
//                            services/waitlist.js, unless an admin granted them), tokens sealed, the modules picked on the front
//                            page turned on (a new account), session regenerated. No sync starts here: the worker
//                            finds the account within seconds (services/scheduler.js); one with nothing picked is
//                            asked first (web.js startView).
//   GET  /i/:code          → AN INVITE LINK's page (services/invites.js): who invited you, Sign in with X ?invite=
//   POST /accounts/switch  → THE ACCOUNT SWITCHER: another account signed in on this browser becomes the active one
//                            (lib/sessionAccounts.js: up to 5, X's own model; a sign-in while signed in adds one)
//   POST /logout           → out of the active account (the next one here takes over), or all of them; background
//                            syncing continues (the account still exists)
//   THE SITE'S OWN ACCOUNT (SITE_X) is also the waitlist's DM sender, on its one grant: a sign-in of it that X granted
//   without dm.write goes straight back to X once for features.SCOPES_SITE (asking first can't know who will sign in).
//
// The callback URL is built from APP_ORIGIN and must match one registered in X's console exactly.
"use strict";

const express = require("express");
const config = require("../config");
const { pkcePair, authorizeUrl, exchangeCode, revokeToken, createClient } = require("../lib/x");
const { randomToken, safeEqual } = require("../lib/crypto");
const { zoneFor } = require("../lib/timezone");
const { cookieTheme } = require("../lib/theme");
const Account = require("../models/Account");
const { maySignIn, saveSignIn, meterSettings, isSiteAccount, hasScope } = require("../services/accounts");
const { metered } = require("../services/usage");
const billing = require("../services/billing");
const { SCOPES_ALL, SCOPES_JOIN, SCOPES_SITE } = require("../services/features");
const waitlist = require("../services/waitlist");
const waitlistDms = require("../services/waitlistDms");
const invites = require("../services/invites");
const sessionAccounts = require("../lib/sessionAccounts");

const SESSION_COOKIE = "xt.sid";
const PENDING_MAX_MS = 10 * 60 * 1000;
const callbackUrl = `${config.appOrigin}/auth/x/callback`;

const router = express.Router();

// Every sign-in asks X for EVERY scope (features.SCOPES_ALL: the reads and the writes; no half state), so a
// grant is never narrower than what the account uses and switching a module on in Settings never leaves the site. Signing in turns nothing on: a new account lands on the start page, which turns on
// everything by default (or what it chose) together with how far back to read, priced against its balance (?add=
// once carried the front page's picks here and turned them on, which skipped that page).
// ?back=: where to land after, ONLY an app's approve page (routes/agents.js: someone connecting Claude or ChatGPT while
// signed out). Exactly that shape, never an open redirect.
const BACK = /^\/oauth\/approve\?r=[A-Za-z0-9_-]{32}$/;
// ?join=1: "Join the waitlist" (partials/get-started.hbs): X is asked only who you are (features.SCOPES_JOIN), never
// for the writes a new account needs; the callback sends anyone who turns out to be let in on to the full sign-in.
// ?another=1: THE ACCOUNT SWITCHER's "Add an account" (partials/account-menu.hbs), signed in already: the callback adds
// whoever X signs in beside the accounts here (any sign-in while signed in does), and only this one says so when X signs
// in the account you're already on (X's consent uses whichever account x.com is on).
router.get("/auth/x", (req, res, next) => {
  const join = req.query.join === "1";
  // ?tz= is the browser's time zone (the landing page's sign-in form; lib/timezone.js), kept for the callback.
  const back = BACK.test(String(req.query.back || "")) ? String(req.query.back) : null;
  // ?invite=<code>: from an INVITE LINK's page (/i/<code>, below), redeemed by the callback if they need it.
  const invite = invites.CODE.test(String(req.query.invite || "")) ? String(req.query.invite) : null;
  begin(req, res, next, join ? SCOPES_JOIN : SCOPES_ALL, { tz: zoneFor(req.query.tz), back, join, invite, another: req.query.another === "1" && !!req.account });
});

// THE start of a sign-in with X: a fresh state + PKCE verifier in the session (with `extra`, for the callback), then
// off to X asking for `scopes`.
function begin(req, res, next, scopes, extra = {}) {
  const { verifier, challenge } = pkcePair();
  const state = randomToken();
  req.session.oauth = { state, verifier, at: Date.now(), ...extra };
  // Signed out, this is a visitor's FIRST stored session: it lives only as long as the sign-in may take, so a bot (or
  // anyone) following "Sign in" links can't fill the session store with month-long rows. Signing in regenerates the
  // session at the full length; going on the waitlist restores it.
  if (!req.session.accountId) req.session.cookie.maxAge = PENDING_MAX_MS;
  // Saved before the redirect, so the callback can't arrive ahead of the session write.
  req.session.save((err) => (err ? next(err) : res.redirect(authorizeUrl({ clientId: config.x.clientId, redirectUri: callbackUrl, state, challenge, scopes }))));
}

router.get("/auth/x/callback", async (req, res, next) => {
  const pending = req.session.oauth;
  delete req.session.oauth; // one use, whatever happens next
  // The accounts already signed in on this browser (THE ACCOUNT SWITCHER): the new one joins them, read before the
  // session is regenerated below.
  const prior = sessionAccounts.listOf(req.session);
  // Each outcome lands on home with ?n=signin-<outcome>: the toast says it (lib/notices.js).
  if (req.query.error) return res.redirect("/?n=signin-cancelled");
  const fresh = pending && Date.now() - pending.at < PENDING_MAX_MS;
  if (!fresh || !req.query.code || !safeEqual(pending.state, req.query.state)) return res.redirect("/?n=signin-expired");

  let tokens;
  let me;
  try {
    tokens = await exchangeCode(config.x, { code: String(req.query.code), redirectUri: callbackUrl, verifier: pending.verifier });
    // Who signed in: one billed user read, metered like any other (the ledger row learns its account from X's answer).
    const { ownerId } = meterSettings();
    me = await metered({ kind: "signin", label: "Sign-in" }, async (meter) => {
      const user = await createClient({ token: tokens.accessToken, meter, ownerId, readCap: 0, userCap: 1 }).me();
      await meter.setAccount(user.id);
      return user;
    });
  } catch (err) {
    console.error(`sign-in failed: ${err.message}`);
    return res.redirect("/?n=signin-failed");
  }

  // dm.write is only ever kept on the site's own account: asked for it (below) but someone else signed in on X
  // meanwhile, that grant is revoked whole (the refresh token IS the grant) and they start a plain sign-in.
  if (pending.site && !isSiteAccount(me)) {
    await revokeToken(config.x, tokens.refreshToken || tokens.accessToken, tokens.refreshToken ? "refresh_token" : "access_token").catch(() => {});
    return res.redirect("/auth/x");
  }
  const existing = await Account.exists({ _id: me.id });
  // Not invited and not granted from THE WAITLIST (services/waitlist.js): they go on it (or stay), the token is revoked
  // (nothing is kept but who they are), and the waitlist page says so. The session holds only which row to show (no
  // account, no sign-in).
  const invited = maySignIn(existing, me.id);
  let fromLine = !invited && (await waitlist.isGranted(me.id));
  // Not in any other way, but came through an INVITE LINK (services/invites.js): one of its places taken (atomically:
  // never past the limit), their waitlist row granted by that account, and they go on to make their account.
  if (!invited && !fromLine && pending.invite) {
    const by = await invites.redeem(pending.invite, me);
    if (by) {
      await waitlist.admit(me, by, { invitedBy: by });
      fromLine = true;
    }
  }
  if (!invited && !fromLine) {
    await revokeToken(config.x, tokens.accessToken).catch(() => {}); // don't keep a token we won't use
    await waitlist.join(me);
    // Added from the switcher: the accounts here stay signed in, the toast says where that one stands.
    if (prior.length) return req.session.save((err) => (err ? next(err) : res.redirect("/?n=account-waitlist")));
    req.session.waitlist = me.id;
    req.session.cookie.maxAge = config.sessionDays * 24 * 3600 * 1000; // kept like any session (begin() shortened it)
    return req.session.save((err) => (err ? next(err) : res.redirect("/waitlist")));
  }
  // The site's own account, let in, signed in without dm.write (a sign-in asks SCOPES_ALL, or SCOPES_JOIN from "Join the
  // waitlist": who's signing in isn't known until now): straight back to X, once, for SCOPES_SITE. Its new grant
  // replaces this one on X, so there's still exactly one.
  if (isSiteAccount(me) && !hasScope(tokens.scope, "dm.write") && !pending.site) {
    return begin(req, res, next, SCOPES_SITE, { tz: pending.tz, back: pending.back, site: true });
  }
  // Let in (invited, an existing account, or granted) but through "Join the waitlist", which asked X only
  // who they are: that grant can't run an account, so it's dropped and they go on to the full sign-in (X asks again).
  if (pending.join) {
    await revokeToken(config.x, tokens.accessToken).catch(() => {});
    return res.redirect(`/auth/x${pending.tz ? `?tz=${encodeURIComponent(pending.tz)}` : ""}`);
  }
  const account = await saveSignIn(me, tokens);
  if (fromLine) await waitlist.signedUp(me.id);
  // THE INVITE CREDIT an admin's Invite promised (services/waitlist.js payCredit): paid at the first sign-in, once (an
  // allowlisted invitee too, so on every sign-in: one indexed lookup, nothing once paid). Never in the way of signing in.
  await waitlist.payCredit(me.id, billing).catch((e) => console.error(`[invite-credit] @${me.username}: ${e.message}`));
  // The browser's time zone, only if the account has none yet: a zone picked in Settings outlives any sign-in.
  if (pending.tz && !account.timeZone) await Account.updateOne({ _id: me.id, timeZone: null }, { $set: { timeZone: pending.tz } });
  // A NEW account starts in the theme picked on the front page (lib/theme.js); an existing one keeps its own.
  if (!existing && cookieTheme(req)) await Account.updateOne({ _id: me.id }, { $set: { theme: cookieTheme(req) } });

  // "Add an account" that X signed in as the account already active: nothing added, and the toast says what to do.
  const added = pending.another ? (me.id === req.session.accountId ? "account-same" : prior.includes(me.id) ? null : "account-added") : null;
  const landing = pending.back && BACK.test(pending.back) ? pending.back : added ? `/?n=${added}` : "/";

  // A new session id at the moment of sign-in (no session fixation), holding every account this browser had plus this
  // one, now the active one. Home then shows a new account the start page; nothing is read until it has a module.
  req.session.regenerate((err) => {
    if (err) return next(err);
    sessionAccounts.signedIn(req.session, prior, me.id);
    req.session.save((err2) => (err2 ? next(err2) : res.redirect(landing)));
  });
});

// THE WAITLIST PAGE (how it works, explained before anyone joins): EVERY "Join the waitlist" button comes here first (partials/get-started.hbs),
// and the page explains how getting in works before its own "Join the waitlist with X" (/auth/x?join=1). Someone who already joined
// (the session's `waitlist`, set by the callback) sees that they're on it, or that they're in. Signed in, or sign-up
// open to anyone: there's no waitlist, home.
router.get("/waitlist", async (req, res) => {
  if (req.account || config.signup.anyone) return res.redirect("/");
  const [place, dms] = await Promise.all([waitlist.standing(req.session && req.session.waitlist), waitlistDms.isOn()]);
  res.render("waitlist", {
    pageTitle: "Waitlist",
    noHeaderGo: true, // its own "Join the waitlist with X" is the page's button
    place,
    // DMs on (the site's account can send, services/waitlistDms.js): the page says one is coming and shows THE text.
    dms,
    dmText: dms ? waitlistDms.textParts() : null,
  });
});

// AN INVITE LINK (services/invites.js): who invited you, and Sign in with X carrying the code (the callback redeems it).
// A link with no place left, or none at all, says so and offers the waitlist. Signed in, or sign-up open to anyone (no
// waitlist to skip): home.
router.get("/i/:code", async (req, res) => {
  if (req.account || !invites.enabled()) return res.redirect("/");
  const invite = await invites.pageFor(req.params.code);
  res.status(invite ? 200 : 404).render("invite", { pageTitle: invite ? `@${invite.from.username} invited you` : "Invite", invite, noHeaderGo: true });
});

// THE ACCOUNT SWITCHER's press (the header's menu): another account already signed in on this browser becomes the active
// one, for every tab (each open tab follows: public/js/live.js). Never signs anyone in; never asks X. Home, as X lands
// you after a switch (this page may be one only the other account has).
router.post("/accounts/switch", (req, res, next) => {
  if (!req.account || !sessionAccounts.switchTo(req.session, req.body.id)) return res.redirect(303, "/");
  req.session.save((err) => (err ? next(err) : res.redirect(303, "/")));
});

// Sign out of the ACTIVE account: with others signed in here, the next one takes over (THE ACCOUNT SWITCHER); the last
// one, or `all=1` (the menu's "Sign out of all"), ends the browser session. Background syncing continues either way
// (the account still exists).
router.post("/logout", (req, res, next) => {
  if (req.body.all !== "1" && sessionAccounts.forget(req.session, req.session.accountId)) {
    return req.session.save((err) => (err ? next(err) : res.redirect(303, "/?n=signed-out-one")));
  }
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie(SESSION_COOKIE);
    res.redirect(303, "/");
  });
});

module.exports = { router, SESSION_COOKIE, BACK };
