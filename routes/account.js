// routes/account.js — the account itself:
//   POST /account/delete   Settings' Delete account: `confirm` must be the account's @handle (typed in THE modal), then
//                          services/deleteAccount.js deletes it whole and the browser lands signed out on the front
//                          page with the toast. Refused (the owner, a sync that won't let go, X not answering): back to
//                          Settings with why, nothing deleted.
"use strict";

const express = require("express");
const { deleteAccount, DeleteRefused } = require("../services/deleteAccount");
const { requireAccount, withNotice } = require("./pages");
const sessionAccounts = require("../lib/sessionAccounts");

const SETTINGS = "/settings#delete";

// What was typed against the handle: an @ or not, any case, spaces around it.
const confirms = (typed, username) => String(typed || "").trim().replace(/^@/, "").toLowerCase() === String(username).toLowerCase();

module.exports = function accountRoutes() {
  const router = express.Router();

  router.post("/account/delete", requireAccount, async (req, res) => {
    if (!confirms(req.body.confirm, req.account.username)) return res.redirect(303, withNotice(SETTINGS, "delete-confirm"));
    try {
      const done = await deleteAccount(req.account._id, { log: (line) => console.log(`[delete] ${req.account.username}: ${line}`) });
      console.log(`[delete] @${done.username}: ${done.removed.filter((r) => r.n).map((r) => `${r.n} ${r.label}`).join(", ")}`);
    } catch (err) {
      if (!(err instanceof DeleteRefused)) throw err;
      return res.redirect(303, withNotice(SETTINGS, `delete-${err.code}`)); // one notice per refusal (lib/notices.js)
    }
    // Other accounts signed in on this browser (THE ACCOUNT SWITCHER) stay: the next one becomes active, and this
    // request's copy of the session is saved back without the deleted one (the cascade removed its store row).
    // Otherwise destroy it too, or express-session would save it back (rolling) still naming the account.
    if (sessionAccounts.forget(req.session, req.account._id)) return req.session.save(() => res.redirect(303, withNotice("/", "account-deleted")));
    req.session.destroy(() => res.redirect(303, withNotice("/", "account-deleted")));
  });

  return router;
};
