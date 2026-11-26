// services/conversations.js — what an account's pages are built from, loaded from the database by account alone (no
// request, no page): the Inbox's cards (THE CONVERSATION ENGINE, inboxCards), one conversation through it
// (conversationCard), a person's history (loadPerson), the leaderboard (boardFor), Your posts' rows (postRowsFor) and
// Follows' (followRowsFor). The pages (web.js) and anything else that answers for an account call these, so there is
// one Inbox, never a second copy that drifts. Nothing here reads from X: it's what the sync already stored.
"use strict";

const SyncState = require("../models/SyncState");
const InboxMark = require("../models/InboxMark");
const Draft = require("../models/Draft");
const Like = require("../models/Like");
const Repost = require("../models/Repost");
const FollowEvent = require("../models/FollowEvent");
const people = require("./people");
const circle = require("./circle");
const inbox = require("./inbox");
const likes = require("./likes");
const follows = require("./follows");
const { accountPosts, postsInConversations, postsById, addQuoted, conversationsWith, profilesFor } = require("./accountData");
const { isOn, active } = require("./features");
const { startFor: inboxStartFor, baseStart } = require("./inboxStart");
const { likersByPost, repostedByYou, writesLeft, signalsFor } = require("./extras");

// The most one bulk press likes (the Inbox's "♥ Like N", a rail row's ♥, a card's): X allows 50 likes in 15 minutes.
const LIKE_ALL_MAX = 50;

// Which like counts People's pages show: "You liked" while the posts you like are read (People, or Liking:
// services/sync.js), "They liked" while likes on your posts arrive (the Likes module).
const likeFacts = (account) => ({ you: active(account, "people") || active(account, "liking"), them: active(account, "likes") });
// Who has a People page (their picture and name open it, services/people.js postView `known`): these ids while the
// People module is on, else nobody, and every name opens on X instead.
const knownFor = (account, ids) => new Set(isOn(account, "people") ? ids : []);
// Everyone the account has exchanged with in `posts` (people.exchangeWith, THE rule the leaderboard ranks by). → [id]
const partnersOf = (posts, meId) => posts.map((p) => people.exchangeWith(p, meId)).filter(Boolean).map((ex) => ex.personId);
// knownFor among `ids` when the caller hasn't the account's posts at hand (the like line's redraw, GET
// /posts/:id/likes-line: its faces must open what the page's did), over a projected read of its posts.
async function knownAmong(account, ids) {
  if (!isOn(account, "people") || !ids.length) return new Set();
  const want = new Set(ids);
  return knownFor(account, partnersOf(await accountPosts(account._id, people.EXCHANGE_FIELDS), account._id).filter((id) => want.has(id)));
}
// Whether to show where you and each person stand ("Follows you", "Mutual"): once any pair is known. The status comes
// with every profile read (models/Follow.js), whatever's switched on; an account X sends none for shows none.
const knowsFollows = (signals) => signals.follows.followers.size + signals.follows.following.size > 0;

// The media keys an account saved from other people's posts (services/mediaLibrary.js save), for the "+ Save" on
// their pictures, or null where the account has no media library (neither the Inbox nor People: no Media page).
const savedMediaOf = (account) => (isOn(account, "inbox") || isOn(account, "people") ? new Set((account.mediaSaved || []).map((s) => s.key)) : null);

// The Inbox's cards for an account (services/inbox.js inboxRows), newest first: the page draws them, and "Mark all
// done" marks the same ones. All of it is data the sync already has: nothing is read from X.
// THE THREAD ABOVE, loaded (inbox.threadAbove draws it): from each of `starts` up what it answers, level by level, to
// the thread's first post, into `byId` (the sync's context pass stored every chain; one query per level for what isn't
// loaded yet, inbox.THREAD_ABOVE_MAX levels at most; stops at a post not stored or `gone`). The Inbox's cards and a
// post's page drawn without one (web.js) both load it here, as `accountId` may see them (accountData.visibleTo: a
// private account's post it wasn't shown ends the walk there). → the posts it added or reached, for their likes /
// profiles.
async function loadThreadAbove(accountId, byId, starts) {
  const upper = [];
  const walked = new Set(starts.map((p) => p._id));
  for (let level = 0, frontier = starts; frontier.length && level < inbox.THREAD_ABOVE_MAX; level++) {
    const parents = [...new Set(frontier.map((p) => people.refOf(p, "replied_to")).filter((id) => id && !walked.has(id)))];
    const missing = parents.filter((id) => !byId.has(id));
    for (const p of await postsById(accountId, missing)) byId.set(p._id, p);
    frontier = parents.map((id) => byId.get(id)).filter((p) => p && !p.gone);
    for (const p of frontier) {
      walked.add(p._id);
      upper.push(p);
    }
  }
  return upper;
}

