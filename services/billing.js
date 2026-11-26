// Billing, wired to config (docs/BILLING.md): the app's one balance instance (services/balance.js holds the rules),
// and the money in from Stripe. services/accounts.js meterSettings hands the instance to every metered unit, which
// charges through it on close.
//
// STRIPE is the site's own account. Its objects carry their own kinds ("xtoolio-topup", "xtoolio-refill-setup" for the
// auto-refill card) and metadata.app = "xtoolio", and everything here ignores any other kind, so the app is safe on a
// Stripe account that other products share (Stripe sends every event to every endpoint).
//
// ONE CREDIT PATH: every top-up ends as a PAID invoice with metadata.kind "xtoolio-topup" (Checkout makes one:
// invoice_creation), and settleTopupInvoice credits it, exactly once by its invoice id (balance.credit with a ref).
// Three doors reach it: the return page (/billing/done, the person is waiting), `invoice.paid` and
// `checkout.session.completed` (the webhook, the belt). Whichever lands first credits; the rest find it applied.
"use strict";

const Stripe = require("stripe");
const config = require("../config");
const Account = require("../models/Account");
const BalanceEntry = require("../models/BalanceEntry");
const UsageEntry = require("../models/UsageEntry");
const { createBalance, toMicros } = require("./balance");
const { describeReads } = require("./usage");
const { page, dayExpr } = require("../lib/feedCursor");

const balance = createBalance({
  enabled: config.billing.enabled,
  ownerId: config.x.ownerId,
  multiplier: config.billing.multiplier,
  markupCapMicros: toMicros(config.billing.markupCapUsd),
  markupAfterRate: config.billing.markupAfterCapPct / 100,
  bulkRate: config.billing.bulkMarkupPct / 100,
  floorMicros: config.billing.floorCents * 10000,
  watch: (accountId) => require("./autoRefill").watch(accountId),
});

const TOPUP = "xtoolio-topup";
const CARD = "xtoolio-refill-setup";
// THE read of a Stripe object's kind (null when it carries no metadata).
const kindOf = (metadata) => (metadata ? metadata.kind : null);
const meta = (accountId, source) => ({ app: "xtoolio", kind: TOPUP, accountId: String(accountId), source });

let _stripe = null;
function getStripe() {
  if (!_stripe) {
    if (!config.stripe.secretKey) throw new Error("Stripe isn't configured (no STRIPE_SECRET_KEY).");
    _stripe = new Stripe(config.stripe.secretKey);
  }
  return _stripe;
}
// Verify seam ONLY: swap in a stub so the paths run offline with every call captured. Never called by app code.
function _setStripeForTests(client) {
  _stripe = client;
}

// ── amounts ──

// Has this account ever been funded? Its first top-up is the deposit: at least DEPOSIT_USD.
const hasPaid = async (accountId) => !!(await BalanceEntry.exists({ accountId, kind: { $in: ["topup", "auto-refill", "credit"] } }));

// The top-up amounts this account may pick, in whole dollars: before its first payment, the deposit and the top-up
// amounts above it; after, the top-up amounts. Pure.
function amountsFor(paid, { depositUsd, topupAmountsUsd } = config.billing) {
  if (paid) return [...topupAmountsUsd].sort((a, b) => a - b);
  return [...new Set([depositUsd, ...topupAmountsUsd])].filter((a) => a >= depositUsd).sort((a, b) => a - b);
}

// The top-up that lets a balance cover a price in ONE payment (the "how far back?" page: "Everything" cost ~$66
// against first payments of $20 / $25 / $50, so it took two Checkouts). Whole dollars, rounded
// up to the next $5 (a friendlier number, and a little room for the estimate), never under the deposit for a first
// payment. null when the balance already covers it. Pure.
const TOPUP_STEP_USD = 5;
function topupFor(balanceUsd, priceUsd, paid, { depositUsd } = config.billing) {
  const need = priceUsd - balanceUsd;
  if (!(need > 0)) return null;
  const usd = Math.ceil(need / TOPUP_STEP_USD - 1e-9) * TOPUP_STEP_USD;
  return paid ? usd : Math.max(depositUsd, usd);
}

// ── Stripe ──

