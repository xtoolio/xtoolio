// THE METER: every unit of X work runs inside metered(), which opens a ledger row (models/UsageEntry.js) before the
// first read and hands lib/x.js a meter that records every response into it as it arrives. lib/x.js refuses to build
// a client without a meter, so no read can go unrecorded.
//
// Two numbers, kept apart:
//   at X's prices — per unit (`estUsd`, a legacy name): what each response costs on X's price list (lib/pricing.js),
//              minus X's same-UTC-day dedup (ReadMark). Written per response, so a unit that dies halfway keeps it.
//              What an account is charged on, exactly (services/balance.js).
//   real     — per DAY, never per unit: X's balance on a clock (services/balanceClock.js, one reading a minute into
//              BalanceReading), each reading storing its move since the last (moveOf): every drop is spend, every
//              rise a top-up. Exact whatever ran or crashed in between. Shown to the owner beside the other.
// (Previously every unit read X's balance before and after itself, for its own exact cost. With many accounts
// syncing at once nearly every unit overlapped another, so the per-unit figure was rarely usable, and it cost two calls
// to X per unit through the owner's token: ~60,000 a day at 100 accounts, and many of them failed.)
// Rows store cost, never a price: the markup is applied in one place on top (services/balance.js, which charges each
// closed unit to its account's balance and writes the price on a BalanceEntry).
"use strict";

const { PRICE } = require("../lib/pricing");
const UsageEntry = require("../models/UsageEntry");
const BalanceReading = require("../models/BalanceReading");
const ReadMark = require("../models/ReadMark");
const { windowStore } = require("./ratelimits");
const { page, cursorTime, dayExpr } = require("../lib/feedCursor");
const { dayIn } = require("../lib/timezone");
const { OutOfBalance } = require("./balance");

// A unit is alive while its process beats (`beatAt`, lib/heartbeat.js); one whose beat is older than LEASE_MS died
// without closing. Rows from before the heartbeat have no beatAt: they're dead after STALE_MS from their start.
const { LEASE_MS, heartbeat } = require("../lib/heartbeat");
const STALE_MS = 30 * 60 * 1000;
const deadFilter = (now) => ({ status: "open", $or: [{ beatAt: { $lt: new Date(now - LEASE_MS) } }, { beatAt: { $exists: false }, startedAt: { $lt: new Date(now - STALE_MS) } }] });
// Is this open unit still running? (A view's "running".)
const alive = (e, now = Date.now()) => e.status === "open" && !!e.beatAt && new Date(e.beatAt).getTime() >= now - LEASE_MS;
const cents = (usd) => Math.round(usd * 1e4) / 1e4;
const utcDay = (d) => d.toISOString().slice(0, 10);

// Of these ids, how many X hasn't returned yet this UTC day (and mark them returned): the billable count.
async function firstToday(type, ids, now = new Date()) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  if (!unique.length) return 0;
  const day = utcDay(now);
  const r = await ReadMark.bulkWrite(
    unique.map((id) => ({ updateOne: { filter: { _id: `${day}:${type}:${id}` }, update: { $setOnInsert: { at: now } }, upsert: true } })),
    { ordered: false }
  );
  return r.upsertedCount;
}

// THE CEILING a unit runs under (UsageEntry.ceilingUsd, services/balance.js capped): the lower of the quote the person
// was shown (`quote`, X's cost) and what the balance covers (`room`: balance.ceilingFor's { full, bulk }, at the rate
// the unit is charged). → { usd, of } | null (nothing to cap). Pure.
function ceilingOf(quote, room, bulk = false) {
  const covered = room ? (bulk ? room.bulk : room.full) : null;
  if (quote == null && covered == null) return null;
  return covered == null || (quote != null && quote <= covered) ? { usd: quote, of: "quote" } : { usd: covered, of: "balance" };
}