// THE CONVERSATION ENGINE's loader (services/inbox.js inboxRows): the Inbox's cards by default; `only` (a Set of
// conversation ids) builds just those, and `history` their whole history, what came before the Inbox's start settled
// (a post's page, a person's conversation: conversationCard). `posts`: the account's posts when the caller has them.
// `drawn` (rows → Set of conversation ids): the cards the caller will DRAW (a page of the Inbox, one conversation);
// those get THE THREAD ABOVE their seed (inbox.threadAbove), loaded here and rebuilt by the same engine. Without it no
// card walks (a press recounting the whole Inbox).
async function inboxCards(account, { only = null, history = false, posts: given = null, drawn: drawnOf = null } = {}) {
  const aid = account._id;
  const canLike = active(account, "liking");
  // Where this account's Inbox starts (services/inboxStart.js): nothing after it expires; before it, settled. A
  // conversation drawn whole (`history`) ignores the Last 24 hours window, a view of the Inbox: older replies still
  // waiting say so there.
  const [posts, signals, inboxStart] = await Promise.all([given || accountPosts(aid), signalsFor(aid), (history ? baseStart : inboxStartFor)(account)]);
  const startId = history ? "0" : inboxStart;
  const recentIn = posts.filter((p) => (!only || only.has(p.conversationId || p._id)) && BigInt(p._id) >= BigInt(startId) && (people.exchangeWith(p, aid) || {}).dir === "in");
  const byId = new Map(posts.map((p) => [p._id, p]));
  // What they replied to and what they quote, when it isn't one of the account's own posts.
  const refs = [...new Set(recentIn.flatMap((p) => (p.referenced || []).map((r) => r.id)))].filter((id) => !byId.has(id));
  for (const p of await postsById(aid, refs)) byId.set(p._id, p);
  const above = recentIn.flatMap((p) => (p.referenced || []).map((r) => byId.get(r.id))).filter(Boolean);
  // Likes on EVERY post a card draws: their posts, your replies to them, and what they answered or quoted (`above`: the
  // seed panel, often a post of yours). The seed used to be left out: a like on it showed when it arrived
  // live (live.js fetches that post's own line) and was gone on reload, though stored.
  const inIds = new Set(recentIn.map((p) => p._id));
  const yours = posts.filter((p) => p.authorId === aid && (p.referenced || []).some((r) => r.type === "replied_to" && inIds.has(r.id)));
  // And what any of those quote: the step above loads only one level, so a seed of yours quoting someone else's post
  // (stored, in another conversation) drew no quote card at all.
  const drawn = [...recentIn, ...above, ...yours];
  await addQuoted(aid, byId, drawn);
  const quotes = drawn.map((p) => byId.get(people.refOf(p, "quoted"))).filter(Boolean);
  const canRepost = active(account, "reposting");
  const [likers, profiles, reposted] = await Promise.all([
    likersByPost(aid, [...new Set([...inIds, ...yours.map((p) => p._id), ...above.map((p) => p._id)])]),
    profilesFor([aid, ...recentIn.map((p) => p.authorId), ...above.map((p) => p.authorId), ...quotes.map((p) => p.authorId)].filter(Boolean)),
    canRepost ? repostedByYou(aid, [...inIds, ...above.map((p) => p._id)]) : new Set(), // the ↻'s state
  ]);
  await addLikeFaces(profiles, likers, aid);
  const names = people.usernameMap(posts);
  const rankOf = new Map(people.leaderboard(posts, aid, profiles, signals).map((r, i) => [r.id, i + 1]));
  const [marks, drafts] = await Promise.all([InboxMark.marksFor(aid), Draft.draftsFor(aid)]);
  // Your likes are read with People or Liking (services/extras.js runLikes): only then can a message be known to owe one.
  const likesKnown = canLike || active(account, "people");
  // Where you and each writer stand, beside their name (only once any pair is known: knowsFollows).
  const follows = knowsFollows(signals) ? signals.follows : null;
  const opts = { byId, profiles, names, likers, canLike, reposted, canRepost, likesKnown, rankOf, known: knownFor(account, rankOf.keys()), marks, startId, only, doneBefore: history ? inboxStart : null, follows, mediaSaved: savedMediaOf(account), drafts };
  let rows = inbox.inboxRows(posts, aid, opts);
  // THE THREAD ABOVE, for the cards the caller draws: up from each one's seed (the topic's last post: what the first of
  // them answered), their likes, faces and ↻ state added to the same maps, then those cards rebuilt by the same engine.
  const want = drawnOf ? drawnOf(rows) : null;
  if (want && want.size) {
    const seeds = rows.filter((r) => want.has(r.conversationId) && r.topic.length).map((r) => byId.get(r.topic[r.topic.length - 1].id)).filter(Boolean);
    const upper = await loadThreadAbove(aid, byId, seeds);
    if (upper.length) {
      const ids = upper.map((p) => p._id);
      await addQuoted(aid, byId, upper);
      const [moreLikers, moreProfiles, moreReposted] = await Promise.all([
        likersByPost(aid, ids),
        profilesFor([...new Set([...upper, ...upper.map((p) => byId.get(people.refOf(p, "quoted"))).filter(Boolean)].map((p) => p.authorId).filter((id) => id && !profiles.has(id)))]),
        canRepost ? repostedByYou(aid, ids) : new Set(),
      ]);
      for (const [k, v] of moreLikers) likers.set(k, v);
      for (const [k, v] of moreProfiles) profiles.set(k, v);
      for (const id of moreReposted) reposted.add(id);
      await addLikeFaces(profiles, likers, aid);
    }
    const redrawn = new Map(inbox.inboxRows(posts, aid, { ...opts, only: want, withThread: true }).map((r) => [r.conversationId, r]));
    rows = rows.map((r) => redrawn.get(r.conversationId) || r);
  }
  return { rows, canLike, likesKnown, follows: signals.follows };
}

