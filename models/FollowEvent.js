const mongoose = require("mongoose");

// One follow or unfollow X pushed for an account (Live, follow.follow / follow.unfollow, the Follows extra): who, which
// way, when. The Follows page lists the ones TO the account ("Maya followed you", "Maya unfollowed you"); the ones BY it
// (you following someone) are kept too, since X bills them alike and they set the same pair facts. X has no history to
// fetch, so this starts when the subscription does. The pair's current state is models/Follow.js (this updates it).
//   _id        X's event_uuid (a duplicate delivery is the same row)
//   direction  "in" (someone → the account) | "out" (the account → someone)
//   kind       "follow" | "unfollow"
//   personId   the other person
//   at         when it happened (X's created_at)
//   seenAt     when xtoolio stored it (the Follows tab's count: services/unseenCount.js)
// The Follows tab is what X sends, best effort: nothing re-reads what X doesn't send.
const FollowEventSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    accountId: { type: String, required: true },
    direction: { type: String, required: true, enum: ["in", "out"] },
    kind: { type: String, required: true, enum: ["follow", "unfollow"] },
    personId: { type: String, required: true },
    at: { type: Date, required: true },
    seenAt: { type: Date, default: Date.now },
  },
  { versionKey: false, collection: "followevents" }
);
FollowEventSchema.index({ accountId: 1, direction: 1, at: -1 }); // the Follows page
FollowEventSchema.index({ accountId: 1, direction: 1, seenAt: -1 }); // its count
FollowEventSchema.index({ accountId: 1, at: -1 }); // Settings' last 30 days (both directions are billed)

module.exports = mongoose.model("FollowEvent", FollowEventSchema);
