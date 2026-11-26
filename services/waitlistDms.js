// THE WAITLIST'S "YOU'RE IN" DMs (docs/WAITLIST-DMS.md; built after the spike). When an
// admin GRANTS someone on the waitlist (Admin → Waitlist, routes/admin.js; services/waitlist.js grant), they get ONE
// direct message from the site's own X account (SITE_X): "You're in on xtoolio 🎉 Sign in at xtoolio.com to get started."
// (It used to go out per numbered place a batch opened, "Your place, #34, is open".)
//
//   THE SENDER   the site's own ACCOUNT (SITE_X; accounts.isSiteAccount), with its ONE grant: its sign-in asks for
//                features.SCOPES_SITE (a customer's scopes + dm.write; routes/auth.js sends any sign-in of it that lacks
//                dm.write back to X once), the ONLY grant that ever holds dm.write. X keeps one grant per person per
//                app, a new sign-in replacing the last, which is why there's no separate sender grant: one was replaced
//                by the account's next sign-in and stopped sending. It also reads who follows it, by itself as people
//                join (checkFollows: X only says who follows an account to that account, and a DM reaches for sure only
//                a follower), with the follows.read every account's grant has.
//   THE QUEUE    models/WaitlistDm.js, one row per person EVER (`_id` their X id): a Grant queues theirs, only while
//                the sender can send (nothing is promised while nobody can).
//   THE SEND     the WORKER (app.js), every TICK_MS: up to PER_TICK in one metered unit (kind "dm", the platform's cost,
//                no account), paced by X's own headers (99 per 15 minutes, 1,440 a day, measured in the spike) through the
//                sender's rate-limit window (services/ratelimits.js), so a spent window opens no ledger row at all. A
//                refusal (they don't follow @xtoolio and don't take DMs from everyone: X's "dm-recipient-not-accepting")
//                is kept with X's reason for the Admin page; that person's "Send again" requeues them (they may have
//                followed since). Nothing is sent twice: X refuses a repeat ("dm-duplicate", taken as sent).
// What the person sees: the waitlist page shows the DM's picture and says it's coming (views/waitlist.hbs `dms`), and
// a "Follow @xtoolio" link, since only a follower is sure to receive it.
"use strict";

const config = require("../config");
const WaitlistDm = require("../models/WaitlistDm");
const Waitlist = require("../models/Waitlist");
const Account = require("../models/Account");
const { createClient, windowKey } = require("../lib/x");
const { metered } = require("./usage");
const { windowStore } = require("./ratelimits");
const { accessToken, hasScope } = require("./accounts");
const { profileOf } = require("./waitlist");

const TICK_MS = 30 * 1000;
const PER_TICK = 10;
const SENDING_STALE_MS = 5 * 60 * 1000; // a claim older than this belonged to a worker that died mid-send
const WINDOW = windowKey("POST", "/dm_conversations/with/0/messages");

// THE TEXT, in three parts so the waitlist page's picture of it (partials/dm-preview.hbs) can underline the address the
// way X draws a link: the picture and the send can't drift.
const textParts = () => [`You’re in on ${config.brandName} 🎉 Sign in at `, config.siteDomain, " to get started."];
const textFor = () => textParts().join("");

// X's reasons, in words for the Admin page (display only; anything else shows X's own words).
const PROBLEM_WORDS = { "dm-recipient-not-accepting": "doesn’t take DMs from us (not following)" };

// The site's own account (SITE_X), or null: found by its handle (any case), then by the id it had (an id never moves;
// gone, deleted, it's looked up by handle again).
let siteId = null;
const SENDER_FIELDS = "username needsReauth tokens.scope";
async function sender() {
  if (!config.siteX) return null;
  const known = siteId && (await Account.findById(siteId, SENDER_FIELDS).lean());
  if (known) return known;
  const s = await Account.findOne({ username: config.siteX }, SENDER_FIELDS).collation({ locale: "en", strength: 2 }).lean();
  siteId = s ? s._id : null;
  return s;
}
// Can it send: signed in, X still taking its grant, and the grant has dm.write (a sign-in from before SCOPES_SITE
// doesn't, until it signs in again). Can it read who follows it: the same with follows.read (every account's grant).
const grantHas = (s, scope) => !!(s && !s.needsReauth && s.tokens && hasScope(s.tokens.scope, scope));
const canSend = (s) => grantHas(s, "dm.write");
const canCheck = (s) => grantHas(s, "follows.read");