// The meter lib/x.js records into: record(what, cls, type, ids) after every response. Awaited by the client, so
// a failed write stops the unit rather than letting it read on unrecorded. It keeps the unit's running cost
// (`spentUsd`, the same sum as UsageEntry.estUsd) and its ceiling (`ceilingUsd`): lib/x.js sends no read once the
// cost has reached it, so a run stops where the balance (or the quote) runs out, cleanly, like a count cap.
function meterFor(entryId, accountId = null, { quote = null, room = null } = {}) {
  const start = ceilingOf(quote, room);
  return {
    entryId,
    spentUsd: 0,
    ceilingUsd: start ? start.usd : null,
    // Has this unit spent what it may? (lib/x.js asks before every read.)
    atCeiling() {
      return this.ceilingUsd != null && this.spentUsd >= this.ceilingUsd;
    },
    // The account's rate-limit windows, shared across runs and processes (lib/x.js paces on them). A sign-in doesn't
    // know its account yet: its client falls back to memory.
    windows: accountId ? windowStore(accountId) : null,
    async record(what, cls, type, ids) {
      if (!ids.length) return;
      await this.recordCounted(what, cls, ids.length, await firstToday(type, ids));
    },
    // `returned` resources of which `billed` were new to X that UTC day, decided by the caller when X sent them (Live:
    // an event is billed on delivery, so its dedup is decided then, services/live.js ingest, not when it's flushed).
    async recordCounted(what, cls, returned, billed) {
      if (!returned) return;
      this.spentUsd += billed * (PRICE[cls] || 0);
      const key = `lines.${what}:${cls}`;
      await UsageEntry.collection.updateOne(
        { _id: entryId },
        { $inc: { [`${key}.returned`]: returned, [`${key}.billed`]: billed, estUsd: billed * (PRICE[cls] || 0) } }
      );
    },
    // A write (a like): X bills it per request, with no same-day dedup, so every one counts.
    async recordAction(what, cls) {
      this.spentUsd += PRICE[cls] || 0;
      const key = `lines.${what}:${cls}`;
      await UsageEntry.collection.updateOne({ _id: entryId }, { $inc: { [`${key}.returned`]: 1, [`${key}.billed`]: 1, estUsd: PRICE[cls] || 0 } });
    },
    // A bulk press names its row once it knows what it did ("Liked Maya, Dev and 12 others"; web.js the bulk routes).
    async setLabel(label) {
      await UsageEntry.updateOne({ _id: entryId }, { $set: { label } });
    },
    // A sign-in learns whose account it is only from X's answer.
    async setAccount(accountId) {
      await UsageEntry.updateOne({ _id: entryId }, { $set: { accountId } });
    },
    // This unit is a BULK READ from here on: charged at the bulk markup, outside the month's threshold count
    // (services/balance.js chargeUnit). The sync calls it on reading the account's HISTORY (the first
    // backward page of its timeline, or the look back through its likes; whatever else that run reads rides along at
    // that rate, one run's worth), labelled `label`. A unit that's bulk from the start says so to metered({ bulk }).
    // Charged at the lower rate from here on, the same balance covers more: the ceiling is raised to match (a $20
    // history read would otherwise stop at the full rate's ~$15).
    async bulkRead(label) {
      if (this.isBulk) return;
      this.isBulk = true;
      const c = ceilingOf(quote, room, true);
      if (c) this.ceilingUsd = c.usd;
      await UsageEntry.updateOne({ _id: entryId }, { $set: { bulkRead: true, ...(label && { label }), ...(c && { ceilingUsd: c.usd, ceilingOf: c.of }) } });
    },
  };
}

// A row that cost nothing (a sync that found nothing new: about half of them) is kept a week, then dropped (TTL on
// `expireAt`, models/UsageEntry.js): at 100 accounts the ledger otherwise grows ~1M rows a month of "nothing new".
const EMPTY_KEEP_MS = 7 * 24 * 3600 * 1000;

// `dropEmpty`: an ok unit that X returned NOTHING to (no ledger line at all) is deleted instead: the mentions check runs
// every 30 s while a tab is open (services/sync.js checkMentions), and a row a check saying "Nothing new" is noise.
async function close(id, { status, error, endedAt = new Date(), dropEmpty = false }) {
  // The estimate is complete by now (every response recorded as it arrived): an ok unit that billed nothing is empty.
  const e = await UsageEntry.findOneAndUpdate({ _id: id }, { $set: { status, error, endedAt } }, { projection: { estUsd: 1, lines: 1 }, returnDocument: "after" }).lean();
  if (!e || status !== "ok" || e.estUsd > 0) return;
  if (dropEmpty && !Object.keys(e.lines || {}).length) return void (await UsageEntry.deleteOne({ _id: id }));
  await UsageEntry.updateOne({ _id: id }, { $set: { expireAt: new Date(endedAt.getTime() + EMPTY_KEEP_MS) } });
}