// The account's Stripe customer, created on first use. A stored id is verified, not trusted: one deleted in the
// dashboard, or minted under the test key and read under the live one, would fail every Checkout.
async function ensureCustomer(account) {
  const stripe = getStripe();
  if (account.stripeCustomerId) {
    try {
      const c = await stripe.customers.retrieve(account.stripeCustomerId);
      if (c && !c.deleted) return account.stripeCustomerId;
    } catch (err) {
      if (err && err.code !== "resource_missing") throw err;
    }
  }
  const c = await stripe.customers.create({ name: `@${account.username}`, metadata: { app: "xtoolio", accountId: String(account._id) } });
  await Account.updateOne({ _id: account._id }, { $set: { stripeCustomerId: c.id } });
  return c.id;
}

// Deleting an account (services/deleteAccount.js): its Stripe customer deleted, so its saved card goes. Stripe keeps
// the invoices and receipts (the law needs them; Privacy says so). → true when one was deleted.
async function forgetCustomer(account) {
  if (!account.stripeCustomerId || !config.stripe.secretKey) return false;
  try {
    await getStripe().customers.del(account.stripeCustomerId);
    return true;
  } catch (err) {
    if (err && err.code === "resource_missing") return false;
    throw err;
  }
}

// A hosted Checkout for `usd` of credit: payment mode, an inline price (no Stripe Prices to keep in sync), no promo
// codes (a top-up credits exactly what's paid). Our metadata rides the session, the PaymentIntent AND the invoice, so
// whichever object an event carries maps back to the account. → the URL to send the browser to.
async function createTopUpSession(account, usd, { back = "/settings" } = {}) {
  const dollars = Number(usd);
  if (!Number.isInteger(dollars) || dollars <= 0) throw new Error(`invalid top-up amount "${usd}"`);
  const stripe = getStripe();
  const customer = await ensureCustomer(account);
  const m = meta(account._id, "manual");
  const backQ = encodeURIComponent(back);
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer,
    line_items: [{ price_data: { currency: "usd", product_data: { name: `${config.brandName} credit, $${dollars}` }, unit_amount: dollars * 100 }, quantity: 1 }],
    client_reference_id: String(account._id),
    metadata: m,
    payment_intent_data: { metadata: m },
    invoice_creation: {
      enabled: true,
      invoice_data: {
        metadata: m,
        description: `${config.brandName} prepaid credit, $${dollars}. Added to your balance dollar for dollar; your syncing is charged from it.`,
        footer: `${config.legalEntity} · ${config.brandName}`,
      },
    },
    // {CHECKOUT_SESSION_ID} is Stripe's placeholder: it fills in the real id on the way back.
    success_url: `${config.appOrigin}/billing/done?session_id={CHECKOUT_SESSION_ID}&back=${backQ}`,
    cancel_url: `${config.appOrigin}/billing/done?cancelled=1&back=${backQ}`,
  });
  return session.url;
}

// The receipt is the CHARGE's (its hosted page says paid, with the card), not the invoice's (whose PDF says "Amount
// due"). On this API version an Invoice reaches its payment through the InvoicePayment list. Fail-soft: "".
async function receiptUrlFor(invoice) {
  try {
    const stripe = getStripe();
    let payment = (invoice.payments && invoice.payments.data && invoice.payments.data.find((p) => p.status === "paid" && p.payment)) || null;
    if (!payment) payment = ((await stripe.invoicePayments.list({ invoice: invoice.id, status: "paid", limit: 1 })).data || [])[0] || null;
    const pay = payment && payment.payment;
    if (!pay) return "";
    let charge = null;
    if (pay.charge) charge = typeof pay.charge === "string" ? await stripe.charges.retrieve(pay.charge) : pay.charge;
    else if (pay.payment_intent) {
      const pi = typeof pay.payment_intent === "string" ? await stripe.paymentIntents.retrieve(pay.payment_intent, { expand: ["latest_charge"] }) : pay.payment_intent;
      charge = pi && pi.latest_charge && typeof pi.latest_charge === "object" ? pi.latest_charge : pi && pi.latest_charge ? await stripe.charges.retrieve(pi.latest_charge) : null;
    }
    return (charge && charge.receipt_url) || "";
  } catch (e) {
    console.error(`[billing] receipt lookup for ${invoice.id} failed: ${e.message}`);
    return "";
  }
}