// A CARD'S OWN BULK LIKE (partials/card-presses.hbs): what each card still owes a like (`n`, as its post
// row counts it: `owedSplit.like`) and how many one press likes now (`likeNOf`). Seen through a person (the rail; the
// rail's like count for someone was once missing from their card), only theirs in that card: `person` goes with the press, and its numbers' key is "post-<id>-<person>".
const withCardLike = (cards, person, likeNOf) =>
  cards.map((r) => {
    const theirs = person ? r.owed.find((w) => w.id === person) : null;
    const n = person ? (theirs ? theirs.like : 0) : r.owedSplit.like;
    const key = person ? `post-${r.conversationId}-${person}` : `post-${r.conversationId}`;
    return { ...r, cardLike: n ? { n, key, person, likeN: likeNOf({ post: r.conversationId, person }) } : null };
  });

// ONE CONVERSATION THROUGH THE ENGINE (a post's page and a person's conversation show exactly the card
// the Inbox shows, with the same presses, since the Inbox is where the work happens): the Inbox's card for it, whole (what came before
// the Inbox's start settled), with its card head (♥ Like N, Mark done), the follow line ("N people wrote here · Follow
// back N"), each reply's ♥, ↻, Reply and Mark done, as the Inbox's one-post view draws it. A post of yours' page and a
// person's conversation both draw it (views/conversation.hbs). What the card's presses read off the page: `list` (the
// view they answer for: one post, All), `upTo`. → { card, list, upTo, threadFollow } | null: nobody else wrote in it
// (a post nobody answered, a reply of yours nobody answered back), so there's no card to draw.
// `person` (a post's page's rail, /posts/:id?person=): the card seen through one of its writers, EVERY message of
// theirs in view (inbox.focusOn `every`), the rest folded in place; its ♥ Like N and Done theirs alone, as the Inbox's
// person view. Someone who didn't write in it: the whole card. `likesKnown`: the rail's ♥ column (rail-row.hbs).
async function conversationCard(account, conversationId, { posts = null, person = "" } = {}) {
  const only = new Set([conversationId]);
  const { rows, follows, likesKnown } = await inboxCards(account, { only, history: true, posts, drawn: () => only }); // drawn: THE THREAD ABOVE
  const whole = rows[0];
  if (!whole) return null;
  const who = person && whole.people.includes(person) ? person : "";
  const row = who ? inbox.focusOn(whole, who, { every: true }) : whole;
  const list = { q: "", person: who, post: conversationId, by: "posts", show: "all" };
  const upTo = String(row.latestId);
  const allow = active(account, "liking") ? await writesLeft(account._id, "like") : null;
  const likeNOf = (scope) => (allow ? Math.min(inbox.likeTargets([row], { person: scope.person, upTo: BigInt(upTo) }).length, allow.left, LIKE_ALL_MAX) : 0);
  const [card] = allow && allow.left ? withCardLike([row], who, likeNOf) : [row];
  // THE OWED TABLE (partials/owed-model.hbs), the Inbox's: this card's messages still owed, the page's numbers off it.
  const owedModel = { entries: inbox.owedModel([whole], only), person: who, post: conversationId, allow, max: LIKE_ALL_MAX };
  return { card, list, upTo, likesKnown, owedModel, threadFollow: await threadFollowFor(account, whole, follows, list) };
}

