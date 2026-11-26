const mongoose = require("mongoose");

// ⭐ THE LEDGER ROW: one per unit of X work (a sync run, a Follows refresh, a sign-in lookup, a one-off script), opened
// BEFORE the first read and written to on every X response (lib/x.js → services/usage.js record), so a run that dies
// halfway has still recorded everything it read. The /usage page is read off these rows and BalanceReading.
//
//   lines     — per what was read ("timeline", "context", "profiles", "likes", "likers", "follows", "me") and price
//               class (lib/pricing.js: owned | post | user): { returned, billed } — billed = returned minus what X
//               already returned earlier that UTC day (X's dedup, modeled by ReadMark).
//   estUsd    — AT X'S PRICES: billed × the price list. Exactly what the unit is charged on (services/balance.js); the
//               name is legacy (it isn't a guess: a count of X's answers, priced), kept to spare every row a migration.
//   status    — "open" while running, then "ok" | "failed".
//   expireAt  — set on an ok unit that billed nothing (a sync that found nothing new): it's dropped a week later (TTL).
// X's REAL cost is per day, from the balance clock's readings (BalanceReading, services/balanceClock.js), never per
// unit. The oldest rows also carry before / after / from / to / realUsd / realNote (a reading around
// every unit); nothing reads them any more.
const LineSchema = new mongoose.Schema({ returned: { type: Number, default: 0 }, billed: { type: Number, default: 0 } }, { _id: false });

const UsageEntrySchema = new mongoose.Schema(
  {
    accountId: String, // indexed with startedAt below (that index serves accountId alone too)
    // "live": an hour's live events for one account (services/live.js flushPending), estimate-only.
    // Every kind a `metered()` call passes must be here (verify-billing checks the source): "repost" was once
    // missing, so every ↻ press failed to open its unit. "waitlist": the worker's check of who follows the site's
    // account; "invite": Admin's Invite by @handle (one profile read). Admin → P&L lists the site's own kinds apart.
    kind: { type: String, enum: ["sync", "follows", "profile", "likes", "like", "follow", "reply", "repost", "signin", "script", "live", "estimate", "dm", "waitlist", "invite"], required: true },
    label: String,
    startedAt: { type: Date, required: true, index: true },
    // The running unit's heartbeat (lib/heartbeat.js): an open unit whose beat is older than LEASE_MS died.
    beatAt: Date,
    endedAt: Date,
    status: { type: String, enum: ["open", "ok", "failed"], default: "open", index: true },
    error: String,
    lines: { type: Map, of: LineSchema, default: () => ({}) },
    estUsd: { type: Number, default: 0 },
    expireAt: Date,
    // Set when the unit opens for an account that's billed (services/billing.js handed metered() its billing);
    // removed once services/balance.js has charged it. A unit that closed but wasn't charged yet (the process died
    // in between, or it was closed later by settleStale) still carries it, and the next unit's sweep charges it.
    chargeDue: Boolean,
    // A BULK READ (services/balance.js) = ONBOARDING only: your history and the look back through your likes
    // (meter.bulkRead, on the first backward page). Charged at BULK_MARKUP_PCT (15%), outside the month's threshold
    // count. A few older rows also have it on the whole follower list and the accounts you follow (no longer).
    // Was `historyRead` (no row had it).
    bulkRead: Boolean,
    // THE CEILING: X's cost this unit is never charged on more than (balance.js capped), and stops reading at (lib/x.js:
    // a read once the unit's cost reaches it). The lower of the quote the person was shown before it ran
    // (metered({ ceilingUsd })) and what the account's balance covers at the unit's rate (`ceilingOf` says which:
    // "quote" | "balance"; a run that turns into a history read is re-ceiled at the onboarding rate, meter.bulkRead).
    ceilingUsd: Number,
    ceilingOf: { type: String, enum: ["quote", "balance"] },
    // An estimate a signed-out visitor asked for (services/estimator.js): only these count against its DAILY_MAX.
    visitor: Boolean,
  },
  { versionKey: false }
);

UsageEntrySchema.index({ chargeDue: 1 }, { partialFilterExpression: { chargeDue: true } });
// The Usage page / a customer's statement: one account's rows, newest first (services/usage.js usageRows, a page at a time). The
// single accountId index made it sort every row the account ever had (~320 a day for an active account).
UsageEntrySchema.index({ accountId: 1, startedAt: -1 });
// A unit that cost nothing goes a week after it closed (services/usage.js close sets expireAt; rows without it stay).
UsageEntrySchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("UsageEntry", UsageEntrySchema);
