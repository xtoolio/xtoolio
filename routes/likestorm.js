// routes/likestorm.js — THE LIKESTORM's page (/likestorm, a sidebar place while Liking is active), in TWO STEPS:
//   1. FIND: type an @handle (or paste their profile link), POST /likestorm/find asks X who it is now
//      (services/likeLatest.js findPerson: one profile read, "Find @them"), stores their profile, and lands on
//      /likestorm?who=<their X id>, which SHOWS THEM (face, name, @handle, followers, bio): the confirmation.
//   2. LIKE: under their card, the slider and "♥ Like N · ≈ $X" (routes/pages.js stormChoices), POST /likestorm with
//      their id → routes/pages.js answerStorm.
// The card is drawn by the server; post-actions.js likeLatest counts the likes on it and bursts the confetti.
// Mounted by web.js.
"use strict";

const express = require("express");
const SyncState = require("../models/SyncState");
const Person = require("../models/Person");
const { noticeFor } = require("../lib/notices");
const { handleOf } = require("../lib/handle");
const { active } = require("../services/features");
const billing = require("../services/billing");
const { syncSettings } = require("../services/accounts");
const { findPerson } = require("../services/likeLatest");
const { bioSegments } = require("../services/text");
const { STORM_PAGE, requireAccount, withNotice, wantsJson, stormChoices, answerStorm, fundsView, xFailure } = require("./pages");

const whoPage = (id) => `${STORM_PAGE}?who=${encodeURIComponent(id)}`;

module.exports = function likestormRoutes() {
  const router = express.Router();

  router.get(STORM_PAGE, requireAccount, async (req, res) => {
    if (!active(req.account, "liking")) return res.redirect(303, "/");
    const who = /^\d+$/.test(String(req.query.who || "")) && String(req.query.who) !== req.account._id ? String(req.query.who) : null;
    const profile = who && (await Person.findById(who, "username name image bio bioUrls followers protected gone").lean());
    const storm = profile ? await stormChoices(req.account, res.locals.timeZone) : null;
    // NO MONEY, NO STORM: an account that pays here and is out of runway (THE GATE, billing.paused) is asked for money
    // first, as the start page asks (amount tiles, links to Checkout back here): finding someone is a paid read the
    // gate would refuse. A LIKESTORM ONLY account lands here with $0, and its first top-up is the smaller one.
    const funds = await fundsView(req.account);
    res.render("likestorm", {
      needsMoney: !!funds && billing.paused(req.account),
      state: await SyncState.findById(req.account._id, "lastRunAt").lean(), // the header's "● Live" / "Synced …", as on every page
      handle: profile ? profile.username : "",
      person: profile && { id: who, username: profile.username, profile },
      bio: profile && bioSegments(profile),
      storm: storm && { ...storm, start: storm.upTo, price: storm.prices[storm.upTo - 1] || "" },
      funds,
    });
  });

  // Step 1: who is @handle now. A plain form (it lands on their card); the button spins while X answers (data-busy).
  router.post(`${STORM_PAGE}/find`, requireAccount, async (req, res) => {
    if (!active(req.account, "liking")) return res.redirect(303, "/");
    const handle = handleOf(req.body.handle);
    if (!handle) return res.redirect(303, withNotice(STORM_PAGE, "storm-handle"));
    try {
      const user = await findPerson({ ...syncSettings(req.account._id), handle });
      if (!user) return res.redirect(303, withNotice(STORM_PAGE, "storm-unknown"));
      if (user.id === req.account._id) return res.redirect(303, withNotice(STORM_PAGE, "storm-self"));
      res.redirect(303, whoPage(user.id));
    } catch (err) {
      res.redirect(303, withNotice(STORM_PAGE, xFailure(err, `[likestorm] finding @${handle} for @${req.account.username}`)));
    }
  });

  // Step 2: like the person step 1 found (someone stored, never yourself).
  router.post(STORM_PAGE, requireAccount, async (req, res) => {
    const who = String(req.body.who || "");
    const json = wantsJson(req) || (req.get("accept") || "").includes("application/x-ndjson");
    const known = /^\d+$/.test(who) && who !== req.account._id && (await Person.exists({ _id: who }));
    if (!known || !active(req.account, "liking")) return json ? res.status(400).json({ ok: false, ...noticeFor("x-failed") }) : res.redirect(303, STORM_PAGE);
    return answerStorm(req, res, who, whoPage(who));
  });

  return router;
};
