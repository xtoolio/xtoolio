const mongoose = require("mongoose");

// THE WAITLIST (services/waitlist.js). One row per person who signed in with X before sign-up was open to them: `_id`
// their X id, who they are as X said at their last sign-in or the last follow check (handle, name, picture,
// followers), when they joined; `follows` whether they follow the site's X account (SITE_X, read with the DM sender's
// token by the worker as they join, services/waitlistDms.js checkFollows; absent = not checked yet) and `followsAt`
// when (set alone for someone X wouldn't return: not asked again);
// `grantedAt` / `grantedBy` once an admin let them in (Admin → Waitlist → Grant), `signedUpAt` once they made an
// account; `invitedAt` when an INVITE made their row before they'd joined (an admin's by handle, or a link:
// services/waitlist.js admit; `joinedAt` the same moment), `invitedBy` the account whose INVITE LINK let them in
// (services/invites.js; `grantedBy` is then that account too). Nothing else: their X sign-in is revoked at once.
// (Each row once had a numbered place `n` in one shared line let in by batch; now an admin grants
// people one at a time and each is told by DM.)
const WaitlistSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    username: String,
    name: String,
    image: String, // X's picture, pbs.twimg.com only (Person.imageOf)
    followers: Number,
    joinedAt: { type: Date, required: true },
    follows: Boolean,
    followsAt: Date,
    grantedAt: Date,
    grantedBy: String, // the admin's X user id
    signedUpAt: Date,
    invitedAt: Date,
    invitedBy: String, // the inviting account's X id (an invite link)
    // THE INVITE CREDIT (services/waitlist.js): promised by an admin's Invite (micro-dollars), paid ONCE at their first
    // sign-in (`creditedAt`).
    creditMicros: Number,
    creditedAt: Date,
  },
  { versionKey: false, collection: "waitlist" }
);
WaitlistSchema.index({ grantedAt: 1, joinedAt: 1 });

module.exports = mongoose.model("Waitlist", WaitlistSchema);
