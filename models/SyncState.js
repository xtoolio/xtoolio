const mongoose = require("mongoose");

// Where each stream's sync stands, so a run only reads what's new and a
// capped pass resumes where it stopped.
//   newestId  — the newest post stored (next run reads since_id = this)
//   oldestId  — the oldest post stored (the backfill resumes until_id = this)
//   backfillDone — no more reading backwards: X has nothing older, OR the
//               account's chosen depth was reached (then budgetReached too),
//               OR the Inbox's floor was (then floorReached: an Inbox without
//               People reads back only to a week before joining; People
//               turned on later reopens it, services/sync.js streamSteps)
//   gapTop / gapUntil — an unfinished forward pass: the newest and oldest ids it
//               read. The next run resumes below gapUntil (services/sync.js
//               streamSteps); both clear when the pass completes.
const StreamSchema = new mongoose.Schema(
  {
    newestId: String,
    oldestId: String,
    backfillDone: { type: Boolean, default: false },
    budgetReached: { type: Boolean, default: false },
    floorReached: Boolean,
    gapTop: String,
    gapUntil: String,
  },
  { _id: false }
);

// The Likes extra's look back through your likes (services/extras.js runLikes). X pages likes newest-LIKE first
// by token, not by post id, so the place to resume is the token of the next older page.
//   backfillToken — where the next run continues (unset + not done = start from the top)
//   backfillRead  — likes read on the way back so far, across runs
//   backfillDone  — the look back is over: X had nothing older, or it reached the history's start (services/extras.js
//                   pastFloor: your likes reconcile exactly to your history, no further); from now on only
//                   new likes are read
//   reconciled    — false while a FIRST READ reconciles your likes to its history (set by Get started / "how far
//                   back?", web.js), which holds the Inbox behind the progress page until it's true, so nothing shows
//                   as owing a like you gave. Unset on accounts from before: never held.
const LikesSchema = new mongoose.Schema(
  {
    backfillToken: String,
    backfillRead: { type: Number, default: 0 },
    backfillDone: { type: Boolean, default: false },
    reconciled: Boolean,
  },
  { _id: false }
);

// One per account: `_id` is the account's X user id (models/Account.js).
const SyncStateSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    own: { type: StreamSchema, default: () => ({}) },
    mention: { type: StreamSchema, default: () => ({}) },
    // Posts + mentions read going BACKWARDS so far, across all runs: backfill stops when this reaches
    // Account.history.budget. Forward reads (new posts) don't count against it.
    backfillRead: { type: Number, default: 0 },
    likes: { type: LikesSchema, default: () => ({}) },
    // THE RESUME READ (services/pause.js): after a pause, "how far back?" into what was missed, read forward from now to
    // the moment chosen (the streams' bookmarks were set to it). Present while it runs; it holds the Inbox behind the
    // progress page like a first read (features.firstReadGoing) until the posts are read and your likes reconcile to the
    // same moment. `floorId`: that moment as an X id (lib/xid.js; null = everything since the pause: your likes then read
    // back to the last one stored); `budget`: the posts the option was priced on (the run's read cap, sync.js runReadCap);
    // `read` / `likesRead`: so far (the progress page); `likesDone`: your likes are reconciled.
    resume: {
      type: new mongoose.Schema({ floorId: String, budget: Number, read: Number, likesRead: Number, likesDone: Boolean, at: Date }, { _id: false }),
      default: undefined,
    },
    // READ FURTHER BACK's stage (services/further.js): "posts" (the streams reopened past the old depth), "likes" (your
    // likes' look back reopened to the new start), "done" (finishing this run). Unset otherwise.
    furtherStage: { type: String, enum: ["posts", "likes", "done"] },
    lastRunAt: Date,
    // The follow reconciler (services/following.js): when the accounts this one follows were last read, how many this
    // walk has read, and whether it reached the list's end (`complete`: only then is someone missing from it known to be
    // unfollowed). `next`: X's page marker where a partial walk stopped (THE REST reads on from it); `walkAt`: when the
    // walk began from the top. `want`: a read asked for and not finished, which the worker runs
    // (services/followingReads.js): its choice, cap and quote (`ceilingUsd`, X's cost, across every attempt; `spentUsd`
    // so far), how many it has read, and when to try again after X stopped it.
    following: {
      listedAt: Date,
      read: Number,
      complete: Boolean,
      next: String,
      walkAt: Date,
      want: {
        type: new mongoose.Schema(
          { key: String, budget: Number, cap: Number, ceilingUsd: Number, spentUsd: Number, readNow: Number, tries: Number, top: Boolean, restarted: Boolean, at: Date, retryAt: Date },
          { _id: false }
        ),
        default: undefined,
      },
    },
    // The run lock (services/sync.js acquire): set while a run is in progress, expires on its own if a run crashes.
    runningUntil: Date,
  },
  { versionKey: false }
);

module.exports = mongoose.model("SyncState", SyncStateSchema);