// Units that died without closing (process killed, crash): closed as failed where their beat stopped. Whatever they
// read before dying is already in their estimate (recorded per response), and in the day's real spend.
async function settleStale(now = Date.now()) {
  const stale = await UsageEntry.find(deadFilter(now), "startedAt beatAt").lean();
  for (const e of stale) await close(e._id, { status: "failed", error: "never finished", endedAt: new Date(e.beatAt || e.startedAt) });
}

// THE rule for X's real money: the move between consecutive readings, positive = spent, negative = added (a top-up).
// Stored on each reading as it's taken (`d`), so a day's spend is the sum of its positive moves, whatever ran or
// crashed in between. `prev`: the reading before (none for the first ever). Pure.
const moveOf = (prev, usd) => (prev ? cents(prev.usd - usd) : undefined);

// X's balance now, as a reading, when it changed (or an hour has passed, so the page can say "as of"): the clock's one
// job (services/balanceClock.js). `readBalance` → { usd, owner } | null. → the reading, or null (none taken / unchanged).
// The move is against THIS owner's last reading only (models/BalanceReading.js `owner`): another developer account's
// balance is a different balance, never a spend or a top-up.
const READING_KEEPALIVE_MS = 60 * 60 * 1000;
async function takeReading(readBalance, now = new Date()) {
  const b = await readBalance();
  if (!b || !Number.isFinite(b.usd)) return null;
  const owner = b.owner || null;
  // Readings from before `owner` was recorded are unowned. While NO reading has an owner, there has only ever been one
  // developer account (a copy that never changed it), so this one claims them, once: its history stays its own. On
  // production the claim never ran: the app had already moved to another account when readings got owners.
  if (owner && !(await BalanceReading.exists({ owner: { $ne: null } }))) await BalanceReading.updateMany({ owner: null }, { $set: { owner } });
  const last = await BalanceReading.findOne({ owner }, "usd at").sort({ at: -1 }).lean();
  if (last && last.usd === b.usd && now - new Date(last.at) < READING_KEEPALIVE_MS) return null;
  return BalanceReading.create({ usd: b.usd, at: now, d: moveOf(last, b.usd), ...(owner ? { owner } : {}) });
}

// Run `fn(meter)` as one metered unit. The unit's error (if any) is recorded and rethrown.
// `billing` (services/billing.js, via accounts.meterSettings): the account is charged for the unit once it closes
// (services/balance.js chargeUnit, exactly once). Units that closed uncharged are swept first, so THE GATE reads a
// current balance: an account out of runway starts nothing (OutOfBalance, before the ledger row or any read). Every
// spend door is a metered unit, so every door is gated here, whoever calls it. `visitor`: an estimate a signed-out
// visitor asked for (marked on the row; services/estimator.js caps those a day). `ceilingUsd`: the X cost it was quoted
// at, never charged past. `dropEmpty`: leave no row when X returned nothing (close). (Onboarding's rate is marked from
// inside a run, meter.bulkRead, once it reads history.)
async function metered({ accountId = null, kind, label, billing = null, visitor = false, ceilingUsd = null, dropEmpty = false }, fn) {
  await settleStale().catch((e) => console.error(`[usage] settling stale units failed: ${e.message}`));
  const billed = !!(billing && accountId);
  if (billing) await billing.settle().catch((e) => console.error(`[usage] charging closed units failed: ${e.message}`));
  if (billed && (await billing.outOfRunway(accountId))) {
    billing.wake(accountId); // auto-refill, if it's on: nothing else would wake it for an account that isn't spending
    throw new OutOfBalance();
  }
  // THE CEILING (ceilingOf): the quote, and what the balance covers now. Units running at once each see the whole
  // balance, so a press made during a sync can take it a press's worth past zero; a sync can't (one per account).
  const quote = Number.isFinite(ceilingUsd) ? ceilingUsd : null;
  const room = billed ? await billing.ceilingFor(accountId) : null;
  const ceiling = ceilingOf(quote, room);
  const startedAt = new Date();
  const entry = await UsageEntry.create({ accountId, kind, label, startedAt, beatAt: startedAt, ...(billed ? { chargeDue: true } : {}), ...(visitor ? { visitor: true } : {}), ...(ceiling ? { ceilingUsd: ceiling.usd, ceilingOf: ceiling.of } : {}) });
  const stopBeat = heartbeat(() => UsageEntry.updateOne({ _id: entry._id, status: "open" }, { $set: { beatAt: new Date() } }));
  let status = "ok";
  let error;
  try {
    return await fn(meterFor(entry._id, accountId, { quote, room }));
  } catch (e) {
    status = "failed";
    error = String(e.message || e).slice(0, 300);
    throw e;
  } finally {
    stopBeat();
    await close(entry._id, { status, error, dropEmpty });
    if (billed) await billing.chargeUnit(entry._id).catch((e) => console.error(`[usage] charging ${entry._id} failed (the next unit retries): ${e.message}`));
  }
}

