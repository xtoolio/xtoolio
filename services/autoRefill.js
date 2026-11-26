// AUTO-REFILL: the balance watcher and the refill it runs (docs/BILLING.md decision 11). No job queue: the atomic claim
// keeps a refill to one across web + worker.
//
// watch(accountId) runs after every charge (services/balance.js wake) and whenever the gate refuses an account
// (services/usage.js metered: a paused account has no charges to wake it). At or under AUTO_REFILL_THRESHOLD_CENTS,
// with auto-refill on and a card saved, it CLAIMS the refill on the account (one in flight, stale after 15 minutes; an
// hour between attempts) and charges the card (billing.chargeRefill: an off-session invoice, settled by the one credit
// path). Ten concurrent charges make one refill: only the claim's winner charges.
//
// THE FAILURE POLICY lives here: a failure is counted and its cause kept in plain words (the header banner and
// Settings show it); two in a row switch auto-refill off. A card that keeps declining must never become a silent
// loop. Saving a card resets it all (billing.handleCardSetup).
//
// THE MONTHLY LIMIT: refills in a calendar month (UTC) add up to at most the account's chosen limit (LIMITS; "no limit"
// is a choice too), counted from the ledger's own auto-refill rows (BalanceEntry: what was really credited, no counter
// to drift). A refill that would pass it isn't charged; the account runs down to $0 and pauses as without auto-refill,
// and the banner says the limit stopped it. Before it, the only brakes were an hour between refills and two failures
// in a row: a runaway could take a refill an hour off someone's card.
//
// No email exists in xtoolio, so "telling" is the header banner (notice below): refill failed, paused, or low with
// refill off. A banner shows for as long as the state lasts, so there's no once-per-dip flag to keep.
"use strict";

const config = require("../config");
const Account = require("../models/Account");
const BalanceEntry = require("../models/BalanceEntry");
const billing = require("./billing");
const { toUsd, toMicros, monthOf } = require("./balance"); // THE micro-dollars ↔ dollars, THE month (UTC)
const { dollars } = require("../lib/hbs").helpers; // THE balance format, the views' own
const { modulesOn } = require("./features");

const COOLDOWN_MS = 60 * 60 * 1000;
const IN_FLIGHT_STALE_MS = 15 * 60 * 1000;
const MAX_FAILS = 2;
const thresholdMicros = () => config.billing.autoRefillThresholdCents * 10000;
const thresholdLabel = () => `$${(config.billing.autoRefillThresholdCents / 100).toFixed(0)}`;
const PROJECTION = "balanceMicros stripeCustomerId autoRefill username";
// THE MONTHLY LIMIT's choices, dollars a month; 0 = no limit. An account that never chose has the default.
const LIMITS = [250, 500, 1000, 0];
const DEFAULT_LIMIT = 250;
const limitOf = (account) => {
  const chosen = Number(((account && account.autoRefill) || {}).monthlyLimitUsd);
  return LIMITS.includes(chosen) ? chosen : DEFAULT_LIMIT;
};
// What auto-refill has added this calendar month (UTC), from the ledger. Micro-dollars.
async function refilledThisMonth(accountId, now = new Date()) {
  const start = new Date(`${monthOf(now)}-01T00:00:00Z`);
  const [sum] = await BalanceEntry.aggregate([{ $match: { accountId, kind: "auto-refill", at: { $gte: start } } }, { $group: { _id: null, micros: { $sum: "$micros" } } }]);
  return sum ? sum.micros : 0;
}
// Would one more refill pass this month's limit? → bool (never, with no limit).
async function overLimit(account, now = new Date()) {
  const limit = limitOf(account);
  return !!limit && (await refilledThisMonth(account._id, now)) + toMicros(billing.refillUsdOf(account)) > toMicros(limit);
}

// On, with a card, Stripe and billing wired, and not the owner (who pays X directly).
const armed = (account) => {
  const ar = (account && account.autoRefill) || {};
  return !!(config.billing.payable && ar.enabled && ar.paymentMethodId && !billing.isOwner(account._id));
};

// THE WATCHER. → { action: "none", reason } | the refill's outcome. App code fires it detached.
async function watch(accountId) {
  if (!config.billing.payable || !accountId || billing.isOwner(accountId)) return { action: "none", reason: "not billed" };
  const now = new Date();
  // The claim: on, a card, still under the line, no live claim, outside the cooldown. Only one caller can match.
  const claimed = await Account.findOneAndUpdate(
    {
      _id: accountId,
      "autoRefill.enabled": true,
      "autoRefill.paymentMethodId": { $exists: true, $ne: "" },
      balanceMicros: { $lte: thresholdMicros() },
      "pause.why": { $nin: ["you", "away"] }, // paused by you or away (services/pause.js): nothing runs, so nothing to refill for

      $and: [
        { $or: [{ "autoRefill.inFlightAt": null }, { "autoRefill.inFlightAt": { $lt: new Date(now.getTime() - IN_FLIGHT_STALE_MS) } }] },
        { $or: [{ "autoRefill.lastAttemptAt": null }, { "autoRefill.lastAttemptAt": { $lt: new Date(now.getTime() - COOLDOWN_MS) } }] },
      ],
    },
    { $set: { "autoRefill.inFlightAt": now } },
    { returnDocument: "after", projection: PROJECTION }
  ).lean();
  if (!claimed) return { action: "none", reason: "above the line, off, in flight or cooling down" };
  // THE MONTHLY LIMIT, under the claim (so two watchers can't both slip under it): passing it, nothing is charged, the
  // claim is let go with no attempt counted (raising the limit refills at once), and the month is noted for the banner.
  if (await overLimit(claimed, now)) {
    await Account.updateOne({ _id: claimed._id }, { $set: { "autoRefill.inFlightAt": null, "autoRefill.limitMonth": monthOf(now) } });
    return { action: "none", reason: "monthly limit" };
  }
  return refill(claimed, now);
}

