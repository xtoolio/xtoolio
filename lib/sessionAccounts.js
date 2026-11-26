// THE ACCOUNT SWITCHER's session (X's own model: up to 5 accounts signed in on one browser, ONE active at a time, the
// switch global to every tab). Each account gets here only through its own full Sign in with X; a switch can only pick
// one already on the list, so it never signs anyone in. Switching never asks X: each account's tokens are on the
// server already.
//   session.accountId — THE ACTIVE ACCOUNT (unchanged meaning: every route reads req.account from it).
//   session.accounts  — every account signed in on this browser, in the order added. A session from before the
//                       switcher has none: listOf reads it as [accountId].
// Pure (it reads and writes the session object; the caller saves it).
"use strict";

const MAX_ACCOUNTS = 5; // X's own cap on accounts in its switcher

function listOf(session) {
  const active = session && session.accountId ? String(session.accountId) : null;
  const list = session && Array.isArray(session.accounts) ? session.accounts.map(String) : [];
  if (!active) return list;
  return list.includes(active) ? list : [...list, active];
}

// After a completed sign-in: the accounts this browser already held (`prior`, read BEFORE the session was regenerated)
// plus the one that just proved itself, which becomes the active one. Oldest drop off past the cap.
function signedIn(session, prior, id) {
  const me = String(id);
  session.accounts = [...(prior || []).map(String).filter((x) => x !== me), me].slice(-MAX_ACCOUNTS);
  session.accountId = me;
}

// The switcher's press: only an account already on the list. → true when it's now the active one.
function switchTo(session, id) {
  const want = String(id || "");
  const list = listOf(session);
  if (!want || !list.includes(want)) return false;
  session.accounts = list;
  session.accountId = want;
  return true;
}

// One account off this browser (signing out of it, deleting it, or gone): the next one on the list becomes active.
// → the active account now, or null when none is left (the caller signs the whole session out).
function forget(session, id) {
  const gone = String(id || "");
  const rest = listOf(session).filter((x) => x !== gone);
  session.accounts = rest;
  if (!rest.length) {
    delete session.accountId;
    return null;
  }
  if (String(session.accountId) === gone || !session.accountId) session.accountId = rest[rest.length - 1];
  return session.accountId;
}

module.exports = { MAX_ACCOUNTS, listOf, signedIn, switchTo, forget };