// FOLLOW A THREAD's line (views/partials/thread-follow.hbs, a post's view: `?post=`) for one card: who wrote in it and
// isn't followed (inbox.followTargets), how many of them follow you, and how many follows X allows now
// (extras.writesLeft "follow"). null without Following active, or no such card.
const FOLLOW_ALL_MAX = 50;
// THE FOLLOW LINE (partials/thread-follow.hbs) for any group of people: `who` { n, did } ("5 people wrote here"),
// `all` (ids you don't follow) and `back` (of them, those who follow you), the press's `action` and its hidden
// `fields`. null without Following active. A thread's writers (threadFollowFor) draw it.
// `faces`: WHO a press would follow, to look at first: up to FOLLOW_FACES of them, those who follow you first, each opening their X profile, then "+N".
const FOLLOW_FACES = 5;
async function followLine(account, { who, all, back, action, fields }) {
  if (!active(account, "following")) return null;
  const backs = new Set(back);
  const shown = [...all].sort((a, b) => backs.has(b) - backs.has(a)).slice(0, FOLLOW_FACES);
  const [allow, profiles] = await Promise.all([writesLeft(account._id, "follow"), profilesFor(shown)]);
  const cap = Math.min(allow.left, FOLLOW_ALL_MAX);
  const faces = { people: shown.map((id) => { const p = profiles.get(id); return { id, username: (p && p.username) || null, profile: p || null }; }), more: Math.max(0, all.length - shown.length) };
  return { who, all: all.length, back: back.length, allN: Math.min(all.length, cap), backN: Math.min(back.length, cap), ...allow, action, fields, faces };
}
const fieldsOf = (pairs) => pairs.filter(([, value]) => value).map(([name, value]) => ({ name, value }));
async function threadFollowFor(account, row, follows, list) {
  if (!row) return null;
  const t = inbox.followTargets(row, follows);
  return followLine(account, { who: { n: row.people.length, did: "wrote here" }, ...t, action: "/inbox/follow-all", fields: fieldsOf([["post", row.conversationId], ["by", list.by], ["show", list.show]]) });
}

// THE leaderboard of an account, with profiles and its likes / follows facts: Your people and Your circle.
async function boardFor(account) {
  const aid = account._id;
  const [posts, signals] = await Promise.all([accountPosts(aid), signalsFor(aid)]);
  const personIds = partnersOf(posts, aid);
  return { rows: people.leaderboard(posts, aid, await profilesFor(personIds), signals), signals };
}

