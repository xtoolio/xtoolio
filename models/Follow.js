const mongoose = require("mongoose");

// Who follows whom, between two X users: `followerId` follows `followeeId` (follows: true) or doesn't (false), as of
// `checkedAt`. A fact about the PAIR, stored once ("Maya follows you"; Mutual is both directions true), but
// only ever SHOWN to its two ends: X tells an account only its own relationships, and the pages read edges where the
// viewer is one side (services/extras.js signalsFor).
//
// Filled by profile reads: every profile is read with X's `connection_status` (lib/x.js USER_FIELDS), which says, for
// the account whose token read it, whether that person follows it and whether it follows them; an unfollow is the next
// read saying no (Follow.record). And, with the Follows extra on, by Live's follow / unfollow events as they happen
// (Follow.fromEvent; the events themselves are models/FollowEvent.js). It replaced the Follows refresh, which re-read both of
// an account's lists whole ($0.01 a person for a customer, every week) and already disagreed with X
// on two mutuals 5 hours after it ran. The old per-account lists are in the `follows` collection, left untouched.
const FollowSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true }, // `${followerId}>${followeeId}`
    followerId: { type: String, required: true },
    followeeId: { type: String, required: true },
    follows: { type: Boolean, required: true },
    checkedAt: { type: Date, required: true },
  },
  { versionKey: false, collection: "followedges" }
);
FollowSchema.index({ followeeId: 1, follows: 1 });
FollowSchema.index({ followerId: 1, follows: 1 });

// A batch this size with no connection_status on anyone isn't "none of them follow you": X stopped sending the field
// (a permission it needs, say). Writing it would mark everyone unfollowed, so it's skipped and logged.
const SUSPICIOUS_EMPTY_BATCH = 10;

// What X said about the viewer's relationship with each of these users (profiles it just read with its own token).
// X leaves connection_status out when there's no relationship, so a missing field means "neither follows" — but only
// once X has shown it sends the field to this viewer at all (any status in this batch, or an edge from before).
// → how many pairs were written.
FollowSchema.statics.record = async function record(viewerId, users, checkedAt = new Date()) {
  const others = users.filter((u) => u.id !== viewerId);
  if (!others.length) return 0;
  const anyStatus = others.some((u) => Array.isArray(u.connection_status));
  if (!anyStatus) {
    if (others.length >= SUSPICIOUS_EMPTY_BATCH) {
      console.error(`[follows] X sent no follow status for ${others.length} profiles read by ${viewerId}; not recorded`);
      return 0;
    }
    if (!(await this.exists({ $or: [{ followerId: viewerId }, { followeeId: viewerId }] }))) return 0;
  }
  const edge = (followerId, followeeId, follows) => ({
    updateOne: { filter: { _id: `${followerId}>${followeeId}` }, update: { $set: { followerId, followeeId, follows, checkedAt } }, upsert: true },
  });
  const ops = others.flatMap((u) => {
    const cs = u.connection_status || [];
    return [edge(u.id, viewerId, cs.includes("followed_by")), edge(viewerId, u.id, cs.includes("following"))];
  });
  await this.bulkWrite(ops, { ordered: false });
  return others.length;
};

// One pair's state from something that just HAPPENED, as of when it happened: a live follow / unfollow event
// (services/live.js) or your own press (services/extras.js setFollow). Written only if it's newer than what's stored (a
// profile read can be later than a delayed event). → whether the pair FLIPPED (it was the other way, or unknown).
//
// A flip moves the header's counts of whichever end is an account by exactly one (Account.followFlipped): THE live
// writer of those counts between reads of your own profile. Your press and X's echo of it are the same flip, and only
// the first to land finds it (the echo's older `at` isn't written, or finds it already that way), so a follow is
// never counted twice.
// (Seen: a burst of unfollows in a few seconds; each event's own copy of your profile set the header, in whatever
// order they arrived, so the count jumped up and down before settling, and then on a number that was wrong. Those
// copies no longer write the counts: models/Person.js store.)
FollowSchema.statics.fromEvent = async function fromEvent(followerId, followeeId, follows, at) {
  const _id = `${followerId}>${followeeId}`;
  let flipped;
  const before = await this.findOneAndUpdate({ _id, checkedAt: { $lt: at } }, { $set: { follows, checkedAt: at } }, { returnDocument: "before", projection: { follows: 1 } }).lean();
  if (before) flipped = before.follows !== follows;
  else if (await this.exists({ _id })) return false; // stored, and newer
  else {
    try {
      await this.create({ _id, followerId, followeeId, follows, checkedAt: at });
      flipped = true;
    } catch (err) {
      if (err.code === 11000) return false; // written meanwhile
      throw err;
    }
  }
  if (flipped) await require("./Account").followFlipped(followerId, followeeId, follows ? 1 : -1); // lazy: Account → Person → …
  return flipped;
};

module.exports = mongoose.model("Follow", FollowSchema);
