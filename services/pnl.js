// services/pnl.js — THE P&L (Admin → P&L, routes/admin.js): profit and loss across accounts. The Usage page reconciles the X balance with no billing
// in it; this is where billing meets X's cost, for a calendar month (UTC, the months the markup's threshold counts).
// THE COLUMNS (deposits first, then balance, then charged and margin, and margin %; they replaced X's cost and Not
// charged per row, both dropped):
//   DEPOSITED  the money paid in that month: Stripe top-ups and auto-refills, net of refunds taken back by hand
//              ("credit" rows are the operator's gifts, not money, and are left out);
//   BALANCE    what the account holds at the month's end (now, for this month: `Account.balanceMicros`; an earlier
//              month: the last BalanceEntry's `balanceAfter` before it ended);
//   CHARGED    its "run" BalanceEntry rows that month;
//   MARGIN     on those charged runs (charged − the cost each charge was on, `costUsd`). The owner's own use (AS OF EACH
//              RUN: the app can move to another developer account, so an account can be the owner for part
//              of a month; the charge rows say which runs were billed) and a run's overshoot past its quote or the
//              balance (balance.capped) aren't in it. THE SITE'S OWN COSTS (PLATFORM below: sign-ins, front-page
//              estimates, the waitlist's follow checks, invites, "you're in" DMs, one-off scripts with no account) are
//              one row each, a margin of −its cost: they earn nothing, and they're the cost of doing business, not
//              anyone's own use;
//   MARGIN %   margin ÷ charged (gross margin; a 50% markup is 33%).
// Nothing above the table (the table's Total row is enough; a NET, charged − X's cost, and X's real spend
// that month sat there big, and were deleted whole). Before Stripe's fees. Charges are counted by when they were written, costs by when their unit started: a unit across
// midnight at a month's end lands its cost in one month and its charge in the next (a few cents at most).
"use strict";

const UsageEntry = require("../models/UsageEntry");
const BalanceEntry = require("../models/BalanceEntry");
const Account = require("../models/Account");

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const { toMicros: micros } = require("./balance"); // THE dollars → micro-dollars
const DEPOSIT_KINDS = ["topup", "auto-refill", "refund"]; // refund rows are negative

// "YYYY-MM" → [start, end) in UTC.
function monthRange(month) {
  const from = new Date(`${month}-01T00:00:00Z`);
  const to = new Date(from);
  to.setUTCMonth(to.getUTCMonth() + 1);
  return { from, to };
}
const monthOf = (d) => d.toISOString().slice(0, 7);
const shift = (month, by) => {
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + by);
  return monthOf(d);
};

// THE SITE'S OWN COSTS: what nobody is charged for and isn't an account's own use, one row each, by the unit's kind.
// Sign-ins count here whoever they were (the unit learns the account from X's answer; an account is never charged for
// signing in); the rest are units with no account. Anything else with no account: "other" (none should exist).
// CREDITS GIVEN (`npm run credit`: a gift, "credit" rows) are one of them, their full amount in the month given: what a
// gift pays for still counts as Charged (and its markup as Margin), so without this a gift read as profit.
const PLATFORM = {
  signin: "Sign-ins",
  estimate: "Front-page estimates",
  waitlist: "Waitlist follow checks",
  invite: "Invites",
  dm: "“You’re in” DMs",
  script: "One-off scripts",
  credit: "Credits given",
  other: "Other site costs",
};
const platformKind = (c) => (c.kind === "signin" ? "signin" : c.accountId ? null : PLATFORM[c.kind] ? c.kind : "other");

// Margin as a whole percent of what was charged; null with nothing charged.
const pctOf = (margin, charged) => (charged > 0 ? Math.round((margin / charged) * 100) : null);

