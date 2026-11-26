const mongoose = require("mongoose");

// ⭐ ONE MOVEMENT OF AN ACCOUNT'S PREPAID BALANCE (docs/BILLING.md). Written only by services/balance.js, in the same
// call that moves Account.balanceMicros, so a charge or a credit with no row can't happen. The Usage page shows a
// customer these rows (what they were charged), never X's cost.
//
//   micros        what actually moved, signed: a charge negative, a credit positive (integer micro-dollars).
//   balanceAfter  the balance right after it (null only for a row written late, after a crash between the two).
//   kind          "run" (a unit of X work: ref = its UsageEntry id) | "topup" | "auto-refill" (ref = Stripe's invoice
//                 id) | "credit" (added by hand) | "refund" (taken back by hand after a refund granted in Stripe:
//                 refunds are the operator's, one by one, never automatic; scripts/credit.js with a negative amount).
//   costUsd       for a run: X's prices on what it read (`basis`, below), or its ceiling when that was less.
//   multiplier    for a run: the markup rate it was charged at.
//   markupUsd     for a run: the markup actually charged (less than cost × (multiplier − 1) once the month's cap is near).
//   receiptUrl    for a top-up: the Charge's receipt (Stripe's hosted page; the invoice PDF says "Amount due").
const BalanceEntrySchema = new mongoose.Schema(
  {
    accountId: { type: String, required: true },
    at: { type: Date, default: Date.now },
    micros: { type: Number, required: true },
    balanceAfter: { type: Number, default: null },
    kind: { type: String, enum: ["run", "topup", "auto-refill", "credit", "refund"], required: true },
    ref: { type: String, default: null },
    label: { type: String, default: "" },
    costUsd: Number,
    // What costUsd rests on: "prices" (X's price list on what the unit read; every current charge), "quote" (a
    // read quoted before it ran, charged its quote at most), "balance" (a unit charged what the balance held when it
    // started, at most: never past it). Older rows: "estimate" (the price list × the calibration then
    // applied), "real" (X's balance drop around a unit, an earlier way of costing).
    basis: { type: String, enum: ["prices", "quote", "balance", "estimate", "real"] },
    multiplier: Number,
    markupUsd: Number,
    receiptUrl: String,
  },
  { versionKey: false }
);

BalanceEntrySchema.index({ accountId: 1, at: -1 });
// THE PAYMENTS (Settings → Billing → Receipts, services/billing.js receiptsFor): only the rows with Stripe's receipt are
// in it (partial), so it stays a handful per account while charges pile up (the account-and-time index walked every
// charge to reach the payments: 207 rows for one). Its filter must match the query's exactly.
BalanceEntrySchema.index({ accountId: 1, kind: 1, at: -1 }, { name: "payments", partialFilterExpression: { receiptUrl: { $type: "string" } } });
// One row per unit, per invoice: a retried charge or a redelivered webhook can't write a second.
BalanceEntrySchema.index({ kind: 1, ref: 1 }, { unique: true, partialFilterExpression: { ref: { $type: "string" } } });

module.exports = mongoose.model("BalanceEntry", BalanceEntrySchema);