const spentOf = { $max: [{ $ifNull: ["$d", 0] }, 0] }; // a reading's positive move: what was spent before it

// What each `what` on the ledger (lib/x.js meter.record / recordAction) is, in words: [one, many] ("{n}" is the
// count), in the order a run reads them. ONE vocabulary for every table that says what a unit read or did (the
// owner's Runs, a customer's statement). THE ROW'S TITLE SAYS THE CONTEXT, so the words never repeat it (a
// pass over every name for coherence and simplicity): a Live row's items don't each say ", live";
// a Sign-in row's read is "your profile", a cost estimate's (titled "Cost estimate: @them") "1 profile · 2 post
// counts". Plain over exact where the exact words were wrong: "likers" are people who liked your POSTS (replies
// included); "follows" is the list of accounts you follow (the follower read that also used it was deleted).
const READ_WORDS = [
  ["timeline", "1 of your posts", "{n} of your posts"],
  ["mentions", "1 mention of you", "{n} mentions of you"],
  ["quotes", "1 quote of your post", "{n} quotes of your posts"],
  ["context", "1 post in your conversations", "{n} posts in your conversations"],
  ["likes", "1 of your likes", "{n} of your likes"],
  ["likers", "1 person who liked your post", "{n} people who liked your posts"],
  ["self", "your profile", "your profile"],
  ["profiles", "1 person's profile", "{n} people's profiles"],
  ["follows", "1 account you follow", "{n} accounts you follow"],
  ["me", "your profile", "your profile"],
  ["lookup", "1 profile", "{n} profiles"],
  ["tagged", "1 of their posts", "{n} of their posts"], // Who they tag (services/tagged.js): titled "Who @them tags"
  ["counted", "1 post count", "{n} post counts"],
  ["liked", "liked 1 post", "liked {n} posts"],
  ["unliked", "unliked 1 post", "unliked {n} posts"],
  ["reposted", "reposted 1 post", "reposted {n} posts"],
  ["unreposted", "undid 1 repost", "undid {n} reposts"],
  ["replied", "posted 1 reply", "posted {n} replies"],
  ["uploaded", "uploaded 1 picture", "uploaded {n} pictures"],
  ["followed", "followed 1 person", "followed {n} people"],
  ["unfollowed", "unfollowed 1 person", "unfollowed {n} people"],
  ["messaged", "sent 1 DM", "sent {n} DMs"],
  // What X pushed as it happened (services/live.js): their row is titled "Live", so the words don't say it again.
  ["live-replies", "1 reply to you", "{n} replies to you"],
  ["live-mentions", "1 mention of you", "{n} mentions of you"],
  ["live-quotes", "1 quote of your post", "{n} quotes of your posts"],
  ["live-posts", "1 of your posts", "{n} of your posts"],
  ["live-likes", "1 like", "{n} likes"],
  ["live-reposts", "1 repost of your post", "{n} reposts of your posts"],
  ["live-follows", "1 follow or unfollow", "{n} follows and unfollows"],
];

