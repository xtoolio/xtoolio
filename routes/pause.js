// routes/pause.js — THE PAUSE and THE RESUME READ (services/pause.js):
//   POST /pause    Settings' Syncing switch and the banner's Resume: pause=1 pauses (nothing reads in the background,
//                  Live goes); pause=0 resumes: within a day of stopping, at once (it catches up as it always did);
//                  longer, to "how far back?" first
//   GET  /resume   "How far back?" for what you missed: the first read's options (priced for this account, a top-up beside
//                  any its balance doesn't cover), up to everything since you paused, and "From now"
//   POST /keep-live  KEEP SYNCING LIVE (the Inbox's title row, Settings): on=0 stops after an hour away (services/away.js)
//   POST /resume   one of them (the away bar posts "since" or "now" straight here) (`key`, recomputed here, refused unaffordable) → services/pause.js resume → home, where the
//                  progress page shows the read until its posts and likes are in
"use strict";

const express = require("express");
const Account = require("../models/Account");
const billing = require("../services/billing");
const pause = require("../services/pause");
const { requireAccount, withNotice, safeBack, resumeChoices, fundsView } = require("./pages");

module.exports = function pauseRoutes() {
  const router = express.Router();

  router.post("/pause", requireAccount, async (req, res) => {
    const back = safeBack(req.body.back, "/settings");
    if (req.body.pause === "1") {
      await pause.pauseNow(req.account);
      return res.redirect(303, withNotice(back, "paused"));
    }
    if (!(req.account.pause && req.account.pause.at)) return res.redirect(303, back);
    if (pause.asks(req.account)) return res.redirect(303, "/resume");
    // Paused by you within a day: it just goes on. Out of balance, only money resumes it (the gate): the page says so.
    if (billing.paused(req.account)) return res.redirect(303, "/resume");
    await pause.resumeQuietly(req.account._id);
    res.redirect(303, withNotice(back, "resumed"));
  });

  // KEEP SYNCING LIVE (services/away.js): on=1 keeps it (the default, so the field goes), on=0 stops after an hour
  // away. You're here now, so it counts from now (seenAt), never from an old mark.
  router.post("/keep-live", requireAccount, async (req, res) => {
    const back = safeBack(req.body.back, "/");
    const on = req.body.on === "1";
    await Account.updateOne({ _id: req.account._id }, on ? { $unset: { keepLive: 1 } } : { $set: { keepLive: false }, $max: { seenAt: new Date() } });
    res.redirect(303, withNotice(back, on ? "live-kept" : "live-away"));
  });

  router.get("/resume", requireAccount, async (req, res) => {
    if (!(req.account.pause && req.account.pause.at)) return res.redirect(303, "/");
    res.render("resume", { options: await resumeChoices(req.account), funds: await fundsView(req.account), since: req.account.pause.at, away: req.account.pause.why === "away" });
  });

  router.post("/resume", requireAccount, async (req, res) => {
    if (!(req.account.pause && req.account.pause.at)) return res.redirect(303, "/");
    const choice = (await resumeChoices(req.account)).find((o) => o.key === req.body.key);
    if (!choice || !choice.affordable) return res.redirect(303, withNotice("/resume", "bulk-short"));
    await pause.resume(req.account, choice);
    res.redirect(303, "/");
  });

  return router;
};
