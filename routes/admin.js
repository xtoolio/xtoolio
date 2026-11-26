// routes/admin.js — THE ADMIN PAGE (admins: config.admins, ADMIN_IDS): its tabs, P&L first and the default where
// the site charges (else Feedback; TABS),
//   Feedback   what people sent (routes/feedback.js), the ones not handled first, newest first; each with who, when,
//              the page it came from, its words, and Mark done / Reopen.
//   Waitlist   whether the "you're in" DMs are on (the site's own account sends them, on its one grant), INVITE (let
//              someone in by @handle before they've joined), then THE PEOPLE: Waiting | Granted, each
//              with their picture, name, followers, when they joined, whether they follow the site's account (checked
//              by the worker as they join, services/waitlistDms.js checkFollows),
//              and Grant (let them in + their "you're in" DM) or how their DM went (services/waitlist.js,
//              services/waitlistDms.js). Only while sign-up isn't open to anyone.
//   P&L        a month's deposits, balances, charges and margin per account (services/pnl.js), the Total row first;
//              this month's account rows say where each one's syncing stands now (statusOf: Syncing, Paused, …).
//              The only place billing meets X's cost: Usage reconciles the X balance alone. Only while the site
//              charges (billing on).
//   Activity   what each account did in xtoolio over 7 days / 24 hours / 30 days (services/activity.js): replies,
//              likes and follows sent from it, conversations marked done, when last active; with its sync status.
// Anyone else: the routes answer as if they weren't there (a 404), and nothing links to them.
//   GET  /admin?tab=pnl|activity|feedback|waitlist[&show=waiting|granted][&month=YYYY-MM][&days=1|7|30]
//   POST /admin/feedback/:id/done        on=1|0
//   GET  /admin/feedback/shot/:id        one of its screenshots (models/FeedbackShot.js)
//   POST /admin/waitlist/invite          handle=: let someone in by @handle before they've joined (+ their DM)
//   POST /admin/waitlist/:id/grant       let them in, and queue their "you're in" DM while the sender is connected
//   POST /admin/waitlist/:id/dm          their refused DM queued again ("Send again")
"use strict";

const express = require("express");
const config = require("../config");
const Feedback = require("../models/Feedback");
const FeedbackShot = require("../models/FeedbackShot");
const Account = require("../models/Account");
const waitlist = require("../services/waitlist");
const waitlistDms = require("../services/waitlistDms");
const billing = require("../services/billing");
const { pnlFor } = require("../services/pnl");
const { activityFor, WINDOWS, windowOf } = require("../services/activity");
const pause = require("../services/pause");
const { modulesOn } = require("../services/features");
const { isAdmin, accessToken, NeedsReauth } = require("../services/accounts");
const { handleOf } = require("../lib/handle");
const { withNotice } = require("./pages");

const PAGE = "/admin";
// THE TABS, the first the default (what /admin opens on): P&L where the site charges (the numbers checked most), else
// Feedback. The Waitlist tab shows only while sign-up isn't open to anyone (waitlistPanel).
const TABS = () => [...(billing.enabled ? ["pnl"] : []), "activity", "feedback", "waitlist"];
const TAB_LABELS = { pnl: "P&L", activity: "Activity", feedback: "Feedback", waitlist: "Waitlist" };
const tabHref = (key) => (key === TABS()[0] ? PAGE : `${PAGE}?tab=${key}`);
const SHOWN = 200; // the newest this many (a list to read, not an archive; `npm run feedback` reads further)

// Not an admin: out of this router, on to the app's own 404, as for an address that doesn't exist.
const adminOnly = (req, res, next) => (isAdmin(req.account) ? next() : next("router"));