// One ledger row's reads in words, one part per kind: [{ text, note }]. `note` says how much X had already charged
// for earlier that UTC day (so it cost nothing again): "already paid" for all of it, "{n} already paid" for some. [] = it read nothing (the run checked and found nothing new). Pure.
function describeReads(lines) {
  const by = new Map(); // what → { returned, billed }, summed over price classes (timeline:owned + timeline:post)
  for (const [key, v] of Object.entries(lines || {})) {
    const what = key.split(":")[0];
    const t = by.get(what) || { returned: 0, billed: 0 };
    t.returned += v.returned || 0;
    t.billed += v.billed || 0;
    by.set(what, t);
  }
  const known = new Set(READ_WORDS.map(([w]) => w));
  const words = [...READ_WORDS, ...[...by.keys()].filter((w) => !known.has(w)).map((w) => [w, `1 ${w}`, `{n} ${w}`])];
  const parts = [];
  for (const [what, one, many] of words) {
    const t = by.get(what);
    if (!t || !t.returned) continue;
    const paid = t.returned - t.billed;
    parts.push({
      text: (t.returned === 1 ? one : many).replace("{n}", t.returned.toLocaleString("en-US")),
      note: paid <= 0 ? null : paid >= t.returned ? "already paid" : `${paid.toLocaleString("en-US")} already paid`,
    });
  }
  return parts;
}

// THE OWNER'S TIME: when `accountId` became the developer account paying X for the app, if another paid before it
// (its first balance reading, when an earlier reading is another account's); null when it always was (its page shows
// all of the ledger). When the app moved from its first developer account to @xtoolio's, @xtoolio's
// Usage showed a week of spend it never had. The units before it
// were the app's, paid by the account before: they belong on that account's page, not this one's.
async function tenureOf(accountId) {
  const first = await BalanceReading.findOne({ owner: accountId }, "at").sort({ at: 1 }).lean();
  if (!first) return null;
  return (await BalanceReading.exists({ owner: { $ne: accountId }, at: { $lt: first.at } })) ? first.at : null;
}

// ── The Usage page (web.js usageView). `owner`: the app owner, who sees X's real balance and spend and every account's
// runs; anyone else sees only their own runs, as estimates (the balance is the owner's money). ──

// The top and the chart: X's balance now (the owner), when the ledger began (spend before it is in no figure), and the
// money per day in the viewer's zone from `since` ("YYYY-MM-DD") on: [{ day, est, real }]. `est`: the units' estimates
// (the account's own; every account's for the owner). `real` (the owner): X's spend, the sum of the day's drops; null
// on a day before the first reading (unknown, never $0), 0 on a day inside the readings that didn't move (dedup, or
// reads too small to move it). The owner's estimates are summed only before the first reading: after it, `real` is
// the figure. Both sums run in the database (a year of the clock is up to ~500k readings). The owner viewing IS
// `accountId`, and sees ITS OWN TIME as the app's developer account only (`tenureOf`): its balance, its spend, its runs.
async function usageSummary({ accountId, owner, timeZone = "UTC", since }) {
  const start = owner ? await tenureOf(accountId) : null;
  const match = owner ? (start ? { startedAt: { $gte: start } } : {}) : { accountId };
  const from = new Date(`${since}T00:00:00Z`); // a day early in zones ahead of UTC: trimmed by `since` below
  from.setUTCDate(from.getUTCDate() - 1);
  const [ledgerFirst, firstReading, latest] = await Promise.all([
    UsageEntry.findOne(match, "startedAt").sort({ startedAt: 1 }).lean(),
    owner ? BalanceReading.findOne({ owner: accountId }, "at").sort({ at: 1 }).lean() : null,
    owner ? BalanceReading.findOne({ owner: accountId }, "usd at").sort({ at: -1 }).lean() : null,
  ]);
  // Estimates fill only the days before the owner's first reading (never inside another account's time: that range
  // is empty once `start` is that first reading).
  const estAt = { $gte: start && start > from ? start : from, ...(firstReading ? { $lt: firstReading.at } : {}) };
  const [est, real] = await Promise.all([
    UsageEntry.aggregate([{ $match: { ...match, startedAt: estAt } }, { $group: { _id: dayExpr("$startedAt", timeZone), usd: { $sum: "$estUsd" } } }]),
    firstReading ? BalanceReading.aggregate([{ $match: { owner: accountId, at: { $gte: from } } }, { $group: { _id: dayExpr("$at", timeZone), usd: { $sum: spentOf } } }]) : [],
  ]);
  const days = new Map();
  const day = (k) => days.get(k) || days.set(k, { day: k, est: 0, real: null }).get(k);
  for (const g of est) day(g._id).est = cents(g.usd);
  for (const g of real) day(g._id).real = cents(g.usd);
  if (firstReading) {
    const first = dayIn(timeZone)(firstReading.at);
    for (const d of days.values()) if (d.real === null && d.day >= first) d.real = 0;
  }
  return {
    since: start || (ledgerFirst ? ledgerFirst.startedAt : null),
    handover: Boolean(start), // `since` is when this developer account took over, not when the ledger began
    balance: latest ? { usd: latest.usd, at: latest.at } : null,
    days: [...days.values()].filter((d) => d.day >= since).sort((a, b) => (a.day < b.day ? 1 : -1)),
  };
}

