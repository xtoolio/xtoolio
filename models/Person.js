const mongoose = require("mongoose");

// Someone on the leaderboard, as X describes them. `_id` is X's user id.
// Filled by sync's profile pass (GET /2/users?ids=, billed per user returned),
// refreshed as old as the account's choice for their tier allows (services/syncPrefs.js). An id X won't return (suspended, deleted)
// is stored with `gone` = X's own error so it isn't re-asked every run.
const PersonSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    username: String,
    name: String,
    image: String,
    bio: String,
    // The t.co links inside `bio`, as X expands them (rendered by services/text.js like a post's links).
    bioUrls: [{ _id: false, url: String, expanded: String, display: String, start: Number }],
    location: String,
    // The profile's website, already expanded (X stores it as a t.co link).
    website: { _id: false, url: String, display: String },
    joinedAt: Date,
    followers: Number,
    following: Number,
    posts: Number,
    verified: Boolean,
    verifiedType: String,
    protected: Boolean,
    gone: { _id: false, title: String, detail: String },
    fetchedAt: { type: Date, required: true },
    raw: mongoose.Schema.Types.Mixed,
  },
  { versionKey: false }
);

// THE profile picture from X's `profile_image_url`: X serves 48px "_normal" by default; "_bigger" is the same image at
// 73px, sharp at both the 28px list avatar and the 64px profile header on a 2x screen (X's documented size suffixes,
// not a guess at the URL shape). Only X's picture host (the CSP's one outside origin, img-src https://pbs.twimg.com):
// someone with X's default avatar has it on abs.twimg.com, which the page would block (seen on new followers);
// they get their initial. Profiles (fromApi below) and the front page's estimate (services/estimator.js) both use it.
PersonSchema.statics.imageOf = function imageOf(url) {
  return typeof url === "string" && /^https:\/\/pbs\.twimg\.com\//.test(url) ? url.replace(/_normal(\.\w+)$/, "_bigger$1") : undefined;
};

// A full replacement doc: absent fields are left out (not null), and `gone`
// is absent, so a returning account clears its old "not on X" mark.
PersonSchema.statics.fromApi = function fromApi(u, fetchedAt) {
  const m = u.public_metrics || {};
  const e = u.entities || {};
  const site = e.url && e.url.urls && e.url.urls[0];
  const doc = {
    _id: u.id,
    username: u.username,
    name: u.name,
    image: this.imageOf(u.profile_image_url),
    bio: u.description || undefined,
    bioUrls: e.description && e.description.urls ? e.description.urls.map((x) => ({ url: x.url, expanded: x.expanded_url, display: x.display_url, start: x.start })) : undefined,
    location: u.location || undefined,
    website: site && site.expanded_url ? { url: site.expanded_url, display: site.display_url || site.expanded_url } : undefined,
    joinedAt: u.created_at ? new Date(u.created_at) : undefined,
    followers: m.followers_count,
    following: m.following_count,
    posts: m.tweet_count,
    verified: u.verified,
    verifiedType: u.verified_type,
    protected: u.protected,
    fetchedAt,
    // Everything X sent, minus connection_status: that's the READING account's relationship with this person
    // (models/Follow.js), and this doc is shared by every account.
    raw: Object.fromEntries(Object.entries(u).filter(([k]) => k !== "connection_status")),
  };
  return Object.fromEntries(Object.entries(doc).filter(([, v]) => v !== undefined));
};

// THE way to save profiles X returned: replaces each Person doc, and when one of them is a signed-in account,
// copies what its header shows (Account.selfFields) onto that account in the same step. Every writer goes through
// here, so no path can refresh a profile and leave the header stale (a one-off bio-links refresh once did: the
// Person said 661 followers, the header 658, until the next self refresh 6h later). When an account's follower or
// following count moved, its open pages hear it (LiveEvent "me": the header's counts, public/js/live.js). Returns the
// ids written.
// `counts: false` (services/live.js): a live event's copy of a profile is X's snapshot from some moment, and events
// arrive in any order, so it refreshes the name and picture but never the account's counts (a burst of unfollows set
// the header backwards and forwards). Between reads, those move only when a follow pair flips
// (models/Follow.js fromEvent).
PersonSchema.statics.store = async function store(users, fetchedAt, { counts = true } = {}) {
  if (!users.length) return [];
  const Account = require("./Account"); // lazy: Account requires this module too
  const LiveEvent = require("./LiveEvent");
  await this.bulkWrite(
    users.map((u) => {
      const doc = this.fromApi(u, fetchedAt);
      return { replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true } };
    }),
    { ordered: false }
  );
  const ids = users.map((u) => u.id);
  const accounts = await Account.find({ _id: { $in: ids } }, "_id").lean(); // by _id: a handful at most
  const byId = new Map(users.map((u) => [u.id, u]));
  for (const { _id } of accounts) {
    const { followers, following, ...rest } = Account.selfFields(byId.get(_id));
    const withCounts = counts && Number.isFinite(followers);
    // One atomic write, answering what was there before: whether the counts MOVED is judged against that, not an
    // earlier read a follow's flip could have changed meanwhile.
    const update = withCounts ? { $set: { ...rest, followers, following }, $inc: { countsV: 1 } } : { $set: rest };
    const was = await Account.findOneAndUpdate({ _id }, update, { returnDocument: "before", projection: { followers: 1, following: 1, countsV: 1 } }).lean();
    if (withCounts && was && (was.followers !== followers || was.following !== following)) await LiveEvent.note(_id, "me", Account.meOf({ followers, following, countsV: (was.countsV || 0) + 1 }));
  }
  return ids;
};

module.exports = mongoose.model("Person", PersonSchema);
