// Billing (docs/BILLING.md): the money rules, and that every spend door charges.
//   npm run verify            the pure rules + source checks (no network, no database)
//   npm run verify:db         also the atomic moves against the real database (Atlas), on throwaway accounts it
//                             creates and deletes itself ("verify-billing-…"): exactly once under concurrent charges,
//                             the self-healing row, the owner exempt, the one-unit overshoot, Mongoose not dropping
//                             a field the schema lacks. Touches nothing else.
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const DB = process.argv.includes("--db");
// Billing on with a placeholder Stripe key, set outright: a real key in .env is never used by a check (Stripe is a
// stub below), and the auto-refill paths need billing "payable".
process.env.METERED_BILLING_ENABLED = "true";
process.env.STRIPE_SECRET_KEY = "sk_test_verify_only";
process.env.AUTO_REFILL_THRESHOLD_CENTS = "500";
process.env.AUTO_REFILL_USD = "25";
process.env.TOPUP_AMOUNTS_USD = "10,25,50";
// Without --db, config gets placeholders (services/billing.js reads it): nothing here talks to Mongo, X or Stripe.
if (!DB) {
  for (const [k, v] of Object.entries({ MONGO_URI: "mongodb://127.0.0.1:1/unused", X_CLIENT_ID: "verify", X_CLIENT_SECRET: "verify", SESSION_SECRET: "verify", TOKEN_KEY: crypto.randomBytes(32).toString("base64") })) {
    process.env[k] = process.env[k] || v;
  }
}
const { multiplierFor, unitCost, capped, priceMicros, markupWithin, monthMarkup, monthOf, toMicros, toUsd, createBalance } = require("../services/balance");
const billing = require("../services/billing");

// A Stripe stand-in: records every call; anything not stubbed throws (so a path that shouldn't reach Stripe can't).
function stubStripe(handlers = {}) {
  const calls = [];
  const api = (name) =>
    new Proxy({}, { get: (_, method) => async (...args) => {
      calls.push({ name: `${name}.${String(method)}`, args });
      const h = handlers[`${name}.${String(method)}`];
      if (!h) throw new Error(`unexpected Stripe call ${name}.${String(method)}`);
      return h(...args);
    } });
  return { calls, client: { customers: api("customers"), checkout: { sessions: api("checkout.sessions") }, invoices: api("invoices"), invoiceItems: api("invoiceItems"), invoicePayments: api("invoicePayments"), charges: api("charges"), paymentIntents: api("paymentIntents"), setupIntents: api("setupIntents") } };
}
const autoRefill = require("../services/autoRefill");

const root = path.join(__dirname, "..");
let n = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  n++;
};

// ── auto-refill: the words, the banner ──
ok(autoRefill.failureCause("insufficient_funds") === "the card was declined for insufficient funds" && autoRefill.failureCause("expired_card") === "the card has expired", "Stripe's decline codes in plain words");
ok(autoRefill.failureCause("weird", "Something odd happened.") === "Something odd happened" && autoRefill.failureCause() === "the charge didn't go through", "…else Stripe's own message, else a plain default");
{
  const banner = (a) => autoRefill.notice({ _id: "someone", features: { inbox: { on: true } }, ...a });
  ok(banner({ balanceMicros: 0 }).text.includes("syncing is paused"), "banner: out of balance → paused");
  ok(banner({ balanceMicros: 3.2e6 }).text.includes("down to $3.20") && banner({ balanceMicros: 3.2e6 }).link.includes("auto-refill"), "banner: low with refill off → top up or turn on auto-refill");
  ok(banner({ balanceMicros: 3.2e6, autoRefill: { enabled: true, paymentMethodId: "pm" } }) === null, "…but not when refill is armed (it's handling it)");
  ok(banner({ balanceMicros: 30e6 }) === null && autoRefill.notice({ _id: "someone", balanceMicros: 0 }) === null, "nothing above the line, nor before a module is picked (that page asks itself)");
  const failed = banner({ balanceMicros: 0, autoRefill: { enabled: false, disabledReason: "failed", lastError: "the card has expired", cardBrand: "visa", cardLast4: "4242" } });
  ok(failed.text.includes("Visa ···4242 twice (the card has expired)") && failed.text.includes("Syncing is paused"), `banner: switched off, with the card and the cause: "${failed.text}"`);
}

// ── the modules' prices (services/modulePrices.js: Settings and the front page split a month the same way) ──
{
  const { modulePrices } = require("../services/modulePrices");
  const parts = { conversations: 100, tiers: 40, yourLikes: 10, likers: 1, follows: 20, liveReplies: 5, self: 0.3 };
  const all = modulePrices(parts, { inbox: true, people: true, likes: true, follows: true, liveReplies: true, liking: true });
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  const rowsOn = (r, keys) => keys.reduce((s, k) => s + r[k], 0);
  ok(near(all.inbox, 100.3) && all.people === 50 && all.liking === 0, "both on: the conversations (and your profile) are the Inbox's, People adds its tiers and your likes, Liking reads nothing more");
  ok(near(all.total, 176.3) && near(rowsOn(all, ["inbox", "people", "likes", "follows", "liveReplies"]), all.total), `everything on: the rows add up to the total (${all.total})`);
  // Additive: People's row is only its own part; People alone still counts the Inbox's reading (inboxCounted).
  const peopleOnly = modulePrices(parts, { people: true });
  ok(peopleOnly.people === 50 && near(peopleOnly.inbox, 100.3) && peopleOnly.inboxCounted && near(peopleOnly.total, 150.3), "People alone: its own 50 plus the Inbox's reading it needs, counted on the Inbox's row");
  const inboxOnly = modulePrices(parts, { inbox: true });
  ok(near(inboxOnly.inbox, inboxOnly.total), "the Inbox alone: its row IS the total (your profile rides on it, never a row of its own)");
  const none = modulePrices(parts, {});
  ok(near(none.inbox, 100.3) && near(none.likes, 1.3) && none.total === 0, "nothing on: each row's quote carries your profile (whichever is turned on first brings it)");
  const inboxLiking = modulePrices(parts, { inbox: true, liking: true });
  ok(inboxLiking.liking === 10 && inboxLiking.people === 50 && near(inboxLiking.total, 110.3), "Inbox + Liking: Liking reads your likes; People quoted at what it would add");
  ok(near(modulePrices(parts, { likes: true }).total, 1.3) && modulePrices(parts, { liveReplies: true }).total === 0, "Likes alone: its own part + your profile; an add-on without its module: nothing");
  // WHAT YOU SEND: in the total whenever the Inbox or People is on (they carry the ♥ and Reply), never otherwise.
  const withSends = { ...parts, sends: 22.5 };
  const inboxSends = modulePrices(withSends, { inbox: true });
  ok(inboxSends.sendsCounted && near(inboxSends.total, 100.3 + 22.5) && near(rowsOn(inboxSends, ["inbox", "sends"]), inboxSends.total), "the Inbox on: what you send is in the total, and the rows still add up");
  ok(modulePrices(withSends, { people: true }).sendsCounted && !modulePrices(withSends, { likes: true, follows: true }).sendsCounted && near(modulePrices(withSends, { likes: true }).total, 1.3), "People counts it too; Likes or Follows alone can't send, so it isn't counted");
}

// ── the price of a unit ──
ok(priceMicros(0.0123, 1.5) === 18450, "X's $0.0123 × 1.5 = 18,450 µ$");
ok(priceMicros(0.0001, 1.5) === 150, "a hundredth of a cent still costs something (whole cents would round it to 0)");
ok(priceMicros(0, 1.5) === 0 && priceMicros(-1, 1.5) === 0 && priceMicros("nope", 1.5) === 0, "zero, negative, NaN → no charge");
ok(priceMicros(0.3, 1) === 300000, "at cost: $0.30 → 300,000 µ$");
ok(toMicros(25) === 25000000 && toUsd(25000000) === 25, "$25 = 25,000,000 µ$ and back");

