// One account's slice of the shared post store, shaped for services/people.js: every post carries `stream`
// ("own" | "mention" | "context") as THIS account sees it (Post.streamFor). The pages (web.js) and the sync's
// context and profile passes all load through here, so "what is this account's data" has one definition.
//
// Queries are by index (accounts.id, conversationId, _id), never "every post": the store is shared by all
// accounts.
"use strict";

const Post = require("../models/Post");
const Person = require("../models/Person");
const { POST_FIELDS, exchangeWith } = require("./people");

const as = (accountId) => (p) => ({ ...p, stream: Post.streamFor(p, accountId) });

// PRIVATE ACCOUNTS: the store is shared, so a post one account's read brought in sits
// in every conversation it belongs to, and X shows a protected account's posts only to its approved followers. A
// post by a PRIVATE account (`Person.protected`) is drawn for an account only when X showed it to that account: its own
// read (`accounts`, a timeline or mentions read), a context read or live event of its own (`seenBy`, sync.storeContext),
// or it wrote it. Everything else (public authors, and authors not looked up yet, whose profile the next profile pass
// reads) is drawn as before. EVERY loader of posts for an account's pages, its agent and its counts goes through this:
// accountPosts, postsInConversations, postsById (and addQuoted / loadThreadAbove / postViewsOf / the like line on it).
// Known gap: a post read before `seenBy` existed has none, so a private author's context post from then is hidden
// even from the follower who read it (production had none when this shipped).
const VISIBILITY_FIELDS = "authorId accounts seenBy";
const shownTo = (p, accountId) => p.authorId === accountId || (p.accounts || []).some((a) => a.id === accountId) || (p.seenBy || []).includes(accountId);
async function visibleTo(accountId, posts) {
  const unsure = [...new Set(posts.filter((p) => p.authorId && !shownTo(p, accountId)).map((p) => p.authorId))];
  if (!unsure.length) return posts;
  const hidden = new Set((await Person.find({ _id: { $in: unsure }, protected: true }, "_id").lean()).map((p) => p._id));
  return hidden.size ? posts.filter((p) => !hidden.has(p.authorId) || shownTo(p, accountId)) : posts;
}
const withVisibility = (fields) => `${fields} ${VISIBILITY_FIELDS}`;

// Stored posts by id, as THIS account may see them (visibleTo). → [post]
async function postsById(accountId, ids, fields = POST_FIELDS) {
  const want = [...new Set(ids.filter(Boolean))];
  return want.length ? visibleTo(accountId, await Post.find({ _id: { $in: want } }, withVisibility(fields)).lean()) : [];
}

// The account's posts plus every stored post addressed to it: its timeline and mentions feeds, AND anything that
// replies to or mentions it that arrived as thread context (X's mentions feed only reaches back ~800 mentions,
// so older replies to you are often only here), and anything quoting its posts. Same set exchangeWith counts from.
async function accountPosts(accountId, fields = POST_FIELDS) {
  const query = { $or: [{ "accounts.id": accountId }, { inReplyToUserId: accountId }, { "mentions.id": accountId }, { quotedAuthorId: accountId }] };
  return (await visibleTo(accountId, await Post.find(query, withVisibility(fields)).lean())).map(as(accountId));
}

// Every stored post in the given conversations, plus anything they reference that sits outside them (a quoted
// post, a `gone` placeholder, which has no conversationId), so threads() can walk every chain and show every quote.
async function postsInConversations(accountId, conversationIds) {
  const inThreads = await visibleTo(accountId, await Post.find({ conversationId: { $in: conversationIds } }, withVisibility(POST_FIELDS)).lean());
  const have = new Set(inThreads.map((p) => p._id));
  const refs = [...new Set(inThreads.flatMap((p) => (p.referenced || []).map((r) => r.id)))].filter((id) => !have.has(id));
  return [...inThreads, ...(await postsById(accountId, refs))].map(as(accountId));
}

// THE QUOTE CARDS' POSTS: every post `shown` quotes that `byId` doesn't have yet, read into it (by _id, one query).
// postView draws a quote card only from byId, and drops the quote's link from the text either way, so a quote
// missing here showed NOTHING: an Inbox seed of yours quoting someone (the quoted post was stored, in
// another conversation, and the Inbox loaded only one step out).
// Pages that draw posts from a hand-picked set call this on what they draw (the Inbox, Likes); postsInConversations
// already brings every reference.
async function addQuoted(accountId, byId, shown) {
  const ids = [...new Set(shown.flatMap((p) => (p.referenced || []).filter((r) => r.type === "quoted").map((r) => r.id)))].filter((id) => !byId.has(id));
  for (const p of await postsById(accountId, ids)) byId.set(p._id, p);
  return byId;
}

// The conversations this account has exchanges with one person in.
function conversationsWith(posts, accountId, personId) {
  const ids = new Set();
  for (const p of posts) {
    const ex = exchangeWith(p, accountId);
    if (ex && ex.personId === personId) ids.add(p.conversationId || p._id);
  }
  return [...ids];
}

const PERSON_FIELDS = "username name image bio bioUrls location website joinedAt followers following verified verifiedType protected gone fetchedAt";

// Map of id → Person for just these ids.
async function profilesFor(ids) {
  const people = await Person.find({ _id: { $in: [...new Set(ids)] } }, PERSON_FIELDS).lean();
  return new Map(people.map((p) => [p._id, p]));
}

module.exports = { accountPosts, postsInConversations, postsById, visibleTo, VISIBILITY_FIELDS, addQuoted, conversationsWith, profilesFor };