// YOUR CIRCLE's members at `sizeKey` (services/circle.js members: the closeness order, likes on your posts included),
// with the profiles of the people who are in it only by liking (they aren't on the board, so it had none). THE door for
// the circle page and its share / size presses; the sync's profile pass keeps a public circle by the same rule.
async function circleFor(account, sizeKey) {
  const { rows, signals } = await boardFor(account);
  const members = circle.members(rows, sizeKey, signals.likes.ofYou);
  const missing = members.filter((m) => !m.profile).map((m) => m.id);
  if (missing.length) {
    const profiles = await profilesFor(missing);
    for (const m of members) if (!m.profile && profiles.has(m.id)) Object.assign(m, { profile: profiles.get(m.id), username: profiles.get(m.id).username || null });
  }
  return { rows, members };
}

// What YOUR POSTS draws on (services/likes.js): the account's own posts (and any post of yours someone liked or
// reposted that only Live stored), the likes and reposts on them by others, the replies to them; `postId` narrows it
// to one post (the row a live like redraws). Nothing is read from X. → { mine, likes, reposts, replies, byId, names,
// known }
async function yourPostsData(account, postId = null) {
  const aid = account._id;
  const only = postId ? { postId } : {};
  const [posts, likeRows, repostRows] = await Promise.all([
    accountPosts(aid),
    Like.find({ accountId: aid, authorId: aid, likerId: { $ne: aid }, ...only }, "postId likerId seenAt likedAt viewedAt").lean(),
    Repost.find({ accountId: aid, authorId: aid, reposterId: { $ne: aid }, ...only }, "postId reposterId seenAt repostedAt").lean(),
  ]);
  const own = posts.filter((p) => p.stream === "own" && p.authorId === aid && (!postId || p._id === postId));
  const have = new Set(own.map((p) => p._id));
  const missing = [...new Set([...likeRows, ...repostRows].map((l) => l.postId))].filter((id) => !have.has(id));
  const extra = (await postsById(aid, missing)).filter((p) => p.authorId === aid);
  const mine = [...own, ...extra];
  const ids = new Set(mine.map((p) => p._id));
  const replies = posts.filter((p) => p.authorId !== aid && ids.has(people.refOf(p, "replied_to")));
  const byId = new Map([...posts, ...extra].map((p) => [p._id, p]));
  await addQuoted(aid, byId, mine); // what they quote
  // Who has a People page (their picture opens it): everyone you've exchanged with, while People is on.
  const known = knownFor(account, partnersOf(posts, aid));
  return { mine, likes: likeRows, reposts: repostRows, replies, byId, names: people.usernameMap(posts), known };
}
// Its rows (services/likes.js postRows), the latest activity first; `postId` → that one row; `quiet` → the replies
// that drew nothing too (the agent's your_posts).
async function postRowsFor(account, { seenBefore = null, postId = null, quiet = false } = {}) {
  const d = await yourPostsData(account, postId);
  const faces = [...d.likes.map((l) => l.likerId), ...d.reposts.map((r) => r.reposterId), ...d.replies.map((p) => p.authorId)];
  const profiles = await profilesFor([account._id, ...new Set(faces)]);
  return likes.postRows(d.mine, { meId: account._id, ...d, profiles, seenBefore, quiet });
}

// Stored posts by id, as THE post view (people.postView) with their authors' profiles: what a few rows point at and
// didn't load (the posts your replies answer, for the agent's your_posts). Only posts the caller already reached
// through this account's own rows. → Map id → postView
async function postViewsOf(account, ids) {
  const posts = await postsById(account._id, ids);
  const views = await viewsOf(account, posts);
  return new Map(posts.map((p, i) => [p._id, views[i]]));
}