// Are DMs on (the sender can send)? The waitlist page asks on every visit, so this process keeps the answer a minute
// (`fresh`: ask now).
let onCache = { v: false, at: 0 };
async function isOn({ fresh = false } = {}) {
  if (!fresh && Date.now() - onCache.at < 60 * 1000) return onCache.v;
  if (require("mongoose").connection.readyState !== 1) return false;
  const s = await sender().catch(() => null);
  onCache = { v: canSend(s), at: Date.now() };
  return onCache.v;
}

// A Grant: queue that person's one DM, unless they already have an account (an invitee may) or already had theirs. Only
// while the sender can send. → true when queued
async function queue(id) {
  if (!(await isOn())) return false;
  const row = await Waitlist.findById(String(id), "username").lean();
  if (!row || (await Account.exists({ _id: row._id }))) return false;
  try {
    await WaitlistDm.create({ _id: row._id, username: row.username, queuedAt: new Date() });
    return true;
  } catch (err) {
    if (err.code === 11000) return false; // already had theirs: one per person, ever
    throw err;
  }
}

// Send what's due (the worker's tick). `send` is for verify only (a stub of the client's sendDm). → { sent, refused }
async function sendDue({ max = PER_TICK, send = null } = {}) {
  const done = { sent: 0, refused: 0 };
  await WaitlistDm.updateMany({ status: "sending", claimedAt: { $lt: new Date(Date.now() - SENDING_STALE_MS) } }, { $set: { status: "queued" } });
  if (!(await WaitlistDm.exists({ status: "queued" }))) return done;
  const s = await sender();
  if (!canSend(s)) return done;
  // X's window spent (stored from its last answer, under the site account's own windows): wait for its reset without
  // opening a ledger row each tick.
  const windows = windowStore(s._id);
  const win = await windows.get(WINDOW);
  if (win && win.remaining <= 0 && win.reset > Date.now()) return done;

  const token = send ? null : await accessToken(s._id); // NeedsReauth: X refused the refresh; the Admin page says so
  await metered({ kind: "dm", label: "Waitlist: “you’re in” DMs", dropEmpty: true }, async (meter) => {
    meter.windows = windows;
    const client = send ? { sendDm: send } : createClient({ token, meter, readCap: 0, userCap: 0 });
    for (let i = 0; i < max; i++) {
      const row = await WaitlistDm.findOneAndUpdate({ status: "queued" }, { $set: { status: "sending", claimedAt: new Date() }, $inc: { tries: 1 } }, { sort: { queuedAt: 1 }, returnDocument: "after" }).lean();
      if (!row) break;
      try {
        const r = await client.sendDm(row._id, textFor());
        await WaitlistDm.updateOne({ _id: row._id }, { $set: { status: "sent", sentAt: new Date(), eventId: r.eventId }, $unset: { problem: "", detail: "" } });
        done.sent++;
      } catch (err) {
        if (err.problem === "dm-duplicate") {
          await WaitlistDm.updateOne({ _id: row._id }, { $set: { status: "sent", sentAt: new Date() } });
          done.sent++;
          continue;
        }
        // X's refusal of THIS person (a 4xx with a reason): kept, the queue goes on. Anything else (the window, the
        // sender's grant, X down, a restart): put back, and the tick stops; the next one tries again.
        const refusal = err.status >= 400 && err.status < 500 && err.status !== 429 && err.status !== 401;
        if (refusal) {
          await WaitlistDm.updateOne({ _id: row._id }, { $set: { status: "refused", problem: err.problem || `http-${err.status}`, detail: String(err.detail || err.message).slice(0, 300) } });
          done.refused++;
          continue;
        }
        await WaitlistDm.updateOne({ _id: row._id }, { $set: { status: "queued" }, $inc: { tries: -1 } });
        if (!err.paced) console.error(`[waitlist dms] stopped at ${row._id}: ${err.message}`);
        break;
      }
    }
    if (done.sent) await meter.setLabel(`Waitlist: ${done.sent} “you’re in” DM${done.sent === 1 ? "" : "s"}`);
  });
  return done;
}

// Admin → a person's "Send again": their refused DM back in the queue (they may follow the account now). → true if so
async function retry(id) {
  const r = await WaitlistDm.updateOne({ _id: String(id), status: "refused" }, { $set: { status: "queued", queuedAt: new Date() } });
  return r.modifiedCount === 1;
}

