const mongoose = require("mongoose");

// WHO THEY TAG (services/tagged.js, Follows → Who they tag): one account's read of one other account's recent posts,
// kept as who those posts @-tag. `_id` = "<accountId>:<handle in lowercase>": reading the same handle again replaces
// it. `people`: each tagged account, how many of the posts tag them (`n`) and the newest one's time (`lastAt`), most
// first. `posts`: how many of their posts were read (their own, no replies or reposts). Gone 30 days after the read
// (TTL); deleted with the account (services/deleteAccount.js).
const TagReadSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    accountId: { type: String, required: true },
    handle: String, // as X spells it
    userId: String, // their X id
    name: String,
    image: String, // Person.imageOf: pbs.twimg.com only
    posts: Number,
    people: [{ _id: false, id: String, username: String, n: Number, lastAt: Date }],
    at: { type: Date, required: true },
  },
  { versionKey: false }
);
TagReadSchema.index({ at: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });
// An account's reads, newest first (services/tagged.js readsOf), and the delete cascade's by account. Not the TTL's `at`
// alone: with every account's reads in it, the newest-first walk passed through everyone else's.
TagReadSchema.index({ accountId: 1, at: -1 });

module.exports = mongoose.model("TagRead", TagReadSchema);