// The clock reads X's balance once a minute, so a unit's cost is in the first reading up to a minute after it closed.
const READ_AFTER_MS = 61 * 1000;

// A page of the ledger, newest first (lib/feedCursor.js: `before` is the last row shown; `next` the cursor for the
// page after, null at the end). Each unit with what it read and whether it's still running. The owner's also carry X's
// balance just after each (`after`: the clock's reading up to a minute after it closed; null while running or before
// the first reading), and `credits`: rises in X's balance among these rows (credit added on X), each with the balance
// it made. The owner's rows are ITS OWN TIME only (`tenureOf`), each paired with its own balance (BalanceReading.owner =
// `accountId`). ONLY UNITS THAT COST SOMETHING: one X billed nothing for (a sync that found nothing new, or re-read what
// was already paid for that UTC day) is no line on the feed, for anyone (every account's syncs, every 15 minutes, made
// the owner's feed unreadable); a running one shows once its first billed read lands (`estUsd` moves as it reads).
// Settles dead units first, so the page never shows one as running.
async function usageRows({ accountId, owner, before = null, limit = 30, now = new Date() }) {
  await settleStale(now.getTime()).catch(() => {});
  const start = owner ? await tenureOf(accountId) : null;
  const match = { ...(owner ? (start ? { startedAt: { $gte: start } } : {}) : { accountId }), estUsd: { $gt: 0 } };
  const { rows, next } = await page((f) => UsageEntry.find({ $and: [match, f] },"accountId kind label startedAt endedAt status error lines estUsd beatAt"), { field: "startedAt", before, limit });
  const entries = rows.map((e) => ({ ...e, reads: describeReads(e.lines), running: alive(e, now.getTime()) }));
  if (!owner) return { entries, credits: [], next };

  const readingAt = (t) => BalanceReading.findOne({ owner: accountId, at: { $lte: t } }, "usd at").sort({ at: -1 }).lean();
  await Promise.all(
    entries.map(async (e) => {
      if (e.running) return;
      const end = new Date(e.endedAt || e.beatAt || e.startedAt).getTime();
      const r = await readingAt(new Date(Math.min(now.getTime(), end + READ_AFTER_MS)));
      e.after = r ? { usd: r.usd, at: r.at } : null;
    })
  );
  // The credits between this page's rows: after its oldest row (unless it's the last page) up to where it starts.
  const high = cursorTime(before) || now;
  const low = next && entries.length ? entries[entries.length - 1].startedAt : null;
  const credits = await BalanceReading.find({ owner: accountId, d: { $lt: 0 }, at: { $lte: high, ...(low ? { $gt: low } : {}) } }, "usd at d").sort({ at: -1 }).lean();
  return { entries, credits: credits.map((c) => ({ at: c.at, usd: -c.d, balanceUsd: c.usd })), next };
}

module.exports = { metered, meterFor, ceilingOf, firstToday, settleStale, takeReading, moveOf, describeReads, usageSummary, usageRows, alive, STALE_MS };
