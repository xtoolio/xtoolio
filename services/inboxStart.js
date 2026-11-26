// WHERE AN ACCOUNT'S INBOX STARTS (a new big account's first Inbox held ~640 replies waiting; it opens with
// 20, and a Load more right in the Inbox). A new account (Get started sets `Account.inboxFrom.want`)
// opens with its NEWEST 20 REPLIES (replies, mentions and quotes to it, the unit the red count counts; people.exchangeWith
// "in", as THIS account may see them: accountData.visibleTo), fixed once its first read is done (`inboxFrom.id`, an X
// id: recomputing it as replies arrive would drop older cards out of the Inbox). What came before is settled, as before
// the start always was: it shows on its post's page and in People, owing nothing. "Load 20 earlier replies" at the foot
// of the Inbox's last page (`POST /inbox/more`) moves the start back by the next 20, down to THE REACH: the oldest
// mention X gave the sync (SyncState.mention.oldestId; before it, the replies you never answered aren't known, so the
// ones that are would all look answered-by-you or wrongly waiting).
// Accounts from before (no `inboxFrom`) keep inbox.inboxStart (a week before the Inbox was first turned on) unchanged.
// THE start for every door: the Inbox's cards (services/conversations.js), its red count (services/inboxCount.js), and
// so the agent's inbox tool.
"use strict";

const Account = require("../models/Account");
const Post = require("../models/Post");
const SyncState = require("../models/SyncState");
const inbox = require("./inbox");
const { exchangeWith, EXCHANGE_FIELDS } = require("./people");
const { visibleTo, VISIBILITY_FIELDS } = require("./accountData");
const { firstOn, pullDue } = require("./features");

const FIRST_REPLIES = 20; // a new Inbox opens with this many
const MORE_REPLIES = 20; // each "Load earlier replies" adds this many

const big = (id) => BigInt(id || "0");
const { idNow, idAt } = require("../lib/xid"); // an X id minted now, or at a moment
const later = (a, b) => (big(a) > big(b) ? String(a) : String(b));

// Where a start of `n` replies lands, given the incoming replies' ids NEWEST FIRST: the n-th one's id (it and every
// newer one are in), or `reach` when there are n or fewer. Pure.
const startAt = (idsDesc, n, reach) => (idsDesc.length > n ? idsDesc[n - 1] : String(reach || "0"));

// THE incoming replies to the account (someone else's post replying to, mentioning or quoting it: exchangeWith "in"),
// as it may see them, from `from` (inclusive) to `before` (exclusive; none = up to now), newest first, as ids.
async function incomingIds(accountId, { from = "0", before = null } = {}) {
  const posts = await Post.find(
    { authorId: { $ne: accountId }, $or: [{ inReplyToUserId: accountId }, { "mentions.id": accountId }, { quotedAuthorId: accountId }] },
    `${EXCHANGE_FIELDS} ${VISIBILITY_FIELDS}`
  ).lean();
  const lo = big(from);
  const hi = before ? big(before) : null;
  return (await visibleTo(accountId, posts))
    .filter((p) => (exchangeWith(p, accountId) || {}).dir === "in" && big(p._id) >= lo && (hi === null || big(p._id) < hi))
    .map((p) => p._id)
    .sort((a, b) => (big(b) > big(a) ? 1 : big(b) < big(a) ? -1 : 0));
}

const syncOf = (accountId) => SyncState.findById(accountId, "mention.oldestId lastRunAt").lean();
const reachOf = (sync) => (sync && sync.mention && sync.mention.oldestId) || "0";

// THE INBOX'S WINDOW (`Account.inboxWithin`, the Inbox toolbar's "Last 24 hours", routes/inbox.js): the start moved up
// to that long ago, never back, so every door the start feeds (the cards, the rail, the red count, the agent's inbox)
// shows only what came in since; "Load earlier replies" has nothing to do meanwhile. Unset: the start as it is. It's a
// VIEW of the Inbox, never a statement that older replies are done: a conversation drawn whole (a post's page, a
// person's conversation, the agent's `conversation`) settles only what's before `baseStart`, so a reply still waiting
// says so there with the window on. Nothing reads less from X for it.
// No prototype: a posted "__proto__" or "constructor" is no window (it passed the route's check and broke the start).
const WITHIN = Object.assign(Object.create(null), { "1d": 24 * 3600 * 1000 });

// THE start (an X id): replies from it on are the Inbox. `account` needs createdAt, features, inboxFrom, inboxWithin. A
// new account whose first read just finished gets its newest-20 start fixed here, once (a conditional write: two pages
// at once agree). → String
async function startFor(account, sync = null) {
  const start = await baseStart(account, sync);
  const ms = WITHIN[account.inboxWithin];
  return ms ? later(start, idAt(Date.now() - ms)) : start;
}

// The start without the window.
async function baseStart(account, sync = null) {
  sync = sync || (await syncOf(account._id));
  const old = inbox.inboxStart({ joinedAt: firstOn(account, "inbox"), oldestMentionId: sync && sync.mention && sync.mention.oldestId });
  const from = account.inboxFrom;
  if (!from || (!from.id && !from.want)) return old;
  const reach = reachOf(sync);
  if (from.id) return later(from.id, reach);
  // Still reading: nothing is fixed early, and nothing counts yet (the pages show the progress; a live reply during the
  // read mustn't put the old week's hundreds on the red count for a minute): the start is now.
  if (pullDue(account, sync)) return idNow();
  const id = later(startAt(await incomingIds(account._id, { from: reach }), from.want, reach), reach);
  await Account.updateOne({ _id: account._id, "inboxFrom.want": from.want, "inboxFrom.id": { $exists: false } }, { $set: { "inboxFrom.id": id } });
  const now = await Account.findById(account._id, "inboxFrom").lean();
  return later((now && now.inboxFrom && now.inboxFrom.id) || id, reach);
}

// How many earlier replies "Load earlier replies" would add now (at most MORE_REPLIES; 0: none left above the reach,
// or an account from before, whose start doesn't move). Nothing while READ FURTHER BACK runs (services/further.js):
// what it reads isn't reconciled with your likes yet, so its cards could show a like you gave as owed. → Number
const loadable = (account) => account.inboxFrom && account.inboxFrom.id && !WITHIN[account.inboxWithin] && !(account.history && account.history.further);
async function moreFor(account, start, sync = null) {
  if (!loadable(account)) return 0;
  sync = sync || (await syncOf(account._id));
  return Math.min(MORE_REPLIES, (await incomingIds(account._id, { from: reachOf(sync), before: start })).length);
}

// "Load earlier replies": the start moved back by the next MORE_REPLIES (never past the reach), from where it is now
// (a double press moves it twice, each by what's there: the button says how many). → how many it added
async function loadMore(account) {
  if (!loadable(account)) return 0;
  const sync = await syncOf(account._id);
  const start = await baseStart(account, sync);
  const reach = reachOf(sync);
  const older = await incomingIds(account._id, { from: reach, before: start });
  if (!older.length) return 0;
  const id = later(startAt(older, MORE_REPLIES, reach), reach);
  await Account.updateOne({ _id: account._id, "inboxFrom.id": account.inboxFrom.id }, { $set: { "inboxFrom.id": id } });
  return Math.min(MORE_REPLIES, older.length);
}

module.exports = { FIRST_REPLIES, MORE_REPLIES, WITHIN, startAt, startFor, baseStart, moreFor, loadMore };
