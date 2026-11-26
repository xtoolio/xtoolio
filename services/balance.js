// THE BALANCE: what each account is charged for its X work, and the one way its prepaid balance moves
// (docs/BILLING.md), in micro-dollars and keyed by unit.
//
// A unit of X work (services/usage.js metered: a sync, a like) is charged once it closes:
//   cost   = AT X'S PRICES: what X returned to this unit (and the writes it made), each at X's published price, minus what X
//            had already billed that UTC day (UsageEntry.estUsd, recorded per response: services/usage.js meterFor).
//            Exactly that, so a charge can be checked by hand against X's price list (a charge is never
//            approximate). It used to be × a CALIBRATION (X's real spend over 7 days ÷ every unit's
//            amount, clamped [0.5, 1.2]), which made charges match X's real bill on average but not the price list
//            the front page and the Terms promise; deleted. Drift between X's bill and its own price list is the
//            operator's (the Usage page shows both). (Before that, a unit that ran alone was charged X's exact
//            balance drop around it; with many accounts syncing at once almost none ran alone: services/usage.js.)
//   charge = cost + its markup, cost × (multiplierFor(account) − 1), in integer micro-dollars: the ONE place the markup
//            is applied. A BULK READ (UsageEntry.bulkRead) is ONBOARDING ONLY: reading your history, and the look back
//            through your likes (onboarding is the only bulk read at this rate; the whole follower list and
//            the accounts you follow briefly had it too). It has its own
//            rate (bulkRate, BULK_MARKUP_PCT, 15%), never more than the account's own, and isn't counted toward the
//            month's threshold. THE CEILING (UsageEntry.ceilingUsd): no unit is charged on more X cost than the quote
//            shown before it ran, nor than its account's balance covered when it started (ceilingFor; lib/x.js stops
//            reading there too), so no unit takes a balance below zero (a history read never goes past the
//            funded balance). The full rate runs per account per calendar month (UTC) until the markup reaches a
//            threshold (markupCapMicros, MARKUP_CAP_USD, $50), then the rate drops (markupAfterRate,
//            MARKUP_AFTER_CAP_PCT, 15%) until the month turns (a flat cap couldn't cover card processing on
//            big users). Account.markupMonth / markupMicros count the month's markup, moved
//            in the same atomic write as the charge, guarded by the values read (a concurrent charge makes the write
//            miss; it re-reads and retries), so two charges at once can't both take the threshold's last dollars at the
//            full rate.
// The app owner (X_APP_OWNER_ID) pays X directly and is never charged.
//
// EXACTLY ONCE: every movement carries a key ("run:<UsageEntry id>", "topup:<invoice id>"), and two guards hold it:
//   - FOR GOOD, the BalanceEntry row (unique on kind + ref, never trimmed), written only after the money moved: a key
//     with a row is never applied again. The list below alone isn't enough: it keeps the last 500 keys, every charge
//     pushes one, so an old top-up's key falls out of it, and only the row still refuses that payment a second time
//     (a reopened Stripe return link, /billing/done?session_id=…).
//   - IN FLIGHT, Account.appliedRefs: the account's filter requires the key absent and the update pushes it, in the
//     SAME atomic write as the $inc, so two writers racing before the row exists (a retry, a second process, a
//     redelivered webhook) apply it once. If a crash falls between the money and its row, the retry finds the key
//     there and writes the missing row. (A row that also failed to write AND a key since pushed out of the 500 is the
//     one gap left; the row's failure is logged loudly.)
//
// Config-free (verify loads it with no .env): createBalance(settings) binds the rules to the platform's settings;
// services/billing.js builds the app's one instance from config.
"use strict";

const Account = require("../models/Account");
const BalanceEntry = require("../models/BalanceEntry");
const UsageEntry = require("../models/UsageEntry");
const LiveEvent = require("../models/LiveEvent");

const MICROS = 1e6;
const MIN_MULTIPLIER = 1;
const MAX_MULTIPLIER = 3;
const APPLIED_KEEP = 500; // refs kept per account: far more than the movements that can be in flight at once

