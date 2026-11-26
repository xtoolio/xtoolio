const mongoose = require("mongoose");

// Who has xtoolio open right now: one doc per account while any of its tabs holds a /live stream. Every web
// process keeps `until` a little ahead for the accounts whose tabs it holds (services/livePush.js), so it lapses by
// itself within a minute of the last tab closing, a crash included. The worker reads it to check those accounts'
// mentions often (services/mentionsCheck.js), writing `checkedAt`. Gone 60 minutes after it lapsed (TTL).
const PresenceSchema = new mongoose.Schema(
  {
    _id: String, // the account id
    until: { type: Date, required: true },
    checkedAt: Date,
  },
  { versionKey: false, collection: "presence" }
);
PresenceSchema.index({ until: 1 }, { expireAfterSeconds: 3600 });

module.exports = mongoose.model("Presence", PresenceSchema);
