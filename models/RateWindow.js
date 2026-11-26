const mongoose = require("mongoose");

// What X last said about one account's rate-limit window on one endpoint (lib/x.js paces on it): `_id` =
// "<account id> <endpoint>" (e.g. "12345 /tweets/:id/liking_users"). Stored so a restart, the worker and the web
// process (a Sync now press) all know a window another one used, instead of each learning it from a 429. Gone once
// the window resets.
const RateWindowSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    remaining: { type: Number, required: true },
    reset: { type: Date, required: true },
  },
  { versionKey: false }
);
RateWindowSchema.index({ reset: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("RateWindow", RateWindowSchema);