// The waitlist tab: the sender, then one list (Waiting or Granted) of people, each with their DM's state. `show` picks
// the list; the counts ride on its tabs. null while sign-up is open to anyone (there's no waitlist).
async function waitlistPanel(show) {
  if (config.signup.anyone) return null;
  const view = show === "granted" ? "granted" : "waiting";
  const [{ rows, counts }, dms] = await Promise.all([waitlist.list(view), config.siteX ? waitlistDms.panel() : null]);
  const [dm, inviters] = await Promise.all([
    waitlistDms.dmsOf(rows.map((r) => r._id)),
    // Whose INVITE LINK let them in (services/invites.js): their handle on the row.
    Account.find({ _id: { $in: [...new Set(rows.map((r) => r.invitedBy).filter(Boolean))] } }, "username").lean().then((as) => new Map(as.map((a) => [a._id, a.username]))),
  ]);
  return {
    view,
    counts,
    dms,
    inviteCredit: Math.round(config.billing.inviteCreditUsd * 1e6), // what Invite promises (its button says it)
    people: rows.map((r) => ({
      id: r._id,
      person: { id: r._id, username: r.username, profile: { name: r.name, image: r.image } },
      followers: r.followers,
      joinedAt: r.joinedAt,
      invited: !!r.invitedAt, // an invite made their row: they never joined
      inviter: r.invitedBy ? { username: inviters.get(r.invitedBy) || null } : null, // whose link (no username: deleted since)
      follows: r.follows, // undefined: never checked
      followsAt: r.followsAt,
      grantedAt: r.grantedAt,
      signedUp: !!r.signedUpAt,
      credit: r.creditMicros ? { micros: r.creditMicros, paid: !!r.creditedAt } : null, // THE INVITE CREDIT, promised or paid
      dm: dm.get(r._id) || null,
    })),
  };
}
// Where an account's syncing stands NOW, in one word for P&L's row (THE app's own rules: services/pause.js held, THE
// GATE billing.paused, the modules): signed out of X first (nothing reads), then out of money, then paused (by them, or
// back with money and waiting on "how far back?"; "Away" when Keep syncing live stopped it), then not started (no module yet), else syncing. Pure.
function statusOf(account) {
  if (!account) return null;
  if (account.needsReauth) return { label: "Signed out of X", tone: "off" };
  const broke = billing.paused(account);
  if (broke) return { label: "Out of money", tone: "off" };
  if (pause.held(account, broke)) return { label: account.pause.why === "away" ? "Away" : "Paused", tone: "wait" };
  if (!modulesOn(account).length) return { label: "Not started", tone: "" };
  return { label: "Syncing", tone: "on" };
}
// The month in view is this one: each account row gets its status (an older month's rows are history; now means nothing).
async function withStatus(pnl) {
  if (!pnl || pnl.next) return pnl;
  const ids = pnl.rows.filter((r) => r.person).map((r) => r.id);
  const now = new Map((await Account.find({ _id: { $in: ids } }, "needsReauth balanceMicros pause features").lean()).map((a) => [a._id, a]));
  for (const r of pnl.rows) if (r.person) r.status = statusOf(now.get(r.id));
  return pnl;
}

const WAITLIST_TAB = `${PAGE}?tab=waitlist`;
const backTo = (req) => `${WAITLIST_TAB}${req.body.show === "granted" ? "&show=granted" : ""}`;
const XID = /^\d{1,25}$/;