const toMicros = (usd) => (Number.isFinite(Number(usd)) ? Math.round(Number(usd) * MICROS) : 0);
const toUsd = (micros) => (Number(micros) || 0) / MICROS;

// This account's multiplier: its own override when set and in bounds, else the platform's. Pure. An account's own rate
// is a DISCOUNT only: between X's cost (1) and the platform's published rate, never above it (the Terms state one
// markup; a stored value outside that is ignored).
function multiplierFor(account, platform) {
  const m = account && account.marginMultiplier;
  return typeof m === "number" && m >= MIN_MULTIPLIER && m <= platform ? m : platform;
}

// What this unit cost at X's prices (see top). Pure.
function unitCost(entry) {
  return { usd: Math.max(0, entry.estUsd || 0), basis: "prices" };
}

// THE CEILING (UsageEntry.ceilingUsd, X's cost at most): a unit is never charged on more than the quote the person
// agreed to (the reconciler's list read, which may read up to 100 past the count it was priced on), nor on more than
// its account's balance covered when it started (`of` "balance": what lets a history read be certain never to charge
// past what was funded; lib/x.js also stops reading there, so this only absorbs the last request). Pure.
const capped = (cost, ceilingUsd, of = "quote") => (Number.isFinite(ceilingUsd) && cost.usd > ceilingUsd ? { usd: Math.max(0, ceilingUsd), basis: of } : cost);

// X's cost → the marked-up charge in micro-dollars. Zero, negative or not a number → 0 (never a spurious charge). Pure.
function priceMicros(costUsd, multiplier) {
  const c = Number(costUsd);
  if (!Number.isFinite(c) || c <= 0) return 0;
  return Math.round(c * multiplier * MICROS);
}

// The month a markup counts in: "YYYY-MM", UTC. Pure.
const monthOf = (d = new Date()) => d.toISOString().slice(0, 7);

// The markup on one charge of `costMicros` at `multiplier`: the full rate (multiplier − 1) while this month's markup so
// far (`usedMicros`) is under `capMicros` (the threshold, 0 = none), then `afterRate` (MARKUP_AFTER_CAP_PCT; never more
// than the full rate). A charge that crosses the threshold is split at it: the part of its cost that brings the markup
// to the threshold at the full rate, the rest at the lower one. Pure.
function markupWithin(costMicros, multiplier, capMicros, usedMicros = 0, afterRate = 0) {
  const rate = Math.max(0, multiplier - 1);
  const full = Math.max(0, Math.round(costMicros * rate));
  if (!(capMicros > 0) || rate === 0) return full;
  const room = Math.max(0, capMicros - usedMicros); // full-rate markup left this month
  if (full <= room) return full;
  const atFull = room / rate; // the part of this cost still at the full rate
  return Math.round(room + (costMicros - atFull) * Math.min(afterRate, rate));
}

// A month's markup on `costUsd` of X's price, by the same rule from zero (the quotes: the estimator, Settings' total).
// Dollars. Pure.
const monthMarkup = (costUsd, multiplier, capUsd, afterRate) => toUsd(markupWithin(toMicros(costUsd), multiplier, toMicros(capUsd), 0, afterRate));

// Was the movement keyed `kind:ref` applied to this account, by either guard (see top)? → bool
const applied = async (accountId, kind, ref) =>
  !!(await BalanceEntry.exists({ kind, ref: String(ref) })) || !!(await Account.exists({ _id: accountId, appliedRefs: `${kind}:${ref}` }));