// The Admin page's sender line: whether the site's account can send (`on`), and if not, why (`why`: "none" no account
// yet, "reauth" X refused its grant, "scope" signed in before it asked for dm.write).
async function panel() {
  const s = await sender();
  const why = !s ? "none" : s.needsReauth ? "reauth" : canSend(s) ? null : "scope";
  return { on: !why, why, siteX: config.siteX };
}

// Each listed person's DM as the Admin page shows it: { status, why (a refusal in words), at }. → Map id → that
const dmsOf = async (ids) =>
  new Map(
    (await WaitlistDm.find({ _id: { $in: ids } }, "status problem detail sentAt queuedAt claimedAt").lean()).map((d) => [
      d._id,
      { status: d.status === "sending" ? "queued" : d.status, why: d.status === "refused" ? PROBLEM_WORDS[d.problem] || d.detail : null, at: d.sentAt || d.claimedAt || d.queuedAt },
    ])
  );

// WHO FOLLOWS THE SITE'S ACCOUNT, checked by itself (the worker's tick, before the sends): the profiles of the people
// due, read with the SENDER's token, so X's connection_status says who follows it ("followed_by"; left out when they
// don't), their name, picture and followers refreshed with it. DUE: not signed up, and never checked (a new joiner is
// read within a tick), or not following at the last check, joined under RECHECK_FOR ago and last read over RECHECK_EVERY
// ago (the waitlist page tells them to follow, so many do a few minutes after joining). After that day the Grant's DM
// is the check: X refuses it to a non-follower and the row offers Send again. A billed profile read each ($0.01, once
// per UTC day however often), the platform's (kind "waitlist", no account; dropped from the ledger when X returned
// nothing), at most one request (CHECK_MAX) a tick. Someone X won't serve (suspended, deleted) gets `followsAt` alone,
// so they aren't asked again. `read` is for verify only (a stub of usersByIds).
// → how many were read, or null when the sender can't check (no site account, or X refused its grant)
const CHECK_MAX = 100;
const RECHECK_EVERY = 60 * 60 * 1000;
const RECHECK_FOR = 24 * 60 * 60 * 1000;
const dueFilter = (now) => ({
  signedUpAt: { $exists: false },
  $or: [{ followsAt: { $exists: false } }, { follows: false, joinedAt: { $gt: new Date(now - RECHECK_FOR) }, followsAt: { $lt: new Date(now - RECHECK_EVERY) } }],
});
async function checkFollows({ read = null } = {}) {
  const s = await sender();
  if (!read && !canCheck(s)) return null;
  const now = new Date();
  const rows = await Waitlist.find(dueFilter(now.getTime()), "_id").sort({ joinedAt: 1 }).limit(CHECK_MAX).lean();
  if (!rows.length) return 0;
  const token = read ? null : await accessToken(s._id);
  let n = 0;
  await metered({ kind: "waitlist", label: `Waitlist: who follows @${config.siteX}`, dropEmpty: true }, async (meter) => {
    const client = read ? { usersByIds: read } : createClient({ token, meter, readCap: 0, userCap: rows.length });
    const { users, missing = [] } = await client.usersByIds(rows.map((r) => r._id));
    await Promise.all([
      ...users.map((u) => Waitlist.updateOne({ _id: u.id }, { $set: { ...profileOf(u), follows: (u.connection_status || []).includes("followed_by"), followsAt: now } })),
      ...missing.map((m) => Waitlist.updateOne({ _id: String(m.id) }, { $set: { followsAt: now } })),
    ]);
    n = users.length;
  });
  return n;
}

// THE WORKER's duty (app.js): one tick at a time, every TICK_MS (who follows, then the sends, so a DM queued for a new
// joiner goes after their check); stop() waits for the one in flight (a restart).
let timer = null;
let ticking = null;
let stopped = false;
function start() {
  if (timer || !config.siteX) return;
  const tick = async () => {
    if (stopped) return;
    ticking = (async () => {
      await checkFollows().catch((e) => console.error(`[waitlist follows] ${e.message}`));
      await sendDue().catch((e) => console.error(`[waitlist dms] ${e.message}`));
    })();
    await ticking;
    ticking = null;
    if (stopped) return;
    timer = setTimeout(tick, TICK_MS);
    timer.unref();
  };
  timer = setTimeout(tick, 5000);
  timer.unref();
}
async function stop() {
  stopped = true;
  if (timer) clearTimeout(timer);
  if (ticking) await ticking;
}

module.exports = { textParts, textFor, isOn, queue, sendDue, retry, panel, dmsOf, checkFollows, start, stop };