module.exports = function adminRoutes() {
  const router = express.Router();

  router.get(PAGE, adminOnly, async (req, res) => {
    const tab = TABS().includes(req.query.tab) ? req.query.tab : TABS()[0];
    const [rows, open, panel, pnl] = await Promise.all([
      Feedback.find({}).sort({ doneAt: 1, at: -1 }).limit(SHOWN).lean(), // not handled (no doneAt) first
      Feedback.countDocuments({ doneAt: { $exists: false } }),
      waitlistPanel(String(req.query.show || "")),
      tab === "pnl" ? pnlFor(String(req.query.month || ""), { ownerId: config.x.ownerId }).then(withStatus) : null,
    ]);
    // ACTIVITY (services/activity.js): what each account did in the window, with where its syncing stands now.
    const win = windowOf(req.query.days);
    const activity = tab === "activity" ? { rows: (await activityFor(win.days)).map((r) => ({ ...r, status: statusOf(r.account) })), windows: WINDOWS.map((w) => ({ ...w, on: w.days === win.days, href: `${PAGE}?tab=activity${w === WINDOWS[0] ? "" : `&days=${w.days}`}` })) } : null;
    const who = new Map((await Account.find({ _id: { $in: [...new Set(rows.map((r) => r.accountId))] } }, "username name image").lean()).map((a) => [a._id, a]));
    const feedback = rows.map((r) => {
      const a = who.get(r.accountId);
      return { id: String(r._id), text: r.text, page: r.page, at: r.at, done: !!r.doneAt, shots: (r.shots || []).map(String), person:{ id: r.accountId, username: (a && a.username) || r.username, profile: a ? { name: a.name, image: a.image } : null } };
    });
    res.render("admin", {
      wide: tab !== "feedback", // the two tables are THE LIST ROW at the page's full width, as People; feedback is prose

      view: tab, // not `tab`: that's the sidebar's (res.locals.tab "admin")
      // In TABS' order, the default (the first) at /admin itself.
      tabs: TABS()
        .filter((k) => k !== "waitlist" || panel)
        .map((key) => ({ key, label: TAB_LABELS[key], ...(key === "feedback" && { n: open }), ...(key === "waitlist" && { n: panel.counts.waiting }), href: tabHref(key), on: tab === key })),
      feedback,
      waitlist: panel,
      pnl,
      activity,
    });
  });

  router.post(`${PAGE}/feedback/:id/done`, adminOnly, async (req, res) => {
    const id = String(req.params.id);
    if (/^[a-f0-9]{24}$/.test(id)) await Feedback.updateOne({ _id: id }, req.body.on === "1" ? { $set: { doneAt: new Date() } } : { $unset: { doneAt: 1 } });
    res.redirect(303, `${tabHref("feedback")}#f${id}`);
  });

  // A feedback screenshot, to admins only, as the type its bytes said when it was stored (never SVG: models/FeedbackShot
  // SHOT_TYPES), shown inline; nosniff is on every answer (helmet). Kept in the browser a day: it never changes.
  router.get(`${PAGE}/feedback/shot/:id`, adminOnly, async (req, res, next) => {
    const id = String(req.params.id);
    const shot = /^[a-f0-9]{24}$/.test(id) ? await FeedbackShot.findById(id, "mime data").lean() : null;
    if (!shot) return next("router");
    res.set({ "Content-Type": shot.mime, "Cache-Control": "private, max-age=86400", "Content-Disposition": "inline" });
    res.send(Buffer.isBuffer(shot.data) ? shot.data : Buffer.from(shot.data.buffer)); // lean: BSON Binary, its bytes in .buffer
  });

  // Grant: let one person in, and queue their "you're in" DM (none while the sender isn't connected: the toast says so).
  router.post(`${PAGE}/waitlist/:id/grant`, adminOnly, async (req, res) => {
    const id = String(req.params.id);
    if (config.signup.anyone || !XID.test(id)) return res.redirect(303, backTo(req));
    const row = await waitlist.grant(id, req.account._id);
    if (!row) return res.redirect(303, backTo(req));
    const queued = await waitlistDms.queue(id);
    res.redirect(303, withNotice(`${backTo(req)}#w${id}`, queued ? "waitlist-granted" : "waitlist-granted-nodm"));
  });

  // Invite: let someone in by their @handle (or profile link) before they've joined, then queue their "you're in" DM as
  // a Grant does. X is asked who the handle is now (services/waitlist.js invite). Lands on Granted, at their row.
  router.post(`${PAGE}/waitlist/invite`, adminOnly, async (req, res) => {
    if (config.signup.anyone) return res.redirect(303, WAITLIST_TAB);
    const handle = handleOf(req.body.handle);
    if (!handle) return res.redirect(303, withNotice(WAITLIST_TAB, "invite-bad"));
    let r;
    try {
      r = await waitlist.invite(handle, { by: req.account._id, token: () => accessToken(req.account._id) });
    } catch (err) {
      console.error(`[admin invite] @${handle}: ${err.message}`);
      return res.redirect(303, withNotice(WAITLIST_TAB, err instanceof NeedsReauth ? "invite-reauth" : "invite-failed"));
    }
    if (!r.row) return res.redirect(303, withNotice(WAITLIST_TAB, r.status === "account" ? "invite-account" : "invite-unknown"));
    // THE INVITE CREDIT (INVITE_CREDIT_USD), promised on their row, paid at their first sign-in; pressing Invite again
    // for someone already in attaches it (no second DM).
    await waitlist.promiseCredit(r.row._id, Math.round(config.billing.inviteCreditUsd * 1e6));
    const at = `${WAITLIST_TAB}&show=granted#w${r.row._id}`;
    if (r.status === "already") return res.redirect(303, withNotice(at, "invite-already"));
    const queued = await waitlistDms.queue(r.row._id);
    res.redirect(303, withNotice(at, queued ? "invite-sent" : "invite-sent-nodm"));
  });

  router.post(`${PAGE}/waitlist/:id/dm`, adminOnly, async (req, res) => {
    const id = String(req.params.id);
    const again = XID.test(id) && (await waitlistDms.retry(id));
    res.redirect(303, withNotice(`${backTo(req)}#w${id}`, again ? "dms-retry" : "dms-retry-none"));
  });

  return router;
};
module.exports.statusOf = statusOf; // verify-security checks the words
