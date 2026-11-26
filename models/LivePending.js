const mongoose = require("mongoose");

// A live event X has delivered (and billed) that isn't on the ledger yet (services/live.js). Ingest writes one per
// billable thing as it arrives; once an hour (and on boot) the worker turns each account's pending rows into ONE short
// metered unit, "Live", and deletes them (a ledger row per event would be thousands a day). Kept here, not in memory, so a crash or deploy loses nothing; an account the gate refuses keeps its rows until it
// can be charged. Unique per account + thing: a duplicate delivery (a reconnect) is one row.
const LivePendingSchema = new mongoose.Schema(
  {
    accountId: { type: String, required: true },
    what: { type: String, required: true }, // the ledger's word (services/usage.js READ_WORDS: live-replies, live-likes…)
    cls: { type: String, required: true }, // the price class (lib/pricing.js PRICE)
    resourceId: { type: String, required: true },
    at: { type: Date, default: Date.now },
    // (No `billed` flag: X bills every delivered event, services/live.js notePending.)
  },
  { versionKey: false, collection: "livepending" }
);
LivePendingSchema.index({ accountId: 1, what: 1, resourceId: 1 }, { unique: true });

module.exports = mongoose.model("LivePending", LivePendingSchema);