// ⭐ THE ONE CREDIT PATH (see top). Credits the PRE-TAX subtotal (tax is off today; if it's ever on, the tax isn't
// ours to spend). → the credit, or null when nothing was credited (not ours, not paid, already credited, older than
// the account).
// AN INVOICE OLDER THAN ITS ACCOUNT credits nothing: Account._id is the X id, so an account deleted (its ledger rows
// go with it, services/deleteAccount.js) and made again by the same person has the same id, and every old Checkout
// session's return link would credit it again (found by an outside read of the code). A payment is always made by an
// account that exists, so a real one is never older than it; INVOICE_SKEW_MS allows for Stripe's clock against ours.
const INVOICE_SKEW_MS = 10 * 60 * 1000;
async function settleTopupInvoice(invoice) {
  if (!invoice || kindOf(invoice.metadata) !== TOPUP) return null;
  if (invoice.status && invoice.status !== "paid") return null;
  const accountId = invoice.metadata.accountId;
  // The pre-tax amount, and never more than was paid: a discount or the customer's Stripe credit (none are offered,
  // but the operator could apply one in Stripe) lowers what's credited with it; tax is never credited.
  const amounts = [invoice.subtotal, invoice.total_excluding_tax, invoice.amount_paid].filter((n) => typeof n === "number");
  const cents = amounts.length ? Math.min(...amounts) : 0;
  if (!accountId || !(cents > 0)) return null;
  const account = await Account.findById(accountId, "createdAt").lean();
  if (!account) return null;
  if (!(invoice.created > 0) || (account.createdAt && invoice.created * 1000 < new Date(account.createdAt).getTime() - INVOICE_SKEW_MS)) {
    console.error(`[billing] ${invoice.id} NOT credited: made ${invoice.created > 0 ? new Date(invoice.created * 1000).toISOString() : "at no stated time"}, before account ${accountId} existed (${account.createdAt && new Date(account.createdAt).toISOString()})`);
    return null;
  }
  const kind = invoice.metadata.source === "auto" ? "auto-refill" : "topup";
  const r = await balance.credit(accountId, toMicros(cents / 100), { kind, ref: invoice.id, label: `$${(cents / 100).toFixed(2)} ${kind === "topup" ? "top-up" : "auto-refill"}` });
  if (!r) return null;
  console.log(`[billing] ${kind}: ${accountId} +$${(cents / 100).toFixed(2)} → $${(r.balanceMicros / 1e6).toFixed(2)} (${invoice.id})`);
  const receiptUrl = await receiptUrlFor(invoice);
  if (receiptUrl) await BalanceEntry.updateOne({ kind, ref: invoice.id }, { $set: { receiptUrl } });
  return r;
}

// A completed top-up Checkout: settle its invoice through the one path.
async function handleTopUp(session) {
  if (!session || kindOf(session.metadata) !== TOPUP) return null;
  if (session.payment_status && session.payment_status !== "paid") return null; // a delayed method: async_payment_succeeded settles it
  if (!session.invoice) return null;
  const invoice = typeof session.invoice === "string" ? await getStripe().invoices.retrieve(session.invoice) : session.invoice;
  return settleTopupInvoice(invoice);
}

// ── the auto-refill card (services/autoRefill.js runs the refills) ──

// "Visa ···4242", from a card's brand + last4. Pure.
const BRANDS = { visa: "Visa", mastercard: "Mastercard", amex: "American Express", discover: "Discover", diners: "Diners Club", jcb: "JCB", unionpay: "UnionPay" };
function cardLabel({ brand, last4 } = {}) {
  if (!last4) return "";
  const b = String(brand || "card").toLowerCase();
  return `${BRANDS[b] || b.charAt(0).toUpperCase() + b.slice(1)} ···${last4}`;
}

// The card door: a SETUP-mode Checkout that saves a card on the customer (bank challenges are Stripe's page; nothing
// card-shaped touches us). `enable`: switch auto-refill on once the card is saved (the "Turn on" with no card yet).
async function createCardSession(account, { enable = false, back = "/settings#billing" } = {}) {
  const customer = await ensureCustomer(account);
  const backQ = encodeURIComponent(back);
  const session = await getStripe().checkout.sessions.create({
    mode: "setup",
    customer,
    payment_method_types: ["card"],
    metadata: { app: "xtoolio", kind: CARD, accountId: String(account._id), enable: enable ? "1" : "0" },
    success_url: `${config.appOrigin}/billing/done?session_id={CHECKOUT_SESSION_ID}&back=${backQ}`,
    cancel_url: `${config.appOrigin}/billing/done?cancelled=1&back=${backQ}`,
  });
  return session.url;
}

