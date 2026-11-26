const mongoose = require("mongoose");

// Something an open page of this account should know now (docs/LIVE.md, hop 2): the worker (or any process) inserts
// a row, the web process's change stream (services/livePush.js) hands it to that account's open tabs over SSE
// (GET /live). The ObjectId is the SSE event id, so a reconnecting tab asks for the rows after the last one it saw.
// Rows say WHAT changed, never how to draw it: the web process renders anything the page shows with the pages' own
// partials. Kept a day.
//   inbox   { postId, conversationId, personId }  someone replied to or mentioned you (live ingest)
//   post    { postId, conversationId }            a post of yours (live ingest: made on X)
//   like    { postId, toYou }                     a like by you, or on your post (toYou; live ingest)
//   follow  { eventId, toYou }                    a follow / unfollow of you (toYou), or by you (live ingest)
//   sync    {}                                    a sync run finished (services/sync.js)
//   balance {}                                    the header's balance moved (a charge, a top-up, X's reading)
//   count   { tab, n }                            a header tab's red number moved: "inbox" (cards Waiting,
//                                                 services/inboxCount.js), "likes" or "follows" (new since you
//                                                 looked, services/unseenCount.js)
//   me      { followers, following }              the header's own counts moved (models/Person.js store: a sync's
//                                                 read of your profile, a live follow event; web.js: your own
//                                                 Follow press)
//   limits  { limits: [{ key, words, ends }] }    X's write windows used up now (services/ratelimits.js): the
//                                                 header's countdown (public/js/limits.js)
//   draft   { postId, conversationId }            the account's agent left a draft reply on a message
//                                                 (services/agentTools.js draft_reply): its line shows in place
//   pull    {}                                    its FIRST READ moved: a page of history read (services/sync.js),
//                                                 or its place in the line changed (services/scheduler.js): the
//                                                 progress page redraws its block (public/js/live.js)
//   following { text } | { done, n }              the follow reconciler's read moved a page (how many so far), or
//                                                 ended (its notice): services/followingReads.js; the Not following
//                                                 back page counts up, then reloads with the toast
// A new type goes in this list too (verify-security fails on a LiveEvent.note type it doesn't have: the note would
// be dropped silently, as the Inbox count's was until its end-to-end check).
const LiveEventSchema = new mongoose.Schema(
  {
    accountId: { type: String, required: true },
    type: { type: String, required: true, enum: ["inbox", "post", "like", "repost", "follow", "sync", "balance", "count", "me", "limits", "draft", "pull", "following"] },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    at: { type: Date, default: Date.now },
  },
  { versionKey: false, collection: "liveevents" }
);
LiveEventSchema.index({ at: 1 }, { expireAfterSeconds: 24 * 3600 });
LiveEventSchema.index({ accountId: 1, _id: 1 }); // a reconnect's "everything after the last id I saw"

// THE way any process says something changed. Best-effort: the change itself already happened, and a page that missed
// the word still shows it on its next load, so a failed note is logged, never thrown.
LiveEventSchema.statics.note = function note(accountId, type, data = {}) {
  if (!accountId) return Promise.resolve();
  return this.create({ accountId: String(accountId), type, data }).catch((e) => console.error(`[live] noting ${type} for ${accountId}: ${e.message}`));
};

module.exports = mongoose.model("LiveEvent", LiveEventSchema);