// Charge the claimed refill and apply the failure policy. Releases the claim whatever happens but a throw (a DB
// outage leaves it for the stale reclaim).
async function refill(account, now) {
  const ar = account.autoRefill || {};
  const release = (set) => Account.updateOne({ _id: account._id }, { $set: { "autoRefill.inFlightAt": null, "autoRefill.lastAttemptAt": now, ...set } });
  let r;
  try {
    r = await billing.chargeRefill(account);
  } catch (e) {
    r = { ok: false, code: e.code || "error", message: e.message };
  }
  if (r.ok) {
    await release({ "autoRefill.lastRefillAt": now, "autoRefill.failCount": 0, "autoRefill.lastError": "" });
    console.log(`[autoRefill] @${account.username} refilled (${r.invoiceId})`);
    return { action: "refilled", invoiceId: r.invoiceId };
  }
  const fails = (Number(ar.failCount) || 0) + 1;
  const off = fails >= MAX_FAILS;
  const cause = failureCause(r.code, r.message);
  await release({ "autoRefill.failCount": fails, "autoRefill.lastError": cause, ...(off ? { "autoRefill.enabled": false, "autoRefill.disabledReason": "failed" } : {}) });
  console.error(`[autoRefill] @${account.username} refill failed (${r.code}): ${cause}${off ? "; switched off" : ""}`);
  return { action: off ? "switched off" : "failed", cause };
}

// Stripe's codes in plain words, for the banner and Settings. Pure.
function failureCause(code, message) {
  const c = String(code || "");
  if (/insufficient_funds/.test(c)) return "the card was declined for insufficient funds";
  if (/expired_card/.test(c)) return "the card has expired";
  if (/authentication_required/.test(c)) return "your bank wants you to approve the charge yourself";
  if (/card_declined|generic_decline|do_not_honor|payment-failed/.test(c)) return "the card was declined";
  if (/no-card|no-customer/.test(c)) return "there's no card on file";
  return message ? String(message).replace(/\.$/, "").slice(0, 140) : "the charge didn't go through";
}

// The Auto-refill row in Settings.
function view(account) {
  const ar = account.autoRefill || {};
  const amount = billing.refillUsdOf(account);
  const limit = limitOf(account);
  return {
    enabled: !!ar.enabled,
    amountUsd: amount,
    // `amount`, not `usd`: a field named like a helper (lib/hbs.js `usd`) renders the helper instead.
    options: config.billing.topupAmountsUsd.map((usd) => ({ amount: usd, selected: usd === amount })),
    // THE MONTHLY LIMIT's choices (0 = no limit); `limitHit`: it stopped a refill this month.
    limits: LIMITS.map((usd) => ({ amount: usd, selected: usd === limit })),
    limit,
    limitHit: !!limit && ar.limitMonth === monthOf(),
    threshold: thresholdLabel(),
    card: billing.cardLabel({ brand: ar.cardBrand, last4: ar.cardLast4 }),
    switchedOff: !ar.enabled && ar.disabledReason === "failed",
    lastError: (ar.enabled && ar.failCount > 0) || ar.disabledReason === "failed" ? ar.lastError || "" : "",
  };
}

// THE HEADER BANNER for an account that pays, from the request's account: refill failed (with the cause), paused (out
// of balance), or low with auto-refill off. null when there's nothing to say, and before the account has picked what
// to use (that page asks for money itself). → { text, link }.
function notice(account) {
  if (!account || !billing.enabled || billing.isOwner(account._id) || !modulesOn(account).length) return null;
  const v = view(account);
  const paused = billing.paused(account);
  const card = v.card || "your card";
  if (v.lastError) {
    const what = v.switchedOff ? `Auto-refill is off: it couldn't charge ${card} twice (${v.lastError}).` : `Auto-refill couldn't charge ${card}: ${v.lastError}. It tries once more on a later sync; if that fails too, it turns off.`;
    return { text: `${what}${paused ? " Syncing is paused until you top up." : ""}`, link: "Update the card" };
  }
  if (v.enabled && v.limitHit && (paused || (account.balanceMicros || 0) <= thresholdMicros())) {
    return { text: `Auto-refill reached your $${v.limit} limit for this month.${paused ? " Syncing is paused." : " Syncing pauses at $0."}`, link: "Top up or raise the limit" };
  }
  if (paused) return { text: "Your balance ran out, so syncing is paused.", link: "Top up to resume" };
  if (!armed(account) && (account.balanceMicros || 0) <= thresholdMicros()) {
    return { text: `Your balance is down to ${dollars(toUsd(Math.max(0, account.balanceMicros || 0)))}. Syncing pauses at $0.`, link: "Top up or turn on auto-refill" };
  }
  return null;
}

module.exports = { watch, refill, failureCause, view, notice, armed, overLimit, refilledThisMonth, limitOf, LIMITS, DEFAULT_LIMIT, COOLDOWN_MS, IN_FLIGHT_STALE_MS, MAX_FAILS };