// THE post view of a few posts drawn on their own, outside a card (a post of yours with no card and what it answers,
// a bubble placed live, a sent reply, postViewsOf), WITH what they quote and their like lines' faces: postView draws a
// quote card only from byId and drops the quote's link from the text either way, so a post drawn without its quoted
// post loaded showed neither. `byId`: posts already loaded (the thread above). → [postView], in the order given.
async function viewsOf(account, posts, { byId = new Map() } = {}) {
  if (!posts.length) return [];
  const aid = account._id;
  for (const p of posts) byId.set(p._id, p);
  await addQuoted(aid, byId, posts);
  const quotes = posts.map((p) => byId.get(people.refOf(p, "quoted"))).filter(Boolean);
  const [profiles, likers] = await Promise.all([
    profilesFor([aid, ...posts.map((p) => p.authorId), ...quotes.map((p) => p.authorId)].filter(Boolean)),
    likersByPost(aid, posts.map((p) => p._id)),
  ]);
  await addLikeFaces(profiles, likers, aid);
  const known = await knownAmong(account, [...new Set(posts.flatMap((p) => people.likeFaceIds(likers.get(p._id) || [], aid)))]);
  return posts.map((p) => people.postView(p, { meId: aid, byId, profiles, likers, known }));
}

// Follows on the account as the Follows page's rows (services/follows.js followRows), newest first; `eventId` narrows
// it to one (the row a live event draws). Nothing is read from X.
async function followRowsFor(account, { seenBefore = null, eventId = null } = {}) {
  const aid = account._id;
  const events = await FollowEvent.find({ accountId: aid, direction: "in", ...(eventId && { _id: eventId }) }).lean();
  if (!events.length) return [];
  const [posts, signals, profiles] = await Promise.all([accountPosts(aid), signalsFor(aid), profilesFor([...new Set(events.map((e) => e.personId))])]);
  const known = knownFor(account, partnersOf(posts, aid));
  return follows.followRows(events, { profiles, known, follows: signals.follows, seenBefore });
}

// One person, loaded for either view: their leaderboard row and their threads, built from only the account's
// posts plus the conversations shared with them (`only` narrows that to one conversation).
// THE LIKE LINE'S FACES: the profiles of the likers each post's line shows (people.likeFaceIds), into `profiles` (a
// Map, people.postView reads it), only the ones not there yet. Every page that draws conversations calls it.
async function addLikeFaces(profiles, likers, meId) {
  const ids = [...new Set([...likers.values()].flatMap((l) => people.likeFaceIds(l, meId)))].filter((id) => !profiles.has(id));
  if (ids.length) for (const [id, p] of await profilesFor(ids)) profiles.set(id, p);
}
async function loadPerson(aid, personId, only, { canLike = false, canRepost = false, mediaSaved = null } = {}) {
  const [posts, state, signals] = await Promise.all([accountPosts(aid), SyncState.findById(aid, "lastRunAt").lean(), signalsFor(aid)]);
  let conversations = conversationsWith(posts, aid, personId);
  if (only) conversations = conversations.filter((c) => c === only);
  const threadPosts = await postsInConversations(aid, conversations);
  const profiles = await profilesFor([aid, personId, ...threadPosts.map((p) => p.authorId).filter(Boolean)]);
  const board = people.leaderboard(posts, aid, profiles, signals);
  const person = board.find((r) => r.id === personId);
  const likers = person ? await likersByPost(aid, threadPosts.map((p) => p._id)) : new Map();
  await addLikeFaces(profiles, likers, aid);
  const reposted = person && canRepost ? await repostedByYou(aid, threadPosts.map((p) => p._id)) : new Set();
  const known = new Set(board.map((r) => r.id)); // who has a People page (their picture and name open it)
  const follows = knowsFollows(signals) ? signals.follows : null; // where you and each writer stand, beside their name
  return { state, person, posts, showFollows: !!follows, threads: person ? people.threads(threadPosts, aid, personId, profiles, { likers, canLike, reposted, canRepost, known, follows, mediaSaved }) : [] };
}

module.exports = {
  LIKE_ALL_MAX,
  FOLLOW_ALL_MAX,
  likeFacts,
  knownFor,
  knownAmong,
  knowsFollows,
  savedMediaOf,
  inboxCards,
  loadThreadAbove,
  withCardLike,
  conversationCard,
  threadFollowFor,
  boardFor,
  circleFor,
  postRowsFor,
  postViewsOf,
  viewsOf,
  followRowsFor,
  addLikeFaces,
  loadPerson,
};
