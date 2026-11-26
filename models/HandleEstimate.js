const mongoose = require("mongoose");

// One handle's measured pace (services/estimator.js): its posts and the replies and mentions to it a day over X's last
// 30 whole days, kept so asking again costs nothing: fresh for a week (estimator.FRESH_MS), then measured again when
// someone asks (an account's own Settings also has a "Re-estimate" button). `_id` = the handle in lowercase. Public
// counts only, the same for anyone who asks. `error: "unknown"` = X has no such account (kept a day). Gone at
// `expireAt` (TTL). `name` and `image` (their public profile picture, X's address) say whose month the estimate is.
const HandleEstimateSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    handle: String, // as X spells it
    name: String,
    image: String, // Person.imageOf: pbs.twimg.com only; null = none on X; absent = measured before it was kept (re-measured)
    written: Number, // their own posts a day
    received: Number, // replies and mentions to them a day
    days: Number, // whole days averaged
    posts: Number, // their lifetime post count (prices a history read)
    error: String,
    measuredAt: { type: Date, required: true },
    expireAt: { type: Date, required: true },
  },
  { versionKey: false }
);
HandleEstimateSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("HandleEstimate", HandleEstimateSchema);