ok(multiplierFor(null, 1.5) === 1.5 && multiplierFor({}, 1.5) === 1.5, "no override → the platform's");
ok(multiplierFor({ marginMultiplier: 1 }, 1.5) === 1 && multiplierFor({ marginMultiplier: 1.2 }, 1.5) === 1.2, "an account's own: a discount, from X's cost up to the platform's rate");
ok(multiplierFor({ marginMultiplier: 0.5 }, 1.5) === 1.5 && multiplierFor({ marginMultiplier: 2.5 }, 1.5) === 1.5 && multiplierFor({ marginMultiplier: 15 }, 1.5) === 1.5, "a stored value below X's cost or ABOVE the platform's rate is ignored");
assert.throws(() => createBalance({ multiplier: 0.9 }), /multiplier/, "the platform can't sell below cost");
n++;
// The markup's monthly cap (MARKUP_CAP_USD): the markup on a charge is what's left of the month's cap, never more.
ok(markupWithin(1000000, 1.5, 0) === 500000, "no cap: 50% of $1.00 is $0.50");
ok(markupWithin(1000000, 1.5, toMicros(50), toMicros(49.8)) === 200000, "$0.20 left of a $50 cap: the markup is $0.20, not $0.50");
ok(markupWithin(1000000, 1.5, toMicros(50), toMicros(50)) === 0 && markupWithin(1000000, 1.5, toMicros(50), toMicros(60)) === 0, "the cap reached (or passed): X's cost alone");
ok(markupWithin(1000000, 1, toMicros(50), 0) === 0, "an account at cost (×1) has no markup to cap");
// Past the threshold the rate drops (MARKUP_AFTER_CAP_PCT, 10%), a crossing charge split at it.
ok(markupWithin(1000000, 1.5, toMicros(50), toMicros(49.8), 0.1) === 260000, "$0.20 left: the first $0.40 of cost at 50% ($0.20), the other $0.60 at 10% ($0.06)");
ok(markupWithin(1000000, 1.5, toMicros(50), toMicros(50), 0.1) === 100000, "past the threshold: 10% of the cost");
ok(markupWithin(1000000, 1.5, toMicros(50), toMicros(50), 0.9) === 100000 * 5, "the lower rate never exceeds the full one");
ok(monthMarkup(500, 1.5, 50, 0.1) === 90 && monthMarkup(3000, 1.5, 50, 0.1) === 340 && monthMarkup(60, 1.5, 50, 0.1) === 30, "a month: 50% up to $50 (the first $100 of X's price), then 10%");
ok(/^\d{4}-\d{2}$/.test(monthOf()) && monthOf(new Date(Date.UTC(2026, 11, 31, 23, 59))) === "2026-12", "the month a markup counts in is the UTC month");

// ── what a unit cost X ──
// Every unit: exactly its amount at X's prices (no calibration: a charge checks against X's price list).
const est = unitCost({ estUsd: 1 });
ok(est.basis === "prices" && est.usd === 1, "a unit → its amount at X's prices, exactly");
ok(unitCost({ realNote: "exact", realUsd: 0.78, estUsd: 1.21 }).usd === 1.21, "an old row's per-unit real cost is ignored: one rule for every unit");
ok(unitCost({ estUsd: -0.01 }).usd === 0 && unitCost({}).usd === 0, "never negative, nothing → 0");
// A unit quoted before it ran (a list read) is never charged on more X cost than its quote; under it, its cost.
ok(capped({ usd: 1.2, basis: "prices" }, 1).usd === 1 && capped({ usd: 1.2, basis: "prices" }, 1).basis === "quote", "over the quote: the quote");
ok(capped({ usd: 0.4, basis: "prices" }, 1).basis === "prices" && capped({ usd: 0.4, basis: "prices" }, undefined).usd === 0.4, "under it, or no quote: the cost");
ok(capped({ usd: 9, basis: "prices" }, 2, "balance").basis === "balance" && capped({ usd: 9, basis: "prices" }, 2, "balance").usd === 2, "over what the balance covered: that, and it says so");

// ── THE CEILING (a run can't charge past the balance): the lower of the quote and what the balance covers,
// at the rate the unit is charged; and a client at its ceiling sends no read ──
{
  const { ceilingOf } = require("../services/usage");
  const room = { full: 10, bulk: 13 };
  ok(ceilingOf(null, null) === null, "nothing to cap: no ceiling");
  ok(ceilingOf(null, room).usd === 10 && ceilingOf(null, room).of === "balance", "the balance covers $10 of X's cost at the full rate: the ceiling");
  ok(ceilingOf(null, room, true).usd === 13, "a history read, charged at the onboarding rate, may read more on the same balance");
  ok(ceilingOf(4, room).usd === 4 && ceilingOf(4, room).of === "quote" && ceilingOf(40, room).of === "balance", "a quote under the balance caps it; one over doesn't");
  ok(ceilingOf(4, null).of === "quote", "a quote alone (billing off, the owner) still caps");
}
// …and lib/x.js sends no read once a unit is at its ceiling (fetch stubbed: nothing may reach it).
async function ceilingClientCheck() {
  const { createClient, ReadCapReached } = require("../lib/x");
  const realFetch = global.fetch;
  let sent = 0;
  global.fetch = async () => (sent++, { ok: true, headers: new Map(), json: async () => ({ data: [] }) });
  let stopped = null;
  try {
    const xc = createClient({ token: "t", meter: { record: async () => {}, atCeiling: () => true }, readCap: 100, userCap: 100, contextCap: 100 });
    await xc.postsByIds(["1"]).catch((e) => (stopped = e));
  } finally {
    global.fetch = realFetch;
  }
  ok(stopped instanceof ReadCapReached && stopped.ceiling && sent === 0, "a client at its ceiling sends nothing: a clean stop (ReadCapReached), not an error");
}

// ── the gate, on a loaded account ──
{
  const on = createBalance({ enabled: true, ownerId: "owner", multiplier: 1.5, floorMicros: 0 });
  const off = createBalance({ enabled: false, ownerId: "owner", multiplier: 1.5, floorMicros: 0 });
  ok(on.paused({ _id: "a", balanceMicros: 0 }) && on.paused({ _id: "a" }) && on.paused({ _id: "a", balanceMicros: -5 }), "at or below the floor (or never funded) → paused");
  ok(!on.paused({ _id: "a", balanceMicros: 1 }), "one micro-dollar above the floor → may start");
  ok(!on.paused({ _id: "owner", balanceMicros: -1e9 }) && !off.paused({ _id: "a", balanceMicros: -1e9 }) && !on.paused(null), "never the owner, never with billing off, never without an account");
  ok(on.affords({ _id: "a", balanceMicros: 15000000 }, 10) && !on.affords({ _id: "a", balanceMicros: 14999999 }, 10), "affords: a $10 job at ×1.5 needs $15 in the balance");
  ok(on.affords({ _id: "a", balanceMicros: 10000000, marginMultiplier: 1 }, 10), "…at the account's own multiplier");
  ok(on.affords({ _id: "owner", balanceMicros: 0 }, 1e6) && off.affords({ _id: "a", balanceMicros: 0 }, 1e6), "the owner, and anyone with billing off, can afford anything");
  ok(!on.affords({ _id: "a", balanceMicros: 0 }, 0) && on.affords({ _id: "a", balanceMicros: 1 }, 0), "the gate shut: not even a free choice (resume's From now at $0); one micro above the floor: yes");
  ok(on.priceFor({ _id: "a" }, 2) === 3 && on.priceFor({ _id: "a", marginMultiplier: 1 }, 2) === 2 && on.priceFor({ _id: "owner" }, 2) === 2, "a quote is X's cost × the account's multiplier (the owner's is X's cost)");
  ok(off.priceFor({ _id: "a" }, 2) === 2, "with billing off, a quote is X's cost (nobody pays)");
}

