const mongoose = require("mongoose");

// A named lease one process holds at a time (lib/lease.js): `holder` (who: host + pid + a random tag), `until` (pushed
// out by its heartbeat; past it, anyone may take it). The worker's duties hold "worker": EXACTLY ONE worker schedules
// syncs, ensures X subscriptions, flushes the live ledger and reads X's balance, even while a new one is starting
// beside the old during a restart (app.js).
const LeaseSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    holder: { type: String, required: true },
    until: { type: Date, required: true },
  },
  { versionKey: false }
);

module.exports = mongoose.model("Lease", LeaseSchema);
