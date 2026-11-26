const mongoose = require("mongoose");

// A stretch when X's activity stream wasn't connected (services/live.js records one at each reconnect: from the last
// beat of the connection before to the moment the new one opened; a restart, a deploy, a laptop asleep). Whatever X
// pushed then is gone (pay-per-use can't replay, docs/ACTIVITY-API.md), so the catch-ups that cost money look only at
// these windows: the likers check reads who liked a reply only when its first day overlapped one (services/extras.js).
// Kept two weeks.
const LiveGapSchema = new mongoose.Schema(
  {
    from: { type: Date, required: true },
    to: { type: Date, required: true },
  },
  { versionKey: false, collection: "livegaps" }
);
LiveGapSchema.index({ to: 1 }, { expireAfterSeconds: 14 * 24 * 3600 });

module.exports = mongoose.model("LiveGap", LiveGapSchema);
