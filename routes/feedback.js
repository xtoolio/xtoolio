// routes/feedback.js — FEEDBACK (a way for people to send feedback from the app): the sidebar's Feedback opens THE modal (views/partials/feedback-modal.hbs, drawn once by the layout for a
// signed-in page), whose form posts here. Kept as a models/Feedback.js row (the words, who, the page, when) for the
// admins (routes/admin.js) and `npm run feedback`. Back to the page it was sent from, with the toast.
//   POST /feedback   text (1..TEXT_MAX), page (the page it was sent from: a same-site path, or nothing), and up to
//                    SHOTS_MAX screenshots (`shots`, multipart: models/FeedbackShot.js), JSON for the box's script
//
// VALIDATED AS INPUT: the browser's
// `required` / `maxlength` are a convenience, never the check. Here: one string (a field sent twice arrives as an array:
// refused), cleaned (cleanText), 1..TEXT_MAX after cleaning (too long is REFUSED, never cut short silently), the page a
// same-site path of reasonable length, 20 a day per account, and the same words again within DUPLICATE_MS (a double
// press, a resend) kept once. Shown escaped everywhere (the Admin page, pre-wrap; the script prints it as text).
"use strict";

const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const Feedback = require("../models/Feedback");
const FeedbackShot = require("../models/FeedbackShot");
const { sniff, MIME } = require("../lib/media");
const { noticeFor } = require("../lib/notices");
const { requireAccount, safeBack, withNotice, wantsJson } = require("./pages");

const { TEXT_MAX, PAGE_MAX } = Feedback;
const { SHOTS_MAX, SHOT_BYTES, SHOTS_PER_DAY, SHOT_TYPES } = FeedbackShot;
const PER_DAY = 20; // a day per account: a stuck button or a script can't fill the admins' list
const DUPLICATE_MS = 10 * 60 * 1000;

// THE SCREENSHOTS' rules as the box's script reads them (partials/feedback-modal.hbs data-shots, public/js/feedback.js):
// the same numbers and THE notices' words, so the page says no before uploading; the route checks again regardless.
const SHOT_NOTICES = ["feedback-shot-many", "feedback-shot-big", "feedback-shot-type"];
const SHOT_RULES = JSON.stringify({
  max: SHOTS_MAX,
  bytes: SHOT_BYTES,
  accept: SHOT_TYPES.map((t) => MIME[t]).join(","),
  say: Object.fromEntries(SHOT_NOTICES.map((k) => [k, noticeFor(k).text])),
});

// Screenshots arrive multipart, only from the box's script (the CSRF token rides in its x-csrf-token header: the global
// check runs before this parses the body), held in MEMORY under hard limits, then checked and stored. A form with no
// screenshots (urlencoded) passes straight through.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: SHOT_BYTES, files: SHOTS_MAX, fields: 4, fieldSize: 16 * 1024, parts: SHOTS_MAX + 4 },
}).array("shots", SHOTS_MAX);
const receiveShots = (req, res, next) =>
  upload(req, res, (err) => {
    if (err) req.shotsRefused = err.code === "LIMIT_FILE_SIZE" ? "feedback-shot-big" : err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE" ? "feedback-shot-many" : "feedback-shot-type";
    next();
  });

// The uploaded files checked: each an image by its own first bytes (lib/media.js sniff; never SVG, never what its name
// or the browser says). → { shots: [{ mime, data }] } | { refuse: notice key }. Pure.
function checkShots(files) {
  const list = files || [];
  if (list.length > SHOTS_MAX) return { refuse: "feedback-shot-many" };
  const shots = [];
  for (const f of list) {
    const kind = sniff(f.buffer);
    if (!SHOT_TYPES.includes(kind)) return { refuse: "feedback-shot-type" };
    if (f.buffer.length > SHOT_BYTES) return { refuse: "feedback-shot-big" };
    shots.push({ mime: MIME[kind], data: f.buffer });
  }
  return { shots };
}

// What someone typed, made fit to keep. → { text } | { refuse: notice key }. Pure.
//   line endings as \n (a browser sends \r\n); control characters other than a newline or a tab dropped (a NUL or an
//   escape code shows as nothing on the page and can rewrite the terminal `npm run feedback` prints to); the bidi
//   overrides dropped (they make text read in another order than it's stored); runs of blank lines kept to two;
//   trimmed. Length is counted as the browser's maxlength counts it (UTF-16 units), after cleaning.
function cleanText(raw) {
  if (typeof raw !== "string") return { refuse: "feedback-empty" };
  const text = raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g, "")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
  if (!text) return { refuse: "feedback-empty" };
  if (text.length > TEXT_MAX) return { refuse: "feedback-long" };
  return { text };
}

module.exports = function feedbackRoutes() {
  const router = express.Router();

  router.post("/feedback", requireAccount, receiveShots, async (req, res) => {
    const body = req.body || {};
    const back = safeBack(body.page, "/");
    const page = back.length <= PAGE_MAX ? back : "/";
    // Back to the page with the toast: a redirect, or for the box's script (which sent it with fetch) where to go.
    const done = (n) => (wantsJson(req) ? res.json({ ok: n === "feedback-sent", href: withNotice(page, n), text: noticeFor(n).text }) : res.redirect(303, withNotice(page, n)));
    if (req.shotsRefused) return done(req.shotsRefused);
    const { text, refuse } = cleanText(body.text);
    if (refuse) return done(refuse);
    const { shots, refuse: shotRefused } = checkShots(req.files);
    if (shotRefused) return done(shotRefused);
    const since = new Date(Date.now() - 864e5);
    const [today, same, shotsToday] = await Promise.all([
      Feedback.countDocuments({ accountId: req.account._id, at: { $gte: since } }),
      Feedback.exists({ accountId: req.account._id, text, at: { $gte: new Date(Date.now() - DUPLICATE_MS) } }),
      shots.length ? FeedbackShot.countDocuments({ accountId: req.account._id, at: { $gte: since } }) : 0,
    ]);
    if (same) return done("feedback-sent"); // already in: say so, keep one
    if (today >= PER_DAY || shotsToday + shots.length > SHOTS_PER_DAY) return done("feedback-limit");
    // The screenshots first, then the feedback naming them: the list never points at a picture that isn't there.
    const feedbackId = new mongoose.Types.ObjectId();
    const stored = shots.length
      ? await FeedbackShot.insertMany(shots.map((s) => ({ accountId: req.account._id, feedbackId, mime: s.mime, bytes: s.data.length, data: s.data })))
      : [];
    await Feedback.create({ _id: feedbackId, accountId: req.account._id, username: req.account.username, text, page, shots: stored.map((s) => s._id) });
    done("feedback-sent");
  });

  return router;
};

module.exports.TEXT_MAX = TEXT_MAX;
module.exports.SHOT_RULES = SHOT_RULES;
module.exports.cleanText = cleanText;
module.exports.checkShots = checkShots;
