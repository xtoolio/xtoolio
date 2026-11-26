const mongoose = require("mongoose");

// One repost (a plain one: a quote repost is a post of its own, in the Inbox), as seen by one account, Like's twin
// (models/Like.js). Two kinds:
//   you reposted theirs  → reposterId = the account, authorId = the post's author   (the ↻ press; your timeline's reposts)
//   they reposted yours  → authorId = the account, reposterId = the person         (Live's post.repost.create)
// The Likes page lists the second kind beside the likes (X's phone app notifies a repost, so xtoolio shows
// it too); the first is the ↻ button's state.
const RepostSchema = new mongoose.Schema(
  {
    accountId: { type: String, required: true },
    postId: { type: String, required: true },
    authorId: { type: String }, // unknown for one of yours learned from your timeline before its post was stored
    reposterId: { type: String, required: true },
    // When xtoolio learned of it (the Likes tab's "new since you looked", services/unseenCount.js).
    seenAt: { type: Date, default: Date.now },
    // When it was reposted, where X says (the event's or the repost's created_at).
    repostedAt: { type: Date },
    // A repost sent from xtoolio (the ↻ press) that the sync hasn't yet seen in your timeline.
    fromApp: { type: Boolean },
  },
  { versionKey: false }
);
RepostSchema.index({ accountId: 1, postId: 1, reposterId: 1 }, { unique: true });
RepostSchema.index({ accountId: 1, authorId: 1, seenAt: -1 }); // reposts of the account's posts: the Likes page and its count

module.exports = mongoose.model("Repost", RepostSchema);