// Move one account's balance by `micros` (signed) and write its ledger row. `ref` makes it exactly-once (see top);
// `where` makes it conditional and `set` carries the caller's own state change in the same write (a top-up clearing
// the deposit). → { micros, balanceMicros } | null (already applied, condition not met, no such account, 0).
async function move(accountId, micros, { kind, ref = null, label = "", where = {}, set = {}, row = {} }) {
  const amount = Math.round(Number(micros));
  if (!accountId || !Number.isFinite(amount) || amount === 0) return null;
  const key = ref ? `${kind}:${ref}` : null;
  if (ref && (await BalanceEntry.exists({ kind, ref: String(ref) }))) return null; // applied for good (see top)
  const filter = { ...where, _id: accountId, ...(key ? { appliedRefs: { $ne: key } } : {}) };
  const update = { $inc: { balanceMicros: amount }, ...(Object.keys(set).length ? { $set: set } : {}), ...(key ? { $push: { appliedRefs: { $each: [key], $slice: -APPLIED_KEEP } } } : {}) };
  const doc = await Account.findOneAndUpdate(filter, update, { returnDocument: "after", projection: { balanceMicros: 1 } }).lean();
  const entry = { accountId, micros: amount, kind, ref, label: String(label).slice(0, 120), ...row };
  if (!doc) {
    // Applied before, by a write that died before its row: write the row now (balanceAfter unknown). Never moves money.
    if (key && (await Account.exists({ _id: accountId, appliedRefs: key }))) await writeEntry({ ...entry, balanceAfter: null });
    return null;
  }
  await writeEntry({ ...entry, balanceAfter: doc.balanceMicros });
  await LiveEvent.note(accountId, "balance"); // its open pages: the header's balance (services/livePush.js)
  return { micros: amount, balanceMicros: doc.balanceMicros };
}

// The ledger row. Keyed rows are upserted (a concurrent writer of the same row loses the unique index, harmlessly).
// Best-effort after the money moved, but loud: a failed row must never undo or block a charge.
async function writeEntry(entry) {
  try {
    if (!entry.ref) return void (await BalanceEntry.create(entry));
    const { kind, ref, ...rest } = entry;
    await BalanceEntry.updateOne({ kind, ref }, { $setOnInsert: { ...rest, at: new Date() } }, { upsert: true });
  } catch (e) {
    if (e && e.code === 11000) return;
    console.error(`[balance] ledger row FAILED for ${entry.accountId} (${entry.micros} µ$ ${entry.kind} ${entry.ref || ""}): ${e.message}`);
  }
}