// A completed card Checkout: store the card as the refill card (and the customer's default, so the refill's invoice
// charges it), reset the failure state (a new card IS the fix), switch on if asked, then let the watcher look: the
// balance may already be under the line. → the card's label | null. Idempotent (a redelivery stores the same card).
async function handleCardSetup(session) {
  if (!session || kindOf(session.metadata) !== CARD || !session.setup_intent) return null;
  const accountId = session.metadata.accountId;
  const stripe = getStripe();
  const si = typeof session.setup_intent === "string" ? await stripe.setupIntents.retrieve(session.setup_intent, { expand: ["payment_method"] }) : session.setup_intent;
  const pm = si && si.payment_method && typeof si.payment_method === "object" ? si.payment_method : null;
  if (!accountId || !pm) return null;
  const card = pm.card || {};
  await Account.updateOne(
    { _id: accountId },
    {
      $set: {
        "autoRefill.paymentMethodId": pm.id,
        "autoRefill.cardBrand": String(card.brand || ""),
        "autoRefill.cardLast4": String(card.last4 || ""),
        "autoRefill.failCount": 0,
        "autoRefill.lastError": "",
        "autoRefill.disabledReason": "",
        ...(session.metadata.enable === "1" ? { "autoRefill.enabled": true } : {}),
      },
    }
  );
  if (session.customer) {
    await stripe.customers.update(session.customer, { invoice_settings: { default_payment_method: pm.id } }).catch((e) => console.error(`[billing] default card for ${accountId}: ${e.message}`));
  }
  require("./autoRefill").watch(accountId).catch((e) => console.error(`[billing] refill check after a new card failed: ${e.message}`));
  return cardLabel(card);
}

// THE REFILL CHARGE: an invoice paid OFF-SESSION with the saved card, settled by the one credit path (the same
// numbered document a Checkout top-up makes). Create → item → finalize → pay; any failure VOIDS it (no open invoice
// left dunning the customer). → { ok, invoiceId } | { ok: false, code, message }. Never throws for a card problem:
// services/autoRefill.js owns the failure policy.
// What one refill adds: the account's chosen amount when it's a top-up amount, else the platform's default. Dollars.
const refillUsdOf = (account) => {
  const chosen = Number(((account && account.autoRefill) || {}).amountUsd);
  return config.billing.topupAmountsUsd.includes(chosen) ? chosen : config.billing.autoRefillUsd;
};
async function chargeRefill(account) {
  const ar = account.autoRefill || {};
  const usd = refillUsdOf(account);
  if (!account.stripeCustomerId) return { ok: false, code: "no-customer", message: "No payment account on file." };
  if (!ar.paymentMethodId) return { ok: false, code: "no-card", message: "No saved card." };
  const stripe = getStripe();
  const threshold = `$${(config.billing.autoRefillThresholdCents / 100).toFixed(0)}`;
  let inv;
  try {
    inv = await stripe.invoices.create({
      customer: account.stripeCustomerId,
      collection_method: "charge_automatically",
      auto_advance: false, // finalized and paid right here, with the saved card
      default_payment_method: ar.paymentMethodId,
      currency: "usd",
      metadata: meta(account._id, "auto"),
      description: `${config.brandName} auto-refill, $${usd}. Your balance dropped to ${threshold} or below; this was added to it dollar for dollar.`,
      footer: `${config.legalEntity} · ${config.brandName}`,
    });
    await stripe.invoiceItems.create({ customer: account.stripeCustomerId, invoice: inv.id, amount: usd * 100, currency: "usd", description: `${config.brandName} credit, $${usd} (auto-refill)` });
    await stripe.invoices.finalizeInvoice(inv.id);
  } catch (e) {
    if (inv && inv.id) await stripe.invoices.voidInvoice(inv.id).catch(() => {});
    return { ok: false, code: e.code || "invoice-failed", message: e.message || "Couldn't prepare the charge." };
  }
  let paid;
  try {
    paid = await stripe.invoices.pay(inv.id, { off_session: true, payment_method: ar.paymentMethodId });
  } catch (e) {
    await stripe.invoices.voidInvoice(inv.id).catch(() => {});
    return { ok: false, code: e.decline_code || e.code || "payment-failed", message: e.message || "The card was declined." };
  }
  if (!paid || paid.status !== "paid") {
    await stripe.invoices.voidInvoice(inv.id).catch(() => {});
    return { ok: false, code: (paid && paid.status) || "not-paid", message: "The payment didn't complete." };
  }
  await settleTopupInvoice(paid);
  return { ok: true, invoiceId: paid.id };
}

// ── the return page (one for both kinds) ──

// The session (with its invoice), or null if it isn't one of this account's.
async function sessionFor(sessionId, accountId) {
  if (!/^cs_[A-Za-z0-9_]+$/.test(String(sessionId))) return null;
  const session = await getStripe().checkout.sessions.retrieve(String(sessionId), { expand: ["invoice"] });
  return session && [TOPUP, CARD].includes(kindOf(session.metadata)) && session.metadata.accountId === String(accountId) ? session : null;
}

