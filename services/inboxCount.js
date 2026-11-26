// THE INBOX TAB'S RED COUNT: the likes and replies you still owe in the Inbox (services/inbox.js owedCount: the rail's
// Everyone, the same rule), kept on the account (Account.inboxOwed) so every page's header shows it with no work
// (counting is a whole Inbox computation, too much per page view), recomputed when something that can change it
// happens, and pushed to the account's open tabs (LiveEvent "count" { tab: "inbox", n } → services/livePush.js →
// public/js/live.js) only when it moved. Server-side, hydrated on render, live after. The Likes and Follows tabs'
// counts are services/unseenCount.js, the same shape. (It used to count cards Waiting; now it's the likes
// and replies owed, which a ♥ or a reply moves.)
//
// Recomputed by: the end of every sync run (services/sync.js runSync: your likes and replies from X), a live reply /
// mention / quote and a live like of yours (services/live.js ingest), a ♥ or a reply sent from xtoolio, and Mark done /
// Reopen / Mark all done (routes/inbox.js). Over just the posts it needs, each by index: the incoming ones, your posts in
// their conversations (your replies), and your likes of them.
"use strict";

const Account = require("../models/Account");
const Post = require("../models/Post");
const Like = require("../models/Like");
const SyncState = require("../models/SyncState");
const InboxMark = require("../models/InboxMark");
const LiveEvent = require("../models/LiveEvent");
const { owedCount } = require("./inbox");
const { EXCHANGE_FIELDS } = require("./people");
const { visibleTo, VISIBILITY_FIELDS } = require("./accountData");
const { active } = require("./features");
const { startFor } = require("./inboxStart");

const { timeOf } = require("../lib/xid");
// The time an X id was minted (lib/xid.js), a second early: X's created_at is whole seconds, so this filter is a
// superset and incomingCards' own id check decides.
const sinceOfId = (id) => new Date(timeOf(id).getTime() - 1000);

// Recompute one account's count; save it and tell its open tabs when it changed. → the count, or null (no account).
async function refreshOwed(accountId) {
  const [acct, sync] = await Promise.all([Account.findById(accountId, "createdAt features tokens.scope inboxOwed inboxFrom inboxWithin").lean(), SyncState.findById(accountId, "mention.oldestId lastRunAt").lean()]);
  if (!acct) return null;
  const startId = await startFor(acct, sync); // THE start the Inbox draws from (services/inboxStart.js)
  const [incoming, marks] = await Promise.all([
    // Someone else replying to, mentioning or quoting the account (people.exchangeWith "in"), each by its own index.
    Post.find(
      { authorId: { $ne: accountId }, createdAt: { $gte: sinceOfId(startId) }, $or: [{ inReplyToUserId: accountId }, { "mentions.id": accountId }, { quotedAuthorId: accountId }] },
      `${EXCHANGE_FIELDS} conversationId ${VISIBILITY_FIELDS}`
    ).lean().then((posts) => visibleTo(accountId, posts)), // a private account's post the account wasn't shown counts nothing, as the Inbox draws nothing
    InboxMark.marksFor(accountId),
  ]);
  const [yours, likes] = await Promise.all([
    // Your replies to them: your posts in their conversations (by conversationId's index).
    Post.find({ conversationId: { $in: [...new Set(incoming.map((p) => p.conversationId).filter(Boolean))] }, authorId: accountId }, "authorId referenced").lean(),
    Like.find({ accountId, likerId: accountId, postId: { $in: incoming.map((p) => p._id) } }, "postId").lean(),
  ]);
  // Your likes are read with People or Liking (the Inbox page's own `likesKnown`, services/conversations.js inboxCards).
  const likesKnown = active(acct, "liking") || active(acct, "people");
  const n = owedCount([...incoming, ...yours], accountId, { marks, startId, liked: new Set(likes.map((l) => l.postId)), likesKnown });
  if (acct.inboxOwed !== n) {
    await Account.updateOne({ _id: accountId }, { $set: { inboxOwed: n } });
    await LiveEvent.note(accountId, "count", { tab: "inbox", n });
  }
  return n;
}

// For the callers that mustn't fail because of it (a sync, a live event, a button): logged, never thrown.
const refreshOwedSafely = (accountId) => refreshOwed(accountId).catch((e) => console.error(`[inbox] counting what's owed for ${accountId}: ${e.message}`));

module.exports = { refreshOwed, refreshOwedSafely };