// The rows, pure: `costs` [{ accountId|null, kind, usd }], `charges` [{ accountId, micros (what was charged,
// positive), costMicros (the X cost it was charged on) }], `deposits` [{ accountId, micros (net paid in) }], `credits`
// [{ accountId, micros (given) }], `balances`
// Map id → micros (at the month's end), `accounts` Map id → { username, name, image } (a missing one was deleted),
// `ownerId` (today's: only labels the row). Every money figure in micro-dollars.
// → { platform: THE SITE'S OWN COSTS, one row per kind, the biggest first ({ key, label, cost, margin: −cost, … });
// rows: the accounts' (most deposited first), each { id, person, kind: "owner"|"account"|"deleted", deposited,
// balance, charged, margin, marginPct, cost }; total: the columns over both }.
function pnlRows({ costs, charges, deposits = [], credits = [], balances = new Map(), accounts, ownerId }) {
  const by = new Map();
  const byKind = new Map(); // the site's own costs, by kind
  const row = (id) => by.get(id) || by.set(id, { id, cost: 0, charged: 0, chargedCost: 0, deposited: 0 }).get(id);
  for (const g of credits) byKind.set("credit", (byKind.get("credit") || 0) + g.micros);
  for (const c of costs) {
    const key = platformKind(c);
    if (key) byKind.set(key, (byKind.get(key) || 0) + micros(c.usd));
    else row(c.accountId).cost += micros(c.usd);
  }
  for (const c of charges) {
    const r = row(c.accountId);
    r.charged += c.micros;
    r.chargedCost += c.costMicros;
  }
  for (const d of deposits) row(d.accountId).deposited += d.micros;
  const platform = [...byKind]
    .filter(([, cost]) => cost)
    .map(([key, cost]) => ({ key, label: PLATFORM[key], kind: "platform", cost, deposited: 0, balance: 0, charged: 0, margin: -cost, marginPct: null }))
    .sort((x, y) => y.cost - x.cost);
  const accountRows = [...by.values()]
    .filter((r) => r.cost || r.charged || r.deposited)
    .map(({ chargedCost, ...r }) => {
      const a = accounts.get(r.id);
      const margin = r.charged - chargedCost;
      return {
        ...r,
        kind: r.id === ownerId ? "owner" : a ? "account" : "deleted",
        person: a ? { id: r.id, username: a.username, profile: { name: a.name, image: a.image } } : null,
        balance: balances.get(r.id) || 0,
        margin,
        marginPct: pctOf(margin, r.charged),
      };
    });
  const rows = accountRows.sort((x, y) => y.deposited - x.deposited || y.charged - x.charged || y.cost - x.cost);
  const all = [...rows, ...platform];
  const sum = (k) => all.reduce((t, r) => t + r[k], 0);
  const total = { deposited: sum("deposited"), balance: sum("balance"), charged: sum("charged"), margin: sum("margin") };
  // THE SITE'S OWN COSTS added up: the one row Admin draws folded, opening to `platform`.
  const siteCost = platform.reduce((t, r) => t + r.cost, 0);
  const site = platform.length ? { label: "Site costs", cost: siteCost, deposited: 0, balance: 0, charged: 0, margin: -siteCost, marginPct: null } : null;
  return { platform, site, rows, total: { ...total, marginPct: pctOf(total.margin, total.charged) } };
}

// The month's P&L from the database. `month` "YYYY-MM" (anything else: this month).
async function pnlFor(month, { ownerId, now = new Date() } = {}) {
  const m = MONTH.test(month || "") ? month : monthOf(now);
  const { from, to } = monthRange(m);
  const thisMonth = monthOf(now);
  const [costs, charges, deposits, credits] = await Promise.all([
    UsageEntry.aggregate([{ $match: { startedAt: { $gte: from, $lt: to }, estUsd: { $gt: 0 } } }, { $group: { _id: { a: "$accountId", k: "$kind" }, usd: { $sum: "$estUsd" } } }]),
    BalanceEntry.aggregate([{ $match: { kind: "run", at: { $gte: from, $lt: to } } }, { $group: { _id: "$accountId", micros: { $sum: "$micros" }, costUsd: { $sum: "$costUsd" } } }]),
    BalanceEntry.aggregate([{ $match: { kind: { $in: DEPOSIT_KINDS }, at: { $gte: from, $lt: to } } }, { $group: { _id: "$accountId", micros: { $sum: "$micros" } } }]),
    // A credit to the owner pays for nothing (the owner is never charged), so it isn't a cost; today's owner, since a
    // credit row doesn't say who owned the app when it was given.
    BalanceEntry.aggregate([{ $match: { kind: "credit", at: { $gte: from, $lt: to }, ...(ownerId && { accountId: { $ne: ownerId } }) } }, { $group: { _id: "$accountId", micros: { $sum: "$micros" } } }]),
  ]);
  const ids = [...new Set([...costs.map((c) => c._id.a), ...charges.map((c) => c._id), ...deposits.map((d) => d._id)].filter(Boolean))];
  const found = await Account.find({ _id: { $in: ids } }, "username name image balanceMicros").lean();
  const accounts = new Map(found.map((a) => [a._id, a]));
  const balances =
    m === thisMonth
      ? new Map(found.map((a) => [a._id, a.balanceMicros || 0]))
      : new Map(
          (
            await BalanceEntry.aggregate([
              { $match: { accountId: { $in: ids }, at: { $lt: to }, balanceAfter: { $ne: null } } },
              { $sort: { at: -1 } },
              { $group: { _id: "$accountId", micros: { $first: "$balanceAfter" } } },
            ])
          ).map((b) => [b._id, b.micros])
        );
  const pnl = pnlRows({
    costs: costs.map((c) => ({ accountId: c._id.a || null, kind: c._id.k, usd: c.usd })),
    charges: charges.map((c) => ({ accountId: c._id, micros: -c.micros, costMicros: micros(c.costUsd) })), // a run's row takes money off: negative
    deposits: deposits.map((d) => ({ accountId: d._id, micros: d.micros })),
    credits: credits.map((g) => ({ accountId: g._id, micros: g.micros })),
    balances,
    accounts,
    ownerId,
  });
  return {
    month: m,
    name: from.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }),
    prev: shift(m, -1),
    next: m < thisMonth ? shift(m, 1) : null,
    rows: pnl.rows,
    platform: pnl.platform, // THE SITE'S OWN COSTS, one row per kind: what "Site costs" opens to
    site: pnl.site, // their sum, the one row drawn (folded) right under the Total
    total: pnl.total,
  };
}

module.exports = { pnlRows, pnlFor, monthRange };