// ── the gate is inside metered(), before the ledger row and the first read: every spend door passes through it ──
{
  const src = fs.readFileSync(path.join(root, "services/usage.js"), "utf8");
  const body = src.slice(src.indexOf("async function metered("));
  ok(body.indexOf("billing.outOfRunway(") > 0 && body.indexOf("billing.outOfRunway(") < body.indexOf("UsageEntry.create("), "metered() checks the gate before it opens the unit");
  ok(body.indexOf("billing.settle()") < body.indexOf("billing.outOfRunway("), "…after charging what closed, so it reads a current balance");
  // The doors priced before they start (the first pull, a Follows refresh) also check the balance covers the price.
  // The web app's source: web.js and the routes it mounts (a route moved to routes/*.js stays checked).
  const web = ["web.js", ...fs.readdirSync(path.join(root, "routes")).filter((f) => f.endsWith(".js")).map((f) => `routes/${f}`)].map((f) => fs.readFileSync(path.join(root, f), "utf8")).join("\n");
  const door = (route, check, spend) => {
    const at = web.indexOf(route);
    const spendAt = web.indexOf(spend, at);
    ok(at > 0 && spendAt > at && web.slice(at, spendAt).includes(check), `${route} checks ${check} before ${spend}`);
  };
  door('app.post("/history"', "affordable", "runSync(");
  ok(/const affordable = billing\.affords\(/.test(web), "a history option is affordable only by billing.affords");
  // The request's account is what the Stripe doors are handed (ensureCustomer reuses its stripeCustomerId; the
  // multiplier, balance and refill state drive quotes and banners): its projection must carry them, or every top-up
  // mints a new Stripe customer (it did, until slice 5).
  const projection = require("../models/Account").REQUEST_FIELDS;
  ok(["balanceMicros", "marginMultiplier", "stripeCustomerId", "autoRefill", "history"].every((f) => projection.split(" ").includes(f)), "the request's account loads the billing fields");
}

// ── every spend door charges: each metered unit with an account passes the billing meterSettings hands it ──
for (const rel of ["services/sync.js", "services/extras.js"]) {
  const src = fs.readFileSync(path.join(root, rel), "utf8");
  const calls = [...src.matchAll(/metered\(\{([^}]*)\}/g)];
  ok(calls.length > 0, `${rel} has a metered unit`);
  for (const c of calls) ok(/\baccountId\b/.test(c[1]) && /\bbilling\b/.test(c[1]), `${rel}: metered({${c[1].trim()}}) passes billing`);
}
// Every metered() call in the app is one of those, or one the platform absorbs by design: the sign-in (no account
// yet), the front page's cost estimate (services/estimator.js, a visitor's ~3 cents, capped per visitor and per day) and
// the waitlist's sender (services/waitlistDms.js: the site's own account DMing the people let in, "dm", and reading who
// follows it, "waitlist"), and Admin's Invite ("invite": one profile read). And every kind a call passes is one UsageEntry accepts: an unknown kind fails the unit's
// first write, so the press it meters fails every time ("repost" was once missing).
const KINDS = new Set(require("../models/UsageEntry").schema.path("kind").enumValues);
for (const file of ["web.js", "app.js", ...fs.readdirSync(path.join(root, "routes")).map((f) => `routes/${f}`), ...fs.readdirSync(path.join(root, "services")).map((f) => `services/${f}`), ...fs.readdirSync(path.join(root, "scripts")).map((f) => `scripts/${f}`)]) {
  if (!file.endsWith(".js") || file === "services/usage.js" || file === "scripts/verify-billing.js") continue;
  for (const c of fs.readFileSync(path.join(root, file), "utf8").matchAll(/metered\(\{([^}]*)\}/g)) {
    ok(/\bbilling\b/.test(c[1]) || /kind: "(signin|estimate|dm|waitlist|invite)"/.test(c[1]), `${file}: metered({${c[1].trim()}}) charges nobody`);
    const kind = (c[1].match(/\bkind: "([^"]+)"/) || [])[1];
    if (kind) ok(KINDS.has(kind), `${file}: metered kind "${kind}" is one UsageEntry accepts`);
  }
}
// The callers hand runSync (and every button that asks X: they take syncSettings) the whole meterSettings (billing
// included), never a hand-picked part.
const accountsSrc = fs.readFileSync(path.join(root, "services/accounts.js"), "utf8");
ok(/meterSettings = \(\) => \(\{[^)]*billing:/.test(accountsSrc), "meterSettings carries billing");
ok(/\.\.\.meterSettings\(\)/.test(accountsSrc), "syncSettings carries the whole meterSettings()");

// ── how money reads (lib/hbs.js) ──
{
  const { money, dollars } = require("../lib/hbs").helpers;
  ok(dollars(12.5) === "$12.50" && dollars(-0.02) === "−$0.02" && dollars(-0.001) === "$0.00", "a balance below zero reads −$0.02, never $-0.02");
  const opts = { hash: {} }; // what Handlebars passes as the last argument
  ok(money(25e6, opts) === "$25.00" && money(420000, opts) === "$0.42" && money(42000, opts) === "$0.042" && money(4200, opts) === "$0.0042", "money: cents for dollars, more digits for a fraction of a cent");
  ok(money(25e6, true) === "+$25.00" && money(-4200, true) === "−$0.0042" && money(-4200, opts) === "−$0.0042" && money(0, opts) === "$0", "signed: + for credits, − for charges (− always)");
}

// ── money in: amounts, and what the webhook ignores ──
ok(JSON.stringify(billing.amountsFor(false, { depositUsd: 20, topupAmountsUsd: [10, 25, 50] })) === "[20,25,50]", "before the first payment: the deposit, and the top-ups above it");
ok(JSON.stringify(billing.amountsFor(true, { depositUsd: 20, topupAmountsUsd: [50, 10, 25] })) === "[10,25,50]", "after: the top-up amounts");
// One payment covers a "how far back?" choice: what's missing, up to the next $5, never under the deposit for a first.
const dep = { depositUsd: 20 };
ok(billing.topupFor(0, 66, false, dep) === 70, "Everything (~$66) from $0: one $70 top-up, not $50 + more");
ok(billing.topupFor(0, 4.95, false, dep) === 20, "a cheap choice from $0: still the deposit");
ok(billing.topupFor(12, 16.5, true, dep) === 5, "already paid: just what's missing, up to $5");
ok(billing.topupFor(0, 65, false, dep) === 65, "an exact multiple of $5 isn't rounded past itself");
ok(billing.topupFor(20, 16.5, false, dep) === null, "covered: nothing to add");

// ── THE P&L (Admin → P&L, services/pnl.js pnlRows): per account what it deposited, its balance, what it was charged
// and the margin on the runs charged (the owner's own use as of each run left out); the platform a margin of −its
// cost; totals, margin % and net add up. ──
{
  const { pnlRows } = require("../services/pnl");
  const accounts = new Map([["owner", { username: "site" }], ["c1", { username: "maya" }], ["c2", { username: "dev" }]]);
  const p = pnlRows({
    // c1 was the owner for part of the month: $41 of its $46.22 was never charged, and isn't a loss.
    // The site's own: an estimate and a DM (no account), and a sign-in that learned its account (still the site's).
    costs: [{ accountId: "owner", kind: "sync", usd: 1 }, { accountId: "c1", kind: "sync", usd: 46.22 }, { accountId: null, kind: "estimate", usd: 0.03 }, { accountId: null, kind: "dm", usd: 0.015 }, { accountId: "c2", kind: "signin", usd: 0.01 }, { accountId: "gone", kind: "sync", usd: 0.5 }],
    charges: [{ accountId: "c1", micros: 7830000, costMicros: 5220000 }, { accountId: "gone", micros: 750000, costMicros: 500000 }],
    deposits: [{ accountId: "c1", micros: 20000000 }, { accountId: "c2", micros: 50000000 }],
    credits: [{ accountId: "c2", micros: 5000000 }], // a $5 gift: a site cost, never a deposit
    balances: new Map([["c1", 12170000], ["c2", 50000000]]),
    accounts,
    ownerId: "owner",
  });
  const by = new Map(p.rows.map((r) => [r.id, r]));
  const c1 = by.get("c1");
  ok(c1.margin === 2610000 && c1.marginPct === 33 && c1.deposited === 20000000 && c1.balance === 12170000, "an account that was the owner for part of the month: $2.61 margin on its charged runs (33%), not a $38 loss");
  ok(p.rows[0].id === "c2" && by.get("c2").charged === 0 && by.get("c2").marginPct === null, "most deposited first; an account that only paid in is a row, with no margin %");
  ok(by.get("owner").kind === "owner" && by.get("owner").margin === 0 && by.get("owner").marginPct === null, "the owner's own runs: no margin");
  ok(!by.has(null) && by.get("gone").kind === "deleted" && by.get("gone").margin === 250000, "no account: no account row; a deleted account still counted");
  ok(p.platform.map((r) => `${r.key}:${r.label}:${r.margin}`).join() === "credit:Credits given:-5000000,estimate:Front-page estimates:-30000,dm:“You’re in” DMs:-15000,signin:Sign-ins:-10000", "the site's own costs: one row per kind, the biggest first, each a margin of −its cost, a sign-in counted whoever it was, a gift its full amount");
  ok(by.get("c2").cost === 0 && by.get("c2").deposited === 50000000, "a sign-in isn't the account's own cost; a gift isn't a deposit");
  ok(p.site.label === "Site costs" && p.site.margin === -5055000 && p.site.cost === 5055000, "Site costs: the one folded row, their sum");
  ok(p.total.deposited === 70000000 && p.total.balance === 62170000 && p.total.charged === 8580000 && p.total.margin === -2195000 && p.total.marginPct === -26, "the totals are the rows' sums, the site's own costs (the gift too) included");}

async function stripeChecks() {
  const { client, calls } = stubStripe();
  billing._setStripeForTests(client);
  // Another app's objects (a plain "topup" kind, no kind at all) are never acted on, and never even looked up.
  for (const kind of ["topup", undefined, "refill-setup", "constructor", "__proto__"]) {
    await billing.handleEvent({ type: "invoice.paid", data: { object: { id: "in_x", status: "paid", subtotal: 2500, metadata: { kind, accountId: "a" } } } });
    await billing.handleEvent({ type: "checkout.session.completed", data: { object: { mode: "payment", payment_status: "paid", invoice: "in_x", metadata: { kind, accountId: "a" } } } });
  }
  ok(calls.length === 0, "the webhook ignores every kind but the app's own, without a Stripe call");
  ok((await billing.settleTopupInvoice({ id: "in_open", status: "open", subtotal: 2500, metadata: { kind: billing.TOPUP, accountId: "a" } })) === null, "an unpaid invoice credits nothing");
  ok((await billing.handleTopUp({ payment_status: "unpaid", invoice: "in_x", metadata: { kind: billing.TOPUP, accountId: "a" } })) === null && calls.length === 0, "an unpaid Checkout (a delayed method) waits for async_payment_succeeded");
  ok((await billing.sessionFor("not-a-session-id", "a")) === null && calls.length === 0, "the return page only looks up a real-looking session id");
}

stripeChecks()
  .then(ceilingClientCheck)
  .then(() => {
    if (!DB) return console.log(`verify-billing: ${n} checks pass (add --db for the database checks)`);
    return dbChecks();
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });

async function dbChecks() {
  const mongoose = require("mongoose");
  const config = require("../config");
  const { connect } = require("../lib/db");
  const Account = require("../models/Account");
  const UsageEntry = require("../models/UsageEntry");
  const BalanceEntry = require("../models/BalanceEntry");
  const SyncState = require("../models/SyncState");
  const Person = require("../models/Person");
  const LiveEvent = require("../models/LiveEvent");
  const Like = require("../models/Like");
  const Follow = require("../models/Follow");

  const tag = `verify-billing-${crypto.randomBytes(4).toString("hex")}`;
  const ids = { a: `${tag}-a`, partner: `${tag}-partner`, owner: `${tag}-owner`, refill: `${tag}-refill`, hold: `${tag}-hold` };
  const bal = createBalance({ enabled: true, ownerId: ids.owner, multiplier: 1.5, floorMicros: 0 });
  const acctIds = Object.values(ids);
  const unit = (accountId, fields) => UsageEntry.create({ accountId, kind: "sync", label: "verify", startedAt: new Date(), status: "ok", chargeDue: true, ...fields });
  const balanceOf = async (id) => (await Account.findById(id, "balanceMicros").lean()).balanceMicros;
  // A charge as services/balance.js makes it: X's cost in micro-dollars, plus its markup (uncapped here).
  const charged = (usd, m) => priceMicros(usd, 1) + markupWithin(priceMicros(usd, 1), m, 0);

  await connect(config);
  await BalanceEntry.init(); // the unique (kind, ref) index exists before anything races it
  try {
    await Account.create([
      { _id: ids.a, username: `${tag}a`, balanceMicros: 1000 },
      { _id: ids.partner, username: `${tag}p`, balanceMicros: 0, marginMultiplier: 1 },
      { _id: ids.owner, username: `${tag}o` },
    ]);

    // Every unit is charged its amount at X's prices × the multiplier, exactly (no calibration).
    // Exactly once: five concurrent charges of one unit (two processes sweeping, a retry) move the balance once.
    const u1 = await unit(ids.a, { estUsd: 0.0123 });
    const p1 = charged(0.0123, 1.5);
    await Promise.all([1, 2, 3, 4, 5].map(() => bal.chargeUnit(u1._id)));
    ok((await balanceOf(ids.a)) === 1000 - p1, "five concurrent charges of one unit move the balance once");
    const rows = await BalanceEntry.find({ accountId: ids.a }).lean();
    ok(rows.length === 1 && rows[0].micros === -p1 && rows[0].balanceAfter === 1000 - p1 && rows[0].basis === "prices" && rows[0].costUsd === 0.0123 && rows[0].multiplier === 1.5, "one ledger row: X's prices exactly, the price, the balance after, the basis and the multiplier");
    ok(!(await UsageEntry.findById(u1._id).lean()).chargeDue, "the unit is no longer due");

    // Overshoot by one unit, then the gate: the unit that crossed zero finished; the next one may not start.
    ok((await balanceOf(ids.a)) < 0 && (await bal.outOfRunway(ids.a)), "the crossing unit finished below zero; the next is out of runway");

    // A crash between the money and its row: the retry writes the row and moves nothing.
    const u2 = await unit(ids.a, { estUsd: 0.001 });
    const p2 = charged(0.001, 1.5);
    await Account.updateOne({ _id: ids.a }, { $inc: { balanceMicros: -p2 }, $push: { appliedRefs: `run:${u2._id}` } });
    const before = await balanceOf(ids.a);
    await bal.chargeUnit(u2._id);
    const healed = await BalanceEntry.findOne({ kind: "run", ref: String(u2._id) }).lean();
    ok((await balanceOf(ids.a)) === before && healed && healed.micros === -p2 && healed.balanceAfter === null, "a row lost to a crash is written later, without charging again");

    // An old row's per-unit real cost (before the balance clock) is ignored: its amount at X's prices, like any unit.
    const u3 = await unit(ids.a, { realNote: "exact", realUsd: 0.5, estUsd: 0.01 });
    await bal.chargeUnit(u3._id);
    const r3 = await BalanceEntry.findOne({ kind: "run", ref: String(u3._id) }).lean();
    ok(r3.basis === "prices" && r3.micros === -charged(0.01, 1.5), "an old row with a per-unit real cost is charged at X's prices all the same");

    // A bulk read (onboarding's history, a whole list) has its own 10% markup, outside the month's threshold count.
    {
      const hb = createBalance({ enabled: true, ownerId: ids.owner, multiplier: 1.5, markupCapMicros: toMicros(50), markupAfterRate: 0.1, bulkRate: 0.1, floorMicros: -toMicros(1000) });
      const before = (await Account.findById(ids.a, "markupMicros").lean()).markupMicros;
      const uh = await unit(ids.a, { estUsd: 0.02, bulkRead: true });
      await hb.chargeUnit(uh._id);
      const rh = await BalanceEntry.findOne({ kind: "run", ref: String(uh._id) }).lean();
      const c = priceMicros(rh.costUsd, 1);
      ok(rh.multiplier === 1.1 && toMicros(rh.markupUsd) === markupWithin(c, 1.1, 0) && rh.micros === -(c + toMicros(rh.markupUsd)), "a bulk read is charged X's price + 10%");
      ok((await Account.findById(ids.a, "markupMicros").lean()).markupMicros === (before || 0), "…and its fee doesn't count toward the month's threshold");
      ok(hb.priceFor({ _id: "x" }, 10, { bulk: true }) === 11 && hb.priceFor({ _id: "x", marginMultiplier: 1 }, 10, { bulk: true }) === 10, "quotes: a bulk read at +10%, never above an account's own rate");
      // Quoted before it ran: never charged on more X cost than the quote (a list read may run past its priced count).
      const uq = await unit(ids.a, { estUsd: 5, bulkRead: true, ceilingUsd: 0.5 });
      await hb.chargeUnit(uq._id);
      const rq = await BalanceEntry.findOne({ kind: "run", ref: String(uq._id) }).lean();
      ok(rq.basis === "quote" && rq.costUsd === 0.5 && rq.micros === -priceMicros(0.5, 1.1), "a quoted bulk read is charged its quote at most");
    }

    // A design partner at cost; the owner never.
    const u4 = await unit(ids.partner, { estUsd: 0.02 });
    await bal.chargeUnit(u4._id);
    ok((await balanceOf(ids.partner)) === -charged(0.02, 1), "an account's own multiplier (×1) is what it's charged");
    const u5 = await unit(ids.owner, { estUsd: 5 });
    await bal.chargeUnit(u5._id);
    ok(!(await Account.findById(ids.owner, "balanceMicros").lean()).balanceMicros && !(await BalanceEntry.exists({ accountId: ids.owner })), "the owner is never charged");
    ok(!(await UsageEntry.findById(u5._id).lean()).chargeDue && !(await bal.outOfRunway(ids.owner)), "…its units are cleared, and it's never out of runway");

    // A running unit isn't charged (its close does that); nor is a free one recorded.
    const u6 = await unit(ids.a, { status: "open", estUsd: 1 });
    ok((await bal.chargeUnit(u6._id)) === null && (await UsageEntry.findById(u6._id).lean()).chargeDue, "an open unit waits for its close");
    const u7 = await unit(ids.a, { estUsd: 0 });
    ok((await bal.chargeUnit(u7._id)) === null && !(await BalanceEntry.exists({ ref: String(u7._id) })), "a unit X charged nothing for writes no row");

    // The monthly threshold, under concurrent charges: an account $0.0001 short of a $1 threshold gets five units at once.
    // All five are charged; only $0.0001 of markup more is at the full 50%, the rest at 10% (never the full rate twice).
    {
      const capped = createBalance({ enabled: true, ownerId: ids.owner, multiplier: 1.5, markupCapMicros: toMicros(1), markupAfterRate: 0.1, floorMicros: -toMicros(1000) });
      const capId = `${tag}-cap`;
      acctIds.push(capId);
      await Account.create({ _id: capId, username: `${tag}c`, balanceMicros: toMicros(10), markupMonth: monthOf(), markupMicros: toMicros(1) - 100 });
      const units = await Promise.all([1, 2, 3, 4, 5].map(() => unit(capId, { estUsd: 0.01 })));
      await Promise.all(units.map((u) => capped.chargeUnit(u._id)));
      // A unit whose write kept missing stays due; the sweep charges it (here, just these units: never settle(), which
      // would sweep real accounts' units in this database).
      for (const u of units) await capped.chargeUnit(u._id);
      const after = await Account.findById(capId, "balanceMicros markupMicros").lean();
      const charges = await BalanceEntry.find({ accountId: capId, kind: "run" }).lean();
      const costs = charges.reduce((s, r) => s + priceMicros(r.costUsd, 1), 0);
      const markups = charges.reduce((s, r) => s + toMicros(r.markupUsd), 0);
      // Exactly: $0.0001 at 50% (the threshold's last 200 µ$ of cost), the rest of the cost at 10% (each charge rounds
      // its own, so within a micro-dollar a charge).
      const expected = 100 + 0.1 * (costs - 200);
      ok(charges.length === 5 && Math.abs(markups - expected) <= 5, `five concurrent charges across the threshold: all charged, 50% only on its last $0.0001, 10% after (${markups} µ$ of markup, ~${Math.round(expected)} expected)`);
      ok(after.balanceMicros === toMicros(10) - costs - markups && after.markupMicros === toMicros(1) - 100 + markups, "…the balance and the month's markup moved by exactly what the rows say");
      await Account.updateOne({ _id: capId }, { $set: { markupMonth: "1999-01", markupMicros: toMicros(1) } });
      const fresh = await unit(capId, { estUsd: 0.01 });
      await capped.chargeUnit(fresh._id);
      const r = await BalanceEntry.findOne({ kind: "run", ref: String(fresh._id) }).lean();
      ok((await Account.findById(capId, "markupMonth markupMicros").lean()).markupMicros === markupWithin(priceMicros(r.costUsd, 1), 1.5, 0), "a new month starts the count again, at the full rate");
    }

    // Credits: keyed by invoice, once; funded again, the account may start.
    const topups = await Promise.all([1, 2, 3].map(() => bal.credit(ids.a, toMicros(25), { kind: "topup", ref: `in_${tag}` })));
    ok(topups.filter(Boolean).length === 1 && (await BalanceEntry.countDocuments({ kind: "topup", ref: `in_${tag}` })) === 1, "a top-up delivered three times credits once");
    // A top-up can unpause an account, which decides its live subscriptions: it flags them for the worker in the same
    // write (an account that topped up after signing in at $0 once waited for the hourly ensure to go Live).
    ok((await Account.findById(ids.a, "live").lean()).live?.due === true, "a top-up flags the account's live subscriptions to be re-ensured");
    // FOR GOOD, not just while its key is in the account's last 500: every charge pushes a key, so an active
    // account pushed a top-up's out within days, and reopening its Stripe return link credited it again. Pushed out
    // here as 500 later charges would, then replayed: nothing moves; a unit whose key went the same way is still settled.
    await Account.updateOne({ _id: ids.a }, { $set: { appliedRefs: [] } });
    const beforeReplay = await balanceOf(ids.a);
    ok((await bal.credit(ids.a, toMicros(25), { kind: "topup", ref: `in_${tag}` })) === null && (await balanceOf(ids.a)) === beforeReplay, "a top-up replayed after its key left the account's list credits nothing (its row is the guard)");
    await UsageEntry.updateOne({ _id: u1._id }, { $set: { chargeDue: true } });
    ok((await bal.chargeUnit(u1._id)) === null && (await balanceOf(ids.a)) === beforeReplay && !(await UsageEntry.findById(u1._id).lean()).chargeDue, "a unit charged before its key left the list isn't charged again, and is settled");
    // AN INVOICE OLDER THAN THE ACCOUNT credits nothing (deleted, made again with the same X id, old sessions replayed);
    // one made after it does. Through THE credit path, Stripe stubbed (the receipt lookup fails quietly).
    {
      const { client } = stubStripe();
      billing._setStripeForTests(client);
      const born = (await Account.findById(ids.a, "createdAt").lean()).createdAt.getTime();
      const inv = (id, createdMs) => ({ id, status: "paid", subtotal: 2500, created: Math.floor(createdMs / 1000), payments: { data: [] }, metadata: { kind: billing.TOPUP, accountId: ids.a } });
      const b0 = await balanceOf(ids.a);
      ok((await billing.settleTopupInvoice(inv(`in_${tag}_old`, born - 864e5))) === null && (await balanceOf(ids.a)) === b0, "an invoice made a day before the account existed credits nothing");
      ok((await billing.settleTopupInvoice({ ...inv(`in_${tag}_notime`, born), created: undefined })) === null, "an invoice with no time credits nothing");
      ok(!!(await billing.settleTopupInvoice(inv(`in_${tag}_new`, Date.now()))) && (await balanceOf(ids.a)) === b0 + toMicros(25), "an invoice made after it credits");
    }
    // A REFUND, by hand (scripts/credit.js with a negative amount; never automatic): taken back once, a "refund" row, and
    // not counted as spending on the Usage page's chart.
    {
      const b0 = await balanceOf(ids.a);
      const day = new Date().toISOString().slice(0, 10);
      const spentBefore = (await billing.statementDays(ids.a, { since: day }))[0];
      const twice = await Promise.all([1, 2].map(() => billing.takeBack(ids.a, toMicros(25), { ref: `hand:${ids.a}:${day}:25`, label: "$25.00 refunded" })));
      const row = await BalanceEntry.findOne({ accountId: ids.a, kind: "refund" }).lean();
      ok(twice.filter(Boolean).length === 1 && (await balanceOf(ids.a)) === b0 - toMicros(25) && row && row.micros === -toMicros(25), "a refund pasted twice takes $25 back once, as a refund row");
      ok((await billing.takeBack(ids.a, -5)) === null && (await billing.takeBack(ids.a, 0)) === null, "a refund of nothing (or a negative) moves nothing");
      const spentAfter = (await billing.statementDays(ids.a, { since: day }))[0];
      ok(spentAfter.charged === spentBefore.charged && spentAfter.added === spentBefore.added - toMicros(25), "the chart's spending leaves the refund out; money in nets it");
    }
    ok(!(await bal.outOfRunway(ids.a)), "funded again, the account may start a unit");
    ok(!(await createBalance({ enabled: false, multiplier: 1.5 }).outOfRunway(ids.partner)), "with billing off, nobody is gated (even below zero)");

    // THE GATE at the one place every unit starts (metered). Seeded on one side: `a` is funded, `partner` is below zero.
    // (Its sweep is switched off: settle() charges every due unit in the database, and this instance's owner is a
    // throwaway, so a real unit of the real owner's closing meanwhile would be charged.)
    const { metered } = require("../services/usage");
    const gated = { ...bal, settle: async () => {} };
    let ran = 0;
    await metered({ accountId: ids.a, kind: "sync", label: "verify", billing: gated }, async () => ran++);
    ok(ran === 1, "a funded account's unit runs");
    const unitsBefore = await UsageEntry.countDocuments({ accountId: ids.partner });
    await assert.rejects(metered({ accountId: ids.partner, kind: "sync", label: "verify", billing: gated }, async () => ran++), (e) => e.code === "OUT_OF_BALANCE");
    ok(ran === 1 && (await UsageEntry.countDocuments({ accountId: ids.partner })) === unitsBefore, "an account out of runway starts nothing: no read, no ledger row");

    // THE CEILING through metered: a unit that reads past what the balance covers is charged exactly that,
    // to zero, never below; and a history read gets the onboarding rate's (higher) ceiling.
    {
      const ceilId = `${tag}-ceil`;
      acctIds.push(ceilId);
      await Account.create({ _id: ceilId, username: `${tag}x`, balanceMicros: toMicros(3) });
      const seen = {};
      await metered({ accountId: ceilId, kind: "sync", label: "verify", billing: gated }, async (meter) => {
        seen.start = meter.ceilingUsd;
        await meter.recordCounted("timeline", "post", 1000, 1000); // $5 at X's prices, past the $2 that $3 covers at ×1.5
        seen.at = meter.atCeiling();
      });
      const e = await UsageEntry.findOne({ accountId: ceilId }).lean();
      const row = await BalanceEntry.findOne({ accountId: ceilId, kind: "run" }).lean();
      ok(Math.abs(seen.start - 2) < 1e-9 && e.ceilingOf === "balance", "a unit starts under the balance's ceiling: $3 at ×1.5 covers $2 of X's prices");
      ok(seen.at === true, "…and knows when it's reached it (lib/x.js then reads no more)");
      ok(row && row.basis === "balance" && row.costUsd === 2 && (await balanceOf(ceilId)) === 0, "read past it, it's charged what the balance held: to zero, never below");
      await assert.rejects(metered({ accountId: ceilId, kind: "sync", label: "verify", billing: gated }, async () => {}), (err) => err.code === "OUT_OF_BALANCE");
      n++;
      await Account.updateOne({ _id: ceilId }, { $set: { balanceMicros: toMicros(3) } });
      const onboarding = { ...createBalance({ enabled: true, ownerId: ids.owner, multiplier: 1.5, bulkRate: 0.15, floorMicros: 0 }), settle: async () => {} };
      await metered({ accountId: ceilId, kind: "sync", label: "verify", billing: onboarding }, async (meter) => {
        await meter.bulkRead("Your history");
        seen.bulk = meter.ceilingUsd;
      });
      const eb = await UsageEntry.findOne({ accountId: ceilId, bulkRead: true }).lean();
      ok(Math.abs(seen.bulk - 3 / 1.15) < 1e-9 && Math.abs(eb.ceilingUsd - 3 / 1.15) < 1e-9, "a history read is re-ceiled at the onboarding rate: $3 covers $2.61 of X's prices at +15%");
    }
    // THE HOLDS: twenty units started AT ONCE on a $3 balance (×1.5: $2 of X's prices), each asking again and again for
    // pages of 100 posts ($0.50 each), take $2 between them, never more, and the balance ends at zero, not below. Before
    // the holds each saw the whole $3 and all twenty read to it (−$57).
    {
      const holdId = ids.hold;
      await Account.create({ _id: holdId, username: `${tag}h`, balanceMicros: toMicros(3) });
      const held = createBalance({ enabled: true, ownerId: ids.owner, multiplier: 1.5, floorMicros: 0 });
      const got = [];
      await Promise.all(
        Array.from({ length: 20 }, () =>
          metered({ accountId: holdId, kind: "sync", label: "verify", billing: held }, async (meter) => {
            for (let i = 0; i < 10; i++) {
              const k = await meter.fit(100, 0.005);
              if (k < 5) break; // X's smallest page: the clean stop lib/x.js makes
              got.push(k);
              await meter.recordCounted("timeline", "post", k, k);
            }
          })
        )
      );
      const read = got.reduce((s, k) => s + k, 0);
      const left = await balanceOf(holdId);
      const doc = await Account.findById(holdId, "holds").lean();
      ok(read <= 400 && read >= 395 && left >= 0 && left < toMicros(0.05), `twenty units at once share one $3 balance: ${read} posts read of the 400 it covers, ${left} µ$ left (never below zero)`);
      ok(!(doc.holds || []).length, "…and every unit's hold is gone once it's charged");
      // A request is cut to what's left, not sent whole: $0.015 left (= $0.01 of X's prices) asks for 1 profile of 1,000.
      await Account.updateOne({ _id: holdId }, { $set: { balanceMicros: toMicros(0.015) } });
      let asked = null;
      await metered({ accountId: holdId, kind: "follows", label: "verify", billing: held }, async (meter) => {
        asked = await meter.fit(1000, 0.01);
      });
      ok(asked === 1, `a page is sized to the balance left: 1,000 profiles asked, ${asked} sent`);
      // Exactly the balance: $0.15 at ×1.5 is 20 posts (in floating point 150000.00000000003 µ$, which a ceiling once
      // refused, so nothing was read).
      await Account.updateOne({ _id: holdId }, { $set: { balanceMicros: toMicros(0.15) } });
      await metered({ accountId: holdId, kind: "sync", label: "verify", billing: held }, async (meter) => {
        asked = await meter.fit(100, 0.005);
      });
      ok(asked === 20, `exactly what the balance covers is allowed: $0.15 asks for 20 posts (${asked})`);
    }
    // THE LIVE DAY CAP: follow events ($0.01 each) delivered to one account count toward its UTC day; the one that
    // reaches config.x.liveDayMaxUsd flags its subscriptions, and ensureSubs then wants none until the day turns.
    {
      const live = require("../services/live");
      const LivePending = require("../models/LivePending");
      const capId = ids.hold;
      const max = config.x.liveDayMaxUsd;
      const ev = { what: "live-follows", cls: "followEvent", resource: "follow" };
      const now = new Date();
      // Yesterday's count is not today's: the first event today starts the day again.
      await Account.updateOne({ _id: capId }, { $set: { live: { day: "2000-01-01", dayUsd: 999 } } });
      await live.notePending(capId, ev, `${tag}-ev-0`, now);
      const fresh = await Account.findById(capId, "live").lean();
      ok(fresh.live.day === now.toISOString().slice(0, 10) && Math.abs(fresh.live.dayUsd - 0.01) < 1e-9, "a new UTC day's first event starts its count");
      await Account.updateOne({ _id: capId }, { $set: { "live.dayUsd": max - 0.015 } });
      await live.notePending(capId, ev, `${tag}-ev-1`, now);
      const before = await Account.findById(capId, "live").lean();
      ok(!live.capReached(before, now) && !before.live.due, `half a cent under the $${max} day cap: Live stays`);
      await live.notePending(capId, ev, `${tag}-ev-last`, now);
      await live.notePending(capId, ev, `${tag}-ev-last`, now); // the same event delivered twice counts once
      const after = await Account.findById(capId, "live").lean();
      ok(live.capReached(after, now) && after.live.due === true && Math.abs(after.live.dayUsd - (max + 0.005)) < 1e-9, "the event that reaches it flags the subscriptions to go");
      ok(!live.capReached(after, new Date(now.getTime() + 86400000)), "…and the next UTC day it's lifted");
      await LivePending.deleteMany({ accountId: capId });
    }
    // …and through the sync's door: a clean skip, the lock released. (Only the gated side reaches runSync here: a
    // funded run would read from X.)
    const { runSync } = require("../services/sync");
    await Account.updateOne({ _id: ids.partner }, { $set: { "features.inbox": { on: true, since: new Date() } } });
    const r = await runSync({ accountId: ids.partner, getToken: async () => "unused", readCap: 10, contextCap: 10, userCap: 10, billing: gated });
    ok(/out of balance/.test(r.skipped || ""), `runSync skips: "${r.skipped}"`);
    ok(!(await SyncState.findById(ids.partner).lean()).runningUntil, "…and releases its lock");

    // ── Stripe (stubbed): the Checkout it asks for, and the one credit path reached from every door ──
    const custId = `cus_${tag}`;
    const invoice = { id: `in_${tag}_paid`, status: "paid", subtotal: 2500, amount_paid: 2500, created: Math.floor(Date.now() / 1000), metadata: { app: "xtoolio", kind: billing.TOPUP, accountId: ids.partner, source: "manual" } };
    const { client, calls } = stubStripe({
      "customers.create": async () => ({ id: custId }),
      "customers.retrieve": async (id) => ({ id }),
      "checkout.sessions.create": async () => ({ url: "https://checkout.stripe.com/c/pay/verify" }),
      "invoices.retrieve": async () => invoice,
      "invoicePayments.list": async () => ({ data: [{ status: "paid", payment: { charge: "ch_verify" } }] }),
      "charges.retrieve": async () => ({ receipt_url: "https://pay.stripe.com/receipts/verify" }),
    });
    billing._setStripeForTests(client);
    const partnerDoc = await Account.findById(ids.partner).lean();
    const url = await billing.createTopUpSession(partnerDoc, 25, { back: "/" });
    const p = calls.find((c) => c.name === "checkout.sessions.create").args[0];
    ok(url.startsWith("https://checkout.stripe.com/") && p.mode === "payment" && p.customer === custId && p.line_items[0].price_data.unit_amount === 2500 && !p.allow_promotion_codes, "Checkout: payment mode, $25 inline, the account's customer, no promo codes");
    ok([p.metadata, p.payment_intent_data.metadata, p.invoice_creation.invoice_data.metadata].every((m) => m.kind === "xtoolio-topup" && m.app === "xtoolio" && m.accountId === ids.partner), "xtoolio's own kind + the account on the session, the PaymentIntent and the invoice");
    ok(p.invoice_creation.enabled && p.success_url.startsWith(`${config.appOrigin}/billing/done?session_id={CHECKOUT_SESSION_ID}`) && p.cancel_url.includes("cancelled=1"), "an invoice is made; it returns to /billing/done with the session id");
    ok((await Account.findById(ids.partner).lean()).stripeCustomerId === custId, "the customer is saved on the account");
    await billing.createTopUpSession({ ...partnerDoc, stripeCustomerId: custId }, 10);
    ok(calls.filter((c) => c.name === "customers.create").length === 1 && calls.some((c) => c.name === "customers.retrieve"), "…and reused next time, after Stripe confirms it still exists");

    const partnerBefore = await balanceOf(ids.partner);
    ok(!(await billing.hasPaid(ids.partner)), "never paid: its first top-up is the deposit");
    await Promise.all([
      billing.handleEvent({ type: "invoice.paid", data: { object: invoice } }),
      billing.handleEvent({ type: "checkout.session.completed", data: { object: { mode: "payment", payment_status: "paid", invoice: invoice.id, metadata: invoice.metadata } } }),
      billing.handleTopUp({ payment_status: "paid", invoice, metadata: invoice.metadata }), // the return page
    ]);
    ok((await balanceOf(ids.partner)) === partnerBefore + 25000000, "the webhook twice and the return page at once: $25 credited once");
    const row = await BalanceEntry.findOne({ kind: "topup", ref: invoice.id }).lean();
    ok(row && row.receiptUrl === "https://pay.stripe.com/receipts/verify" && row.micros === 25000000, "its row carries the Charge's receipt");
    ok(await billing.hasPaid(ids.partner), "…and the account has now paid");

    // ── the statement a paying account sees (the Usage page): its movements, a page at a time, never X's cost ──
    const st = await billing.statement(ids.partner);
    const run = st.rows.find((r) => r.kind === "run");
    const top = st.rows.find((r) => r.kind === "topup");
    ok(st.rows[0].kind === "topup" && top.receiptUrl && top.micros === 25e6 && st.next === null, "newest first: the top-up, with its receipt; one page");
    ok(run && run.micros === -priceMicros(0.02, 1) && run.reads && !("costUsd" in run) && !("multiplier" in run) && !("basis" in run), "a run: its charge and what it read, and nothing that says what X charged");
    const page1 = await billing.statement(ids.partner, { limit: 1 });
    const page2 = await billing.statement(ids.partner, { limit: 1, before: page1.next });
    ok(page1.rows.length === 1 && page1.next && page2.rows.length === 1 && String(page2.rows[0]._id) !== String(page1.rows[0]._id) && page2.rows[0].kind === "run", "paged: the next page starts after the last row shown");
    const todayKey = new Date().toISOString().slice(0, 10);
    const today = (await billing.statementDays(ids.partner, { timeZone: "UTC", since: todayKey })).find((d) => d.day === todayKey);
    ok(today && today.added === 25e6 && today.charged === priceMicros(0.02, 1), "by day: charged and added");

    // A CHARGEBACK: the disputed $25 comes off the balance once (Stripe redelivers), auto-refill goes off, and a dispute
    // on a customer that isn't ours moves nothing.
    {
      await Account.updateOne({ _id: ids.partner }, { $set: { "autoRefill.enabled": true } });
      const d = stubStripe({ "charges.retrieve": async (id) => ({ id, customer: id === "ch_ours" ? custId : "cus_someone_else" }) });
      billing._setStripeForTests(d.client);
      const at = await balanceOf(ids.partner);
      const dispute = { id: `dp_${tag}`, charge: "ch_ours", amount: 2500 };
      await Promise.all([1, 2].map(() => billing.handleEvent({ type: "charge.dispute.created", data: { object: dispute } })));
      await billing.handleEvent({ type: "charge.dispute.created", data: { object: { id: `dp_${tag}_other`, charge: "ch_theirs", amount: 2500 } } });
      const acct = await Account.findById(ids.partner, "balanceMicros autoRefill").lean();
      ok(acct.balanceMicros === at - 25e6 && acct.autoRefill.enabled === false && acct.autoRefill.disabledReason === "dispute", "a dispute takes its $25 back once (delivered twice), and auto-refill goes off");
      ok((await BalanceEntry.countDocuments({ accountId: ids.partner, ref: `dispute:${dispute.id}` })) === 1, "…one row for it; another customer's dispute touched nothing");
      await Account.updateOne({ _id: ids.partner }, { $inc: { balanceMicros: 25e6 } }); // the checks below start where they did
      billing._setStripeForTests(client);
    }

    // ── auto-refill (stubbed Stripe): one refill per dip, the failure policy, the card door, both wake-ups ──
    let payResult = "paid";
    const refillStub = stubStripe({
      "invoices.create": async (p) => ({ id: `in_${tag}_r${Date.now()}${Math.random().toString(36).slice(2, 6)}`, metadata: p.metadata, amount: 0 }),
      "invoiceItems.create": async (p) => (refillStub.lastAmount = p.amount, {}),
      "invoices.finalizeInvoice": async (id) => ({ id }),
      "invoices.pay": async (id) => {
        if (payResult !== "paid") throw Object.assign(new Error("Your card has insufficient funds."), { code: "card_declined", decline_code: payResult });
        const created = refillStub.calls.filter((c) => c.name === "invoices.create").pop().args[0];
        return { id, status: "paid", subtotal: refillStub.lastAmount, amount_paid: refillStub.lastAmount, created: Math.floor(Date.now() / 1000), metadata: created.metadata };
      },
      "invoices.voidInvoice": async (id) => ({ id, status: "void" }),
      "invoicePayments.list": async () => ({ data: [] }),
      "customers.update": async () => ({}),
    });
    billing._setStripeForTests(refillStub.client);
    const armedAt = (balanceMicros, extra = {}) => Account.updateOne({ _id: ids.refill }, { $set: { balanceMicros, autoRefill: { enabled: true, amountUsd: 25, paymentMethodId: "pm_verify", cardBrand: "visa", cardLast4: "4242", failCount: 0, lastError: "", ...extra } } });
    const refillDoc = () => Account.findById(ids.refill, "balanceMicros autoRefill").lean();
    const creates = () => refillStub.calls.filter((c) => c.name === "invoices.create").length;
    await Account.create({ _id: ids.refill, username: `${tag}r`, stripeCustomerId: `cus_${tag}` });

    await armedAt(4e6);
    const outcomes = await Promise.all([1, 2, 3, 4, 5].map(() => autoRefill.watch(ids.refill)));
    let d = await refillDoc();
    ok(creates() === 1 && outcomes.filter((o) => o.action === "refilled").length === 1, "five watchers at once under the line: one refill charged");
    ok(d.balanceMicros === 29e6 && (await BalanceEntry.countDocuments({ accountId: ids.refill, kind: "auto-refill", micros: 25e6 })) === 1, "…$25 credited through the one credit path, as an auto-refill");
    ok(!d.autoRefill.inFlightAt && d.autoRefill.lastRefillAt && d.autoRefill.failCount === 0, "…and the claim released");
    const inv = refillStub.calls.find((c) => c.name === "invoices.create").args[0];
    ok(inv.metadata.kind === "xtoolio-topup" && inv.metadata.source === "auto" && inv.default_payment_method === "pm_verify" && refillStub.calls.find((c) => c.name === "invoices.pay").args[1].off_session === true, "an off-session invoice on the saved card, tagged as ours");
    ok((await autoRefill.watch(ids.refill)).action === "none", "above the line: nothing");

    // Declines: counted, said plainly, the invoice voided; the cooldown holds; the second in a row switches it off.
    payResult = "insufficient_funds";
    await armedAt(1e6);
    const first = await autoRefill.watch(ids.refill);
    d = await refillDoc();
    ok(first.action === "failed" && d.autoRefill.failCount === 1 && d.autoRefill.enabled && d.autoRefill.lastError === "the card was declined for insufficient funds", "a decline: counted once, the cause in plain words, still on");
    ok(refillStub.calls.some((c) => c.name === "invoices.voidInvoice") && d.balanceMicros === 1e6, "…its invoice voided, nothing credited");
    ok((await autoRefill.watch(ids.refill)).action === "none", "…and no second try inside the hour");
    await Account.updateOne({ _id: ids.refill }, { $set: { "autoRefill.lastAttemptAt": new Date(Date.now() - 2 * 3600e3) } });
    ok((await autoRefill.watch(ids.refill)).action === "switched off", "the second failure in a row switches it off");
    d = await refillDoc();
    ok(!d.autoRefill.enabled && d.autoRefill.disabledReason === "failed" && autoRefill.notice({ _id: ids.refill, ...d, features: { inbox: { on: true } } }).text.includes("Auto-refill is off"), "…and the banner says so");

    // A new card (the setup Checkout completing) resets it and, asked to, switches it back on.
    await Account.updateOne({ _id: ids.refill }, { $set: { balanceMicros: 30e6 } }); // above the line: the post-card check finds nothing to do
    const label = await billing.handleCardSetup({ metadata: { kind: billing.CARD, accountId: ids.refill, enable: "1" }, customer: `cus_${tag}`, setup_intent: { payment_method: { id: "pm_new", card: { brand: "mastercard", last4: "5555" } } } });
    d = await refillDoc();
    ok(label === "Mastercard ···5555" && d.autoRefill.enabled && d.autoRefill.paymentMethodId === "pm_new" && d.autoRefill.failCount === 0 && !d.autoRefill.lastError && !d.autoRefill.disabledReason, "a new card: saved, failures cleared, back on");
    ok(refillStub.calls.some((c) => c.name === "customers.update" && c.args[1].invoice_settings.default_payment_method === "pm_new"), "…and made the customer's default");

    // Both wake-ups, through a balance instance wired to the watcher as the app's is.
    payResult = "paid";
    const wired = createBalance({ enabled: true, ownerId: ids.owner, multiplier: 1.5, floorMicros: 0, watch: autoRefill.watch });
    // The refill runs detached (a spend site never waits on Stripe): poll for it, generously (each refill is ~8 round
    // trips to Atlas, and a 4 s poll failed once, cause unconfirmed).
    const settled = async (cond) => {
      for (let i = 0; i < 75 && !(await cond()); i++) await new Promise((r) => setTimeout(r, 200));
      return cond();
    };
    await armedAt(6e6, { lastAttemptAt: null });
    // $2 at X's prices × 1.5 is $3: $6 → $3, under the $5 line.
    const p8 = charged(2, 1.5);
    const u8 = await unit(ids.refill, { estUsd: 2 });
    await wired.chargeUnit(u8._id);
    // Settled = the money landed AND the refill released its claim: the release (lastAttemptAt, the cooldown) is its last
    // write, and one landing after the next check re-arms the account made that check's refill wait out the cooldown
    // (it once failed 1 run in 4).
    ok(await settled(async () => { const d = await refillDoc(); return d.balanceMicros === 6e6 - p8 + 25e6 && !d.autoRefill.inFlightAt; }), "a charge that crosses the line wakes the refill");
    await armedAt(-1e5, { lastAttemptAt: null });
    await assert.rejects(metered({ accountId: ids.refill, kind: "sync", label: "verify", billing: { ...wired, settle: async () => {} } }, async () => {}), (e) => e.code === "OUT_OF_BALANCE");
    ok(await settled(async () => (await refillDoc()).balanceMicros === -1e5 + 25e6), "a paused account the gate refuses wakes it too (nothing else would)");

    // THE MONTHLY LIMIT (services/autoRefill.js): refills this month, from the ledger, plus the next one past the
    // account's limit → no charge, the claim let go uncounted, the month noted, the banner says it; no limit refills.
    await BalanceEntry.create({ accountId: ids.refill, micros: 200e6, kind: "auto-refill", label: "verify: earlier refills this month" });
    const invoicesBefore = creates();
    await armedAt(1e6, { lastAttemptAt: null, monthlyLimitUsd: 250 });
    const stopped = await autoRefill.watch(ids.refill);
    d = await refillDoc();
    ok(stopped.reason === "monthly limit" && creates() === invoicesBefore &&d.balanceMicros === 1e6 && !d.autoRefill.inFlightAt && !d.autoRefill.lastAttemptAt && d.autoRefill.failCount === 0, "past the month's $250 limit: nothing charged, no attempt counted, the claim let go");
    ok(autoRefill.notice({ _id: ids.refill, ...d, features: { inbox: { on: true } } }).text.includes("$250 limit"), "…and the banner says the limit stopped it");
    await Account.updateOne({ _id: ids.refill }, { $set: { "autoRefill.monthlyLimitUsd": 0 } });
    ok((await autoRefill.watch(ids.refill)).action === "refilled" && creates() === invoicesBefore + 1, "no limit: it refills");
    await armedAt(1e6, { lastAttemptAt: null, monthlyLimitUsd: 1000 });
    ok((await autoRefill.watch(ids.refill)).action === "refilled", "under a higher limit: it refills");

    // A charge that takes an account across THE GATE flags its live subscriptions for removal at once (services/live.js
    // re-ensures within seconds), as a top-up flags them back.
    await Account.updateOne({ _id: ids.refill }, { $set: { balanceMicros: 1e6, "autoRefill.enabled": false }, $unset: { "live.due": 1 } });
    await wired.chargeUnit((await unit(ids.refill, { estUsd: 2 }))._id);
    ok((await Account.findById(ids.refill, "live.due balanceMicros").lean()).live.due === true, "a charge crossing $0 stops Live at once");

    // Not money, but this run's throwaway accounts are the only safe place to check it on the real database: the
    // header's own counts reach open pages (models/Person.js store → LiveEvent "me") when they MOVE, and only then.
    {
      const self = (followers, following) => ({ id: ids.a, username: `${tag}a`, name: "verify", public_metrics: { followers_count: followers, following_count: following, tweet_count: 1 } });
      const notes = () => LiveEvent.find({ accountId: ids.a, type: "me" }).sort({ _id: 1 }).lean();
      await Person.store([self(10, 20)], new Date());
      let rows = await notes();
      ok(rows.length === 1 && rows[0].data.followers === 10 && rows[0].data.following === 20, "a profile read that moves your counts tells your open pages");
      await Person.store([self(10, 20)], new Date());
      ok((await notes()).length === 1, "…the same counts again: nothing");
      await Person.store([self(11, 20)], new Date());
      rows = await notes();
      ok(rows.length === 2 && rows[1].data.followers === 11 && (await Account.findById(ids.a, "followers").lean()).followers === 11, "…a new follower: the account and its pages both");

      // Between reads, the counts move only when a follow pair FLIPS (models/Follow.js fromEvent), by one. Once,
      // 16 unfollows in 6 s, and each live event's own copy of the profile set the header in arrival order (740, 738,
      // 735, 738, 734, 740 … 725, then 741).
      const counts = async () => Account.findById(ids.a, "followers following").lean();
      await Person.store([self(11, 999)], new Date(), { counts: false });
      ok((await counts()).following === 20 && (await notes()).length === 2, "a live event's copy of your profile doesn't set your counts");
      const them = (k) => `${tag}them${k}`;
      for (let k = 0; k < 3; k++) await Follow.create({ _id: `${ids.a}>${them(k)}`, followerId: ids.a, followeeId: them(k), follows: true, checkedAt: new Date(Date.now() - 60e3) });
      const pressAt = new Date();
      ok((await Follow.fromEvent(ids.a, them(0), false, pressAt)) === true && (await counts()).following === 19, "your unfollow flips the pair: following − 1");
      ok((await Follow.fromEvent(ids.a, them(0), false, new Date(pressAt - 500))) === false && (await counts()).following === 19, "…X's echo of it, from just before: nothing");
      ok((await Follow.fromEvent(ids.a, them(0), false, new Date(pressAt.getTime() + 500))) === false && (await counts()).following === 19, "…or just after: the pair is already that way, nothing");
      // The echo first, then the press: still one.
      await Follow.fromEvent(ids.a, them(1), false, new Date());
      await Follow.fromEvent(ids.a, them(1), false, new Date(Date.now() + 5));
      ok((await counts()).following === 18, "echo first, press second: one unfollow, one less");
      // Several at once, in any order: exactly that many.
      await Promise.all([them(2), them(3), them(4)].map((p) => Follow.fromEvent(ids.a, p, false, new Date())));
      ok((await counts()).following === 15, "three unfollows at once: three less (one known pair, two unknown)");
      // Their "me" notes can be written in another order than their moves; a page takes only a newer version (v).
      const all = await notes();
      const newest = all.reduce((m, r) => (r.data.v > m.data.v ? r : m));
      ok(newest.data.following === 15 && newest.data.followers === 11 && newest.data.v === (await Account.findById(ids.a, "countsV").lean()).countsV, "…and the newest version the pages hear is where it landed");
      ok(new Set(all.map((r) => r.data.v)).size === all.length, "…every note its own version");
      await Follow.fromEvent(them(5), ids.a, true, new Date());
      ok((await counts()).followers === 12, "someone follows you live: followers + 1");
    }
    // The Likes tab's count leaves out a like you watched arrive on another page (Like.viewedAt: POST /posts/viewed's
    // write, then its recount), and only that one.
    {
      const { refreshUnseen } = require("../services/unseenCount");
      const { NEWS } = require("../services/likes");
      await Account.updateOne({ _id: ids.a }, { $set: { likesSeenAt: new Date(Date.now() - 3600e3) } });
      const at = new Date();
      await Like.create([
        { accountId: ids.a, authorId: ids.a, postId: "9001", likerId: "liker-1", likedAt: at, seenAt: at },
        { accountId: ids.a, authorId: ids.a, postId: "9002", likerId: "liker-2", likedAt: at, seenAt: at },
      ]);
      ok((await refreshUnseen(ids.a, "likes")) === 2, "two live likes since you looked: 2");
      await Like.updateMany({ accountId: ids.a, authorId: ids.a, postId: "9001", likerId: { $ne: ids.a }, ...NEWS }, { $set: { viewedAt: new Date() } });
      ok((await refreshUnseen(ids.a, "likes")) === 1, "…one watched arriving elsewhere: 1");
    }
  } finally {
    await Promise.all([
      Account.deleteMany({ _id: { $in: acctIds } }),
      UsageEntry.deleteMany({ accountId: { $in: acctIds } }),
      BalanceEntry.deleteMany({ accountId: { $in: acctIds } }),
      SyncState.deleteMany({ _id: { $in: acctIds } }),
      Person.deleteMany({ _id: { $in: acctIds } }),
      LiveEvent.deleteMany({ accountId: { $in: acctIds } }),
      Like.deleteMany({ accountId: { $in: acctIds } }),
      Follow.deleteMany({ $or: [{ followerId: { $in: acctIds } }, { followeeId: { $in: acctIds } }] }),
    ]);
    await mongoose.disconnect();
  }
  console.log(`verify-billing: ${n} checks pass, database included`);
}