// Settle a returned session → "paid" (a top-up credited, now or already) | "card" (a card saved) | "pending".
async function settleReturn(session) {
  if (kindOf(session.metadata) === CARD) return (await handleCardSetup(session)) ? "card" : "pending";
  return (await handleTopUp(session)) || session.payment_status === "paid" ? "paid" : "pending";
}

// ── statements (the Usage page) ──

// An account's PAYMENTS with Stripe's own receipt for each (Settings → Billing → Receipts): its top-ups and
// auto-refills, newest first, as settleTopupInvoice credited them (`receiptUrl`, the Charge's hosted receipt). → [{ at,
// usd, kind, url }]
async function receiptsFor(accountId, limit = 50) {
  const rows = await BalanceEntry.find({ accountId, kind: { $in: ["topup", "auto-refill"] }, receiptUrl: { $type: "string" } }, "at micros kind receiptUrl").sort({ at: -1 }).limit(limit).lean();
  return rows.map((r) => ({ at: r.at, usd: r.micros / 1e6, kind: r.kind, url: r.receiptUrl }));
}

// A paying account's statement (the Usage page: what it was CHARGED, never X's cost). A page of its balance movements,
// newest first, each run with what it read (lib/feedCursor.js: `before` the last row shown, `next` the page after).
async function statement(accountId, { before = null, limit = 30 } = {}) {
  const { rows, next } = await page((f) => BalanceEntry.find({ accountId, ...f }, "at micros balanceAfter kind ref label receiptUrl"), { field: "at", before, limit });
  const runIds = rows.filter((r) => r.kind === "run").map((r) => r.ref);
  const units = new Map((await UsageEntry.find({ _id: { $in: runIds } }, "lines").lean()).map((u) => [String(u._id), u]));
  return { rows: rows.map((r) => ({ ...r, reads: r.kind === "run" && units.has(r.ref) ? describeReads(units.get(r.ref).lines) : null })), next };
}

// Its charges and top-ups per day in the viewer's zone from `since` ("YYYY-MM-DD") on, summed by the database:
// [{ day, charged, added }] newest first (micro-dollars). The Usage page's chart and its month. `charged` is X work
// only (kind "run"); `added` is every other movement, net (top-ups, credits, less a refund taken back): a refund isn't
// spending.
async function statementDays(accountId, { timeZone = "UTC", since }) {
  const from = new Date(`${since}T00:00:00Z`); // a day early in zones ahead of UTC: trimmed by `since` below
  from.setUTCDate(from.getUTCDate() - 1);
  const groups = await BalanceEntry.aggregate([
    { $match: { accountId, at: { $gte: from } } },
    { $group: { _id: dayExpr("$at", timeZone), charged: { $sum: { $cond: [{ $eq: ["$kind", "run"] }, { $multiply: ["$micros", -1] }, 0] } }, added: { $sum: { $cond: [{ $eq: ["$kind", "run"] }, 0, "$micros"] } } } },
  ]);
  return groups.filter((g) => g._id >= since).map((g) => ({ day: g._id, charged: g.charged, added: g.added })).sort((a, b) => (a.day < b.day ? 1 : -1));
}

// ── webhook ──

function constructEvent(rawBody, signature) {
  if (!config.stripe.webhookSecret) throw new Error("no STRIPE_WEBHOOK_SECRET");
  return getStripe().webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
}

// Route a verified event. Only xtoolio's own kinds are acted on; everything else is acknowledged and ignored.
async function handleEvent(event) {
  const obj = event && event.data && event.data.object;
  if (!obj || ![TOPUP, CARD].includes(kindOf(obj.metadata))) return;
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      if (obj.mode === "payment") await handleTopUp(obj);
      else if (obj.mode === "setup") await handleCardSetup(obj);
      break;
    case "invoice.paid":
      await settleTopupInvoice(obj);
      break;
    default:
      break;
  }
}

module.exports = { ...balance, hasPaid, amountsFor, topupFor, ensureCustomer, forgetCustomer,createTopUpSession, settleTopupInvoice, handleTopUp, cardLabel, createCardSession, handleCardSetup, chargeRefill, refillUsdOf, sessionFor, settleReturn, statement, statementDays, receiptsFor, constructEvent, handleEvent, _setStripeForTests, TOPUP, CARD };