// The rules bound to the platform's settings: { enabled, ownerId, multiplier, floorMicros }. `watch(accountId)` is
// THE BALANCE WATCHER (services/autoRefill.js): woken, detached, after every charge that moved money and whenever the
// gate refuses an account (services/usage.js metered: a paused account has no charges to wake it).
function createBalance({ enabled = false, ownerId = null, multiplier, markupCapMicros = 0, markupAfterRate = 0, bulkRate = 0, floorMicros = 0, watch = null }) {
  if (!(multiplier >= MIN_MULTIPLIER && multiplier <= MAX_MULTIPLIER)) throw new Error(`multiplier must be in [${MIN_MULTIPLIER}, ${MAX_MULTIPLIER}]`);
  const isOwner = (accountId) => !!ownerId && accountId === ownerId;
  // A spend site never waits on Stripe: the watcher claims atomically, so concurrent wakes make one refill.
  const wake = (accountId) => {
    if (watch) Promise.resolve().then(() => watch(accountId)).catch((err) => console.error(`[balance] watcher failed for ${accountId}: ${err.message}`));
  };

  // Charge one closed unit, once (see top). Clears its chargeDue once it's settled: charged (now or before), costing
  // nothing, the owner's, or its account gone. One whose write kept missing (concurrent charges took the month's markup
  // every try) stays due, and the next sweep charges it. → the move | null.
  async function chargeUnit(entryId) {
    const e = await UsageEntry.findById(entryId, "accountId status label estUsd chargeDue bulkRead ceilingUsd ceilingOf").lean();
    if (!e || e.status === "open" || !e.chargeDue) return null; // still running (its close charges it), or done
    let moved = null;
    let settled = true;
    const ref = String(e._id);
    const cost = capped(unitCost(e), e.ceilingUsd, e.ceilingOf || "quote");
    const costMicros = priceMicros(cost.usd, 1);
    if (e.accountId && !isOwner(e.accountId) && costMicros > 0) {
      // The month's markup so far is read, then the charge is written only if it's still that (see top): a concurrent
      // charge makes the write miss, and this reads again. A few tries are plenty (each miss means another charge landed).
      settled = false;
      for (let tries = 0; tries < 5 && !settled; tries++) {
        const account = await Account.findById(e.accountId, "marginMultiplier markupMonth markupMicros").lean();
        if (!account) {
          settled = true;
          break;
        }
        // A bulk read (UsageEntry.bulkRead) has its own markup (bulkRate, 15%), and it doesn't count toward the month's
        // threshold: the month's count is written back unchanged.
        const month = monthOf();
        const used = account.markupMonth === month ? account.markupMicros || 0 : 0;
        const m = rateFor(account, e.bulkRead);
        const markup = e.bulkRead ? markupWithin(costMicros, m, 0) : markupWithin(costMicros, m, markupCapMicros, used, markupAfterRate);
        const counted = e.bulkRead ? 0 : markup;
        moved = await move(e.accountId, -(costMicros + markup), {
          kind: "run",
          ref,
          label: e.label,
          where: { markupMonth: account.markupMonth === undefined ? null : account.markupMonth, markupMicros: account.markupMicros === undefined ? null : account.markupMicros },
          set: { markupMonth: month, markupMicros: used + counted },
          row: { costUsd: cost.usd, basis: cost.basis, multiplier: m, markupUsd: toUsd(markup) },
        });
        settled = !!moved || (await applied(e.accountId, "run", ref)); // charged (now or before)
      }
      if (moved) wake(e.accountId);
      // This charge took it across THE GATE (above the floor before, at or under it now): its live subscriptions go
      // (services/live.js desiredSubs, re-ensured within seconds), the way a top-up brings them back. Until then they
      // stayed up to an hour (the next ledger flush refused), X delivering and billing events nobody had paid for.
      // And THE PAUSE starts (services/pause.js, why "balance"): reading stopped now, so a top-up more than a day later
      // asks how far back to read what was missed. One already recorded (paused by you) keeps its start.
      // Only while the site charges: with billing off the charge is a shadow bill, and no gate shuts.
      if (enabled && moved && moved.balanceMicros <= floorMicros && moved.balanceMicros - moved.micros > floorMicros) {
        await Account.updateOne({ _id: e.accountId }, { $set: { "live.due": true } });
        await Account.updateOne({ _id: e.accountId, "pause.at": { $exists: false } }, { $set: { pause: { at: new Date(), why: "balance" } } });
      }
    }
    if (settled) await UsageEntry.updateOne({ _id: e._id }, { $unset: { chargeDue: 1 } });
    return moved;
  }

  // Charge every closed unit still due (a process that died between a close and its charge; a dead unit
  // settleStale closed). services/usage.js runs it before every unit, so the gate reads a current balance.
  async function settle(limit = 100) {
    const due = await UsageEntry.find({ chargeDue: true, status: { $ne: "open" } }, "_id").limit(limit).lean();
    for (const { _id } of due) {
      try {
        await chargeUnit(_id);
      } catch (e) {
        console.error(`[balance] charging unit ${_id} failed (retried by the next sweep): ${e.message}`);
      }
    }
  }

  // THE GATE CONDITION, on a loaded account ({ _id, balanceMicros }): is it out of runway, so no unit of X work may
  // begin? False when billing is off, for the owner, and for no account at all (fail-open: a blip shouldn't block a
  // paying account; its own reads fail anyway). The header banner reads it off the request's account.
  const paused = (account) => enabled && !!account && !isOwner(account._id) && (account.balanceMicros || 0) <= floorMicros;

  // The same, on a fresh read: services/usage.js metered checks it before every unit (concurrent units debit between
  // requests, so the request's copy isn't good enough there).
  async function outOfRunway(accountId) {
    if (!enabled || !accountId || isOwner(accountId)) return false;
    return paused(await Account.findById(accountId, "balanceMicros").lean());
  }

  // The multiplier work is charged at: an account's own, or for a bulk read (`bulk`) the bulk rate, never more than its
  // own (chargeUnit's rule).
  const rateFor = (account, bulk) => (bulk ? Math.min(1 + bulkRate, multiplierFor(account, multiplier)) : multiplierFor(account, multiplier));

  // THE BALANCE CEILING for a unit starting now (services/usage.js metered): how much X cost this account's balance
  // above the floor covers, at its full rate (`full`, every unit) and at the bulk rate (`bulk`, once a run reads
  // history: meter.bulkRead). X's cost, in dollars; fresh from the database, like the gate. null: nothing to cap (billing
  // off, the owner, no account). The full rate is the most a charge can be (the month's threshold only lowers it), so
  // a unit read to its ceiling is charged at most the balance.
  async function ceilingFor(accountId) {
    if (!enabled || !accountId || isOwner(accountId)) return null;
    const account = await Account.findById(accountId, "balanceMicros marginMultiplier").lean();
    if (!account) return null;
    const room = toUsd(Math.max(0, (account.balanceMicros || 0) - floorMicros));
    return { full: room / rateFor(account, false), bulk: room / rateFor(account, true) };
  }

  // What this account pays for X work that costs `costUsd` (the quotes shown before a button is pressed). The owner
  // pays X directly, and with billing off nobody pays: then it's X's cost. `bulk`: a bulk read.
  const priceFor = (account, costUsd, { bulk = false } = {}) => (!enabled || isOwner(account && account._id) ? costUsd : costUsd * rateFor(account, bulk));

  // Can it start work quoted at `costUsd` and stay above the floor? For a unit whose price is known before it starts
  // (the first pull, a bulk list read), so one press can't run the balance deep into the red: the plain gate only
  // stops the NEXT unit. Loaded account: { _id, balanceMicros, marginMultiplier }. `bulk`: a bulk read.
  // Never while THE GATE is shut (`paused`): no unit starts then, so nothing, not even a free choice, is covered (a $0
  // "From now" at exactly the floor read as covered, and resuming that way dropped the pause the top-up would have asked
  // about).
  const affords = (account, costUsd, { bulk = false } = {}) =>
    !enabled || isOwner(account && account._id) || (!paused(account) && (account.balanceMicros || 0) - priceMicros(costUsd, rateFor(account, bulk)) >= floorMicros);

  // Money in (a top-up, a credit by hand). `ref` (an invoice id) makes it exactly-once. Both money-in and a refund can
  // move an account across THE GATE (paused ↔ not), which decides its live subscriptions (services/live.js
  // desiredSubs), so each flags `live.due` in the same write and the worker re-ensures within seconds. Before
  // this nothing did: an account that signed in at $0 (no subscriptions) and topped up two minutes later waited
  // for the hourly ensure to go Live.
  const LIVE_DUE = { "live.due": true };
  const credit = (accountId, micros, { kind = "credit", ref = null, label = "", where, set, row } = {}) =>
    micros > 0 ? move(accountId, micros, { kind, ref, label, where, set: { ...set, ...LIVE_DUE }, row }) : Promise.resolve(null);
  // A refund granted by hand in Stripe, taken back off the balance (scripts/credit.js with a negative amount): `micros`
  // is how much, positive. Refunds are never automatic (each is granted by hand).
  const takeBack = (accountId, micros, { ref = null, label = "" } = {}) => (micros > 0 ? move(accountId, -micros, { kind: "refund", ref, label, set: LIVE_DUE }) : Promise.resolve(null));

  // A month's markup on `costUsd` of X's price at multiplier `m` (the platform's when omitted): the quotes' rule.
  const monthFee = (costUsd, m = multiplier) => monthMarkup(costUsd, m, toUsd(markupCapMicros), markupAfterRate);
  return { enabled, isOwner, multiplierFor: (account) => multiplierFor(account, multiplier), markupCapUsd: toUsd(markupCapMicros), markupAfterPct: Math.round(markupAfterRate * 100), bulkPct: Math.round(bulkRate * 100), monthFee, chargeUnit, settle, paused, outOfRunway, ceilingFor, priceFor, affords, credit, takeBack, wake };
}

// What metered() throws instead of starting a unit for an account out of runway. Callers recognise it by its code
// (services/sync.js turns it into a skipped run, as it does NEEDS_REAUTH).
class OutOfBalance extends Error {
  constructor() {
    super("out of balance: top up to resume");
    this.code = "OUT_OF_BALANCE";
  }
}

module.exports = { createBalance, OutOfBalance, multiplierFor, unitCost, capped, priceMicros, markupWithin, monthMarkup, monthOf, toMicros, toUsd, MIN_MULTIPLIER, MAX_MULTIPLIER };
