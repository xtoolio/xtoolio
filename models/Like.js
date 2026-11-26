const mongoose = require("mongoose");

// One like, as seen by one account (the Likes extra, services/extras.js). Two kinds, both from X's view of THIS
// account (likes are private since 2024, so only these two are readable):
//   you liked theirs  → likerId = the account, authorId = the post's author   (from liked_tweets)
//   they liked yours  → authorId = the account, likerId = the person           (from liking_users on your posts)
const LikeSchema = new mongoose.Schema(
  {
    accountId: { type: String, required: true },
    postId: { type: String, required: true },
    authorId: { type: String, required: true },
    likerId: { type: String, required: true },
    // When xtoolio learned of it (with likedAt, the Likes tab's "new since you looked": services/unseenCount.js).
    seenAt: { type: Date, default: Date.now },
    // When it was LIKED, where X says: a live event's created_at. The likes pass and the likers check
    // get no time from X: the Likes page sorts those by their post's time, shows no time and never calls them new
    // (services/likes.js TIMED).
    likedAt: { type: Date },
    // A like on your post you SAW arrive, live, on another page in view (its like line drawn under the post: POST
    // /posts/viewed from public/js/live.js). It isn't news on Your posts any more: not counted on its tab, no "new"
    // edge on its card (services/likes.js NEWS: a like you watched arrive isn't new).
    viewedAt: { type: Date },
    // A like sent from xtoolio (the ♥ in a conversation, services/extras.js setLike) that the sync hasn't yet seen in
    // X's list of your likes. The sync's new-likes pass stops at the first like already stored, so it must not stop
    // on one of these (it would miss the likes made on X just before it); seeing it there clears the flag.
    fromApp: { type: Boolean },
  },
  { versionKey: false }
);
LikeSchema.index({ accountId: 1, postId: 1, likerId: 1 }, { unique: true });
LikeSchema.index({ accountId: 1, likerId: 1, authorId: 1 });
LikeSchema.index({ accountId: 1, authorId: 1, seenAt: -1 }); // likes on the account's posts: the Likes page and its count

module.exports = mongoose.model("Like", LikeSchema);
