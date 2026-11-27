// The Inbox (`/`): replies, mentions and quotes since the account's start (inboxStart), as conversation cards you can
// filter (Waiting / Done / All), search, sort and page (services/listing.js, the engine Your people uses). Pure.
//
// Incoming = someone else's post replying to you, mentioning you or quoting you (people.exchangeWith "in", the
// leaderboard's own definition), from the start on, ONE CARD PER CONVERSATION: everyone's replies in it under what it's about,
// shown once (two people answering one long post showed it twice; a card used to be one person in one
// conversation). Every message of theirs has its own "↩ Reply": a
// composer opens right under it, and your answer lands there (people.chatOrder keeps answers under what they answer).
//
// A card is DONE when you marked it done (its "Mark done" button: models/InboxMark.js) and nobody has written since;
// Waiting otherwise. Your call, never inferred (you may like and reply, or only like, or only reply): likes and replies show in the card but don't move it. Marked done through the latest incoming
// message, so a new one from anyone makes it wait again. (Before: Done was inferred from a like or reply on their
// latest, with a "Done when liked or replied" switch; a like there looked like nothing happened.)
//
// Nothing expires: a card waits until you mark it done (inboxStart says where it begins and why). "Mark all done" is the
// way out of a backlog.
"use strict";

const { exchangeWith, postView, refOf, displayNameOf, chatOrder, runsOf, foldChat, plainLine } = require("./people");
const { createListing } = require("./listing");

const DAY_MS = 24 * 3600 * 1000;
const byIdAsc = (a, b) => (BigInt(a._id) < BigInt(b._id) ? -1 : 1);

// A DRAFT as a message draws it (partials/draft-line.hbs; models/Draft.js): its words, whose it is, and X's own reply
// window with the words already in it (`onX`: the line's link On X and without script; X's web intent takes `text`
// beside `in_reply_to`).
const draftOf = (postId, d) => (d ? { text: d.text, by: d.by || "your agent", at: d.at, onX: `https://x.com/intent/post?in_reply_to=${postId}&text=${encodeURIComponent(d.text)}` } : null);

// Where an account's Inbox STARTS (it was a rolling 7 days, so a card you hadn't answered or marked done
// dropped out of Waiting on day 8: Done is your call, never a timer). Nothing after the start ever expires. The start
// is the later of:
//   - the oldest mention X gave the sync (SyncState.mention.oldestId): X serves only the latest ~800 mentions, so
//     before it the account's replies are known only where you answered them (as thread context), which would show
//     as Waiting cards for conversations you'd long handled;
//   - a week before the account joined: for a quiet account, 800 mentions reach back years, and those shouldn't land
//     in Waiting on day one.
// As an X id (lib/xid.js), compared to post ids. Pure.
const { idAt } = require("../lib/xid");
const START_BEFORE_JOINING_DAYS = 7;
function inboxStart({ joinedAt, oldestMentionId } = {}) {
  const fromJoin = joinedAt ? BigInt(idAt(new Date(joinedAt).getTime() - START_BEFORE_JOINING_DAYS * DAY_MS)) : 0n;
  const fromX = oldestMentionId ? BigInt(oldestMentionId) : 0n;
  return String(fromJoin > fromX ? fromJoin : fromX);
}

// `posts`: the account's posts plus everything addressed to it (accountData.accountPosts, which carries your own
// posts, so your replies are in it). `byId`: Map of every post a card may show (the posts themselves, what they
// replied to, what they quote). `rankOf`: Map person → leaderboard rank (the "People you talk with most" sort).
// `marks`: Map conversation id → what you marked done in it (models/InboxMark.js marksFor; markOf). The rest is
// people.postView's context.
// → rows, newest first: one per conversation, shaped like a conversation's thread (partials/thread.hbs):
// { key, conversationId, people (who wrote in), owed (who still has a like or a reply coming from you on the messages
//   the card shows, as { id, username, profile, rank, n: how many }: the rail, railOf, and its `person` filter; each
//   of their messages in view carries its own `owes` { like, reply }),
//   status ("waiting" | "done"), id, topic (the thread above the seed, oldest first, then the seed LAST; the middle of
//   a long thread `folded`, topicFold { n }),
//   dialogue (everyone's posts and yours, as chat: people.chatOrder; on a reopened card only what's new),
//   earlier (a reopened card's already-handled messages, folded), replyId (the latest incoming: Mark done covers through it),
//   latestId, closeness, followers, haystack }
// THE Inbox's cards: the incoming posts from the start on (someone else replying to, mentioning or quoting you:
// people.exchangeWith "in"), grouped by conversation, each group oldest first. → Map conversationId → [post]. Pure.
// inboxRows draws them; owedCount counts what they owe: one definition, so the red count can't disagree with the page.
function incomingCards(posts, meId, startId = "0") {
  const start = BigInt(startId);
  const groups = new Map();
  for (const p of posts) {
    if (BigInt(p._id) < start) continue;
    const ex = exchangeWith(p, meId);
    if (!ex || ex.dir !== "in") continue;
    const key = p.conversationId || p._id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  for (const theirs of groups.values()) theirs.sort(byIdAsc);
  return groups;
}

// What you marked done in a card (models/InboxMark.js marksFor: { through, handled }; a bare id means "through it").
// → null | { through: BigInt | null, handled: Set }. Pure.
function markOf(m) {
  if (!m) return null;
  if (typeof m === "string") return { through: BigInt(m), handled: new Set() };
  return { through: m.through ? BigInt(m.through) : null, handled: new Set(m.handled || []) };
}
// Marked done: the thread was marked done through the message or later, or it was marked on its own ("Done with
// <person>"). Pure.
const isHandled = (id, mark) => !!mark && ((mark.through !== null && BigInt(id) <= mark.through) || mark.handled.has(id));

// Your replies, by the post they answer. → Map their post id → [your posts]. Pure.
function answersOf(posts, meId) {
  const answers = new Map();
  for (const p of posts) {
    if (p.authorId !== meId) continue;
    for (const r of p.referenced || []) if (r.type === "replied_to") answers.set(r.id, [...(answers.get(r.id) || []), p]);
  }
  return answers;
}

// THE RULE for one of their messages (the Inbox's Waiting / Done, its fold, the rail, the red count): what it still
// owes you, a like you haven't given and a reply you haven't written, and whether it's DONE: marked done (isHandled),
// or nothing owed, liked AND answered (when each like and reply counts, nothing is left to do with it; a
// like alone or a reply alone moves nothing, as before). Without your likes known (no People or Liking) a
// reply is all it can owe. ctx: { mark (markOf), answers (answersOf), youLiked (id → bool), likesKnown }. (A message
// deleted on X never gets here: once marked `gone`, people.exchangeWith drops it, so it leaves the card and every count.)
// → (post) → { done, owes: { like, reply } | null (done owes nothing) }. Pure.
// `before` (a BigInt id, or null): THE CONVERSATION ENGINE drawing one conversation's whole history (a post's page, a
// person's conversation: inboxRows `doneBefore`): what came before the Inbox's start is settled, done, owing nothing
// (the Inbox never asked you to do it; inboxStart says why it can't know).
function standingOf({ mark, answers, youLiked, likesKnown, before = null }) {
  return (p) => {
    const like = likesKnown && !youLiked(p._id);
    const reply = !answers.has(p._id);
    const done = isHandled(p._id, mark) || (before !== null && BigInt(p._id) < before) || (!like && !reply);
    return { done, owes: done ? null : { like, reply } };
  };
}

// THE INBOX'S RED COUNT (services/inboxCount.js): the likes and replies you still owe, over every card (the rail's
// Everyone with no search: the same rule, so they can't disagree). `posts`: the incoming ones and your replies in their
// conversations (may hold more); `liked`: Set of the post ids you liked. Pure.
function owedCount(posts, meId, { marks = new Map(), startId = "0", liked = new Set(), likesKnown = true } = {}) {
  const answers = answersOf(posts, meId);
  let n = 0;
  for (const [conversationId, theirs] of incomingCards(posts, meId, startId)) {
    const standing = standingOf({ mark: markOf(marks.get(conversationId)), answers, youLiked: (id) => liked.has(id), likesKnown });
    for (const p of theirs) {
      const { owes } = standing(p);
      if (owes) n += (owes.like ? 1 : 0) + (owes.reply ? 1 : 0);
    }
  }
  return n;
}

// THE THREAD ABOVE a card's seed (a card showed your reply and their answer under it, but not the post
// your reply answered, so you couldn't tell what you'd replied to): what the seed itself answers, up the chain to the
// thread's first post, OLDEST FIRST, drawn above the seed X's way (thread.hbs: the topic's posts with the thread line).
// The sync's context pass already stored every chain to its first post (services/sync.js, the context pass), so nothing new is
// read; services/conversations.js loads the levels (THREAD_ABOVE_MAX) for the cards a page DRAWS only (inboxRows
// `withThread`): a press recounting every card never walks. Stops at a post not stored or `gone`. A card shows the
// first and the last (THREAD_ABOVE_SHOWN) and folds the middle ("Show N more replies").
// → [post]. Pure.
const THREAD_ABOVE_MAX = 30; // levels walked: a deeper reply shows its nearest 30, not the thread's very first post
const THREAD_ABOVE_SHOWN = 2;
function threadAbove(seed, byId, max = THREAD_ABOVE_MAX) {
  const out = [];
  const seen = new Set([seed._id]);
  for (let p = seed; out.length < max; ) {
    const up = byId.get(refOf(p, "replied_to"));
    if (!up || up.gone || seen.has(up._id)) break;
    seen.add(up._id);
    out.unshift(up);
    p = up;
  }
  return out;
}

// `known`: who has a People page (their picture and name open it); everyone ranked, unless the caller says (People off:
// nobody, and they open on X).
// `likesKnown`: the sync reads your likes (People or Liking), so a message you haven't liked is known to owe one (the
// rail); without it only replies are counted.
// THE CONVERSATION ENGINE (the Inbox is where the work happens, so a post's page and a conversation with
// one person work the same way): the Inbox's cards, and the same card for one conversation
// anywhere else (a post of yours' page, a person's conversation), by two options: `only` (a Set of conversation ids:
// build just those) and `doneBefore` (an X id: what came before it is settled, standingOf `before`; with startId "0",
// the conversation's whole history). A card wholly before it is `settled`: no Done of its own (it was never in the
// Inbox to be marked), and its messages wear no "✓ Done" (nothing was done; it's history).
function inboxRows(posts, meId, { byId = new Map(), profiles = new Map(), names = new Map(), likers = new Map(), canLike = false, reposted = new Set(), canRepost = false, likesKnown = true, rankOf = new Map(), known = new Set(rankOf.keys()), marks = new Map(), startId = "0", only = null, doneBefore = null, follows = null, mediaSaved = null, drafts = new Map(), withThread = false } = {}) {
  const answers = answersOf(posts, meId); // their post id → your replies to it (shown in the card, on your side)
  const youLiked = (id) => (likers.get(id) || []).includes(meId);
  const before = doneBefore ? BigInt(doneBefore) : null;
  const old = (id) => before !== null && BigInt(id) < before;

  const groups = incomingCards(posts, meId, startId); // conversation → the incoming posts in it, oldest first
  if (only) for (const key of [...groups.keys()]) if (!only.has(key)) groups.delete(key);

  const nameOf = (id) => displayNameOf({ id, username: names.get(id), profile: profiles.get(id) });
  const ctx = (personId) => ({ meId, personId, personName: nameOf(personId), byId, profiles, names, likers, canLike, reposted, canRepost, known, follows, mediaSaved });
  const rows = [...groups.entries()].map(([conversationId, theirs]) => {
    const first = theirs[0];
    const latest = theirs[theirs.length - 1]; // a done mark covers through this; the reply box answers it
    const writers = [...new Set(theirs.map((p) => p.authorId))];
    // The seed: what the first of them answered, once, however many people answered it.
    const parent = byId.get(refOf(first, "replied_to"));
    const seed = parent && !parent.gone ? parent : null;
    // THE THREAD ABOVE the seed (threadAbove), drawn with it at the card's top: only on the cards a page draws
    // (`withThread`, services/conversations.js inboxCards `drawn`), whose chains the loader put in byId.
    const upper = seed && withThread ? threadAbove(seed, byId) : [];
    const atTop = new Set([seed, ...upper].filter(Boolean).map((p) => p._id));
    // Your side of the chat: your replies to them, and any post of yours one of them answered (other than one already at
    // the top: the seed or the thread above it), so a reply further down the thread shows what it answers.
    const mine = theirs.flatMap((p) => answers.get(p._id) || []);
    const answered = theirs.map((p) => byId.get(refOf(p, "replied_to"))).filter((q) => q && q.authorId === meId && !q.gone && !atTop.has(q._id));
    // And YOUR OWN FOLLOW-UPS, as X's thread shows them: a reply of yours to a post of yours in the chat, down the
    // chain; and one to the SEED (when it's yours) posted after the first of theirs, you talking in the conversation
    // (a reply under your own post in someone's thread, a picture in it, was missing: nobody had answered it, and it
    // answers no one else). What you wrote under the seed before anyone answered (a thread of yours, 2/n, 3/n) is the
    // topic, not the back and forth: it stays out.
    const inChat = new Set([...theirs, ...mine, ...answered].map((p) => p._id));
    const followUps = [];
    const walk = (id, after = null) => {
      for (const q of answers.get(id) || []) {
        if (inChat.has(q._id) || q.gone || (after !== null && BigInt(q._id) < after)) continue;
        inChat.add(q._id);
        followUps.push(q);
        walk(q._id);
      }
    };
    for (const p of [...mine, ...answered]) walk(p._id);
    if (seed && seed.authorId === meId) walk(seed._id, BigInt(first._id));
    const chat = [...new Map([...theirs, ...mine, ...answered, ...followUps].map((p) => [p._id, p])).values()].sort(byIdAsc);
    // Each of their messages by THE rule (standingOf): done, or what it still owes. The card is done when every one is;
    // a waiting card folds the done ones away (splitReopened). Done owes nothing, in any tab (one big handled thread
    // someone reopened would otherwise put twenty people on the rail).
    const mark = markOf(marks.get(conversationId));
    const standing = standingOf({ mark, answers, youLiked, likesKnown, before });
    const owes = new Map(theirs.map((p) => [p._id, standing(p).owes]));
    const isDone = (id) => !owes.get(id);
    const status = theirs.every((p) => isDone(p._id)) ? "done" : "waiting";
    const owedBy = new Map();
    const owedSplit = { like: 0, reply: 0 }; // the card's share of the head's "♥ N to like · ↩ N to reply"
    for (const p of theirs) {
      const o = owes.get(p._id);
      if (!o) continue;
      const by = owedBy.get(p.authorId) || { like: 0, reply: 0 };
      owedBy.set(p.authorId, { like: by.like + (o.like ? 1 : 0), reply: by.reply + (o.reply ? 1 : 0) });
      if (o.like) owedSplit.like++;
      if (o.reply) owedSplit.reply++;
    }
    // Whom a post's like line names besides you: its author; for yours, whom it answered (when they're in the card), else
    // EVERYONE who wrote in (the post they're answering: "Did Maya Okafor or Dev Raman like it?").
    const viewOf = (p) => {
      // `doneIn`: a message still waiting gets its own ✓ Done (partials/bubble.hbs → POST /inbox/done `handled`).
      // `finished`: nothing left to do with it (liked and answered, or marked done): it wears a completed ✓ Done instead
      // so a finished reply reads as completed.
      // `draft`: a reply the account's agent drafted for it (models/Draft.js), shown only while it still owes a reply:
      // answered (here or on X) or marked done, the draft simply isn't drawn.
      if (p.authorId !== meId) {
        const o = owes.get(p._id) || null;
        return { ...postView(p, ctx(p.authorId)), owes: o, doneIn: o ? conversationId : null, finished: !o && !old(p._id), draft: o && o.reply ? draftOf(p._id, drafts.get(p._id)) : null };
      }
      if (writers.includes(p.inReplyToUserId)) return postView(p, ctx(p.inReplyToUserId));
      return postView(p, { ...ctx(first.authorId), people: writers });
    };
    // Each message with your answers right under it (chatOrder), each of theirs with its own "↩ Reply".
    const above = seed ? viewOf(seed) : null;
    // THE THREAD ABOVE the seed: context only, so a plain view (nothing owed, no Done), the middle folded.
    const contextView = (p) => postView(p, ctx(p.authorId === meId ? first.authorId : p.authorId));
    const foldsMiddle = upper.length > THREAD_ABOVE_SHOWN;
    const thread = upper.map((p, i) => ({ ...contextView(p), folded: foldsMiddle && i > 0 && i < upper.length - 1 }));
    // A waiting card shows only what isn't done; what is folds into "Show N earlier messages" (`earlier`; first
    // for a card someone reopened; now anything done, marked or liked and answered).
    const ordered = chatOrder(chat.map(viewOf));
    const { earlier, dialogue } = status === "waiting" && theirs.some((p) => isDone(p._id)) ? splitReopened(ordered, isDone, (id) => marks.has(conversationId) && isDone(id)) : { earlier: [], dialogue: ordered };
    // What the card draws: the whole chat in order, `earlier` folded in place (people.foldChat).
    const { chat: drawn, fold } = foldChat(ordered, new Set(earlier.map((v) => v.id)));
    const onlyTagged = !theirs.some((p) => p.inReplyToUserId === meId); // none of them replied to you: posts that only tag you
    return {
      key: conversationId,
      conversationId,
      people: writers,
      owed: [...owedBy].map(([id, o]) => ({ id, username: names.get(id) || (profiles.get(id) && profiles.get(id).username) || null, profile: profiles.get(id) || null, rank: rankOf.has(id) ? rankOf.get(id) : Infinity, n: o.like + o.reply, like: o.like, reply: o.reply })),
      owedSplit,
      // Their replies in it still waiting (not done): what its Done marks, counted in replies (the People view's
      // toolbar, "✓ Done N replies").
      waitingReplies: theirs.filter((p) => !isDone(p._id)).length,
      // What the card is about, for the rail's Posts view (railOfPosts): the post they answered (often yours), else
      // their first message.
      about: aboutOf(above || viewOf(first), meId),
      status,
      settled: theirs.every((p) => old(p._id)), // all before the Inbox's start: history, no Done (partials/card-presses.hbs)
      // The thread partial's shape (`id` is the conversation).
      id: conversationId,
      // The posts the card hangs on, oldest first: the thread above the seed, then the seed (the LAST: the card's box).
      topic: above ? [...thread, above] : [],
      topicFold: foldsMiddle ? { n: upper.length - THREAD_ABOVE_SHOWN } : null,
      // Why it's here. Under a seed, only for posts that only tag you: they were talking to someone else (a reply to
      // you needs no note: the seed above it is yours; nor does a quote: its quote card shows your post; "Quoted your
      // post" above it was removed). With NO seed it's the left of the card's band
      // (partials/inbox-done.hbs), always, from their first post: without it the band was an empty row with only
      // Mark done on it, for a mention that grew a conversation as much as for a quote.
      note: above ? (!onlyTagged || theirs.some((p) => p.quotedAuthorId === meId) ? null : `Mentioned you in a reply to ${displayNameOf(above.author)}`) : first.quotedAuthorId === meId ? "Quoted your post" : first.inReplyToUserId === meId ? "Replied to you" : "Mentioned you",
      // The parts by state (what the rail, bulk like and the tests read: earlier = folded, dialogue = in view, each
      // drawn as its own chat by runsOf), and what partials/thread.hbs draws: `order` (chatOrder's, for focusOn and
      // capCard to fold again), `chat` + `fold` (people.foldChat).
      earlier,
      dialogue,
      order: ordered,
      chat: drawn,
      fold,
      replyId: latest._id, // the latest incoming: "Done" covers through it
      // For the list's sorts and search. Newest by the latest post's id: X's ids are time-ordered and finer than dates.
      latestId: BigInt(latest._id),
      latestAt: latest.createdAt, // when (the phone's list of posts says it)
      closeness: Math.min(...writers.map((id) => (rankOf.has(id) ? rankOf.get(id) : Infinity))),
      followers: Math.max(...writers.map((id) => (profiles.get(id) && profiles.get(id).followers) || 0)),
      // What a search looks in (services/listing.js matches): what the card SHOWS, the writers' names and @handles, the
      // seed's author, and every message's words as drawn (yours too). Never X's raw text: a reply's hidden @-prefix
      // starts with your own handle, so searching it matched every card.
      haystack: [
        ...writers.flatMap((id) => [nameOf(id), names.get(id) || (profiles.get(id) && profiles.get(id).username) || ""]),
        ...(above && above.author && above.author.id !== meId ? [displayNameOf(above.author), above.author.username || ""] : []),
        ...[above, ...ordered].filter(Boolean).flatMap((v) => (v.segments || []).map((s) => (s.media ? "" : s.text || ""))),
      ].join(" "),
    };
  });
  return rows.sort((a, b) => (a.latestId < b.latestId ? 1 : -1));
}

// A waiting card's chat (chatOrder's, in order), split into what's done (`earlier`, folded) and what isn't
// (`dialogue`), by `isDone` (their message id → bool: THE rule, standingOf). Yours go with the message they answer.
// A message still open keeps in view EVERYTHING it answers, up the chain (their message → your reply →
// their answer, all of a back and forth shown, a line only before a different exchange): the post of yours it answers, the message of theirs that post answered, and so on, done or not, so a back
// and forth reads whole. Only what isn't part of an open message's chain folds (the fold's own line then separates a
// different exchange). It was only the post of yours it answered, and only when that wasn't itself an answer to them:
// a liked-and-answered message folded away with your reply, and the new one sat alone under the fold.
// EXCEPT in a card you've MARKED done (`stops`: their message is done and the card has a mark: someone
// answering again in a thread marked done brought the whole thread back): the chain stops at their first done
// message, SHOWING IT when a post of yours stands between: the new reply, your post it answers, and the message of
// theirs your post was answering ("free ones?" says nothing without the "want a sticker pack?" it answered; it was only the new reply and your post, and only a wordless post of yours, a GIF or photo alone, kept the
// message it reacted to). Done for either reason: a reply that arrived after the mark and that you liked and answered is
// as finished. A card never marked still shows a back and forth whole.
// Whatever stops the chain, the message an open one DIRECTLY answers always stays in view, theirs too (a short
// reaction answering someone else's done picture post said nothing alone).
// Each part is drawn as its own chat (people.runsOf: who and when, and the lines, for what's next to what once
// folded); the card draws them in place, folded or not (people.foldChat). Pure.
function splitReopened(chat, isDone, stops = () => false) {
  const byId = new Map(chat.map((v) => [v.id, v]));
  const open = (v) => !v.fromMe && !isDone(v.id);
  const chain = new Set(); // what the open messages answer, up the chain, within the chat
  for (const v of chat.filter(open)) {
    // `keep`: the next one up stays even if it's a done message of theirs (it's what the open message, or your post
    // just below it, answers); past it, the chain stops.
    for (let p = byId.get(v.replyOf), keep = true; p && !chain.has(p.id); ) {
      const stop = !p.fromMe && stops(p.id);
      if (stop && !keep) break;
      chain.add(p.id);
      if (stop) break;
      keep = p.fromMe;
      p = byId.get(p.replyOf);
    }
  }
  const shown = (v) => open(v) || chain.has(v.id);
  const isNew = (v) => shown(v) || (v.fromMe && v.replyOf && byId.has(v.replyOf) && !byId.get(v.replyOf).fromMe && shown(byId.get(v.replyOf)));
  // A post of yours kept only as context sits right above the reply it explains: in the tree (chatOrder) a reply is
  // under what it answers, and what folds between them is hidden. (Until the tree, an "anchored" step moved it there:
  // a busy card had shown your context posts together, their replies far below.)
  return { earlier: runsOf(chat.filter((v) => !isNew(v))), dialogue: runsOf(chat.filter(isNew)) };
}

// A card seen through the rail's person (`?person=`): only their messages that still owe you a like or a reply stay in
// view; everything else in the card (yours, what they'd been answered on, other people's, even ones still owed) folds
// into the card's fold, "Show N other messages", in its usual order (picking someone shows only their
// live messages; everything else folds, even other people's still outstanding). The seed
// stays. Its Done (`focus`) marks just their messages that aren't done (`ids`,
// owes or not: every message a waiting card shows carries `owes`), not the thread, so someone else's message in it
// keeps the card waiting (`othersWaiting`) instead of going to Done unseen. What one of their live messages DIRECTLY
// answers stays in view too, splitReopened's rule (someone's question sat under your reply in Everyone and
// alone in their own view; the two should match): their question without the post it answers says nothing. Only the
// direct parent, and when that's a post of yours, the message it answered (as in Everyone); the rest of the chain
// still folds. And YOUR answers to a live message stay under it, splitReopened's
// "yours go with the message they answer" (a reply made on X to a message still owed a like was folded
// away in that person's view while Everyone showed it; a reply sent from here was placed under it, then folded on
// reload). `every`: ALL their messages stay in view, owed or not (a post's page, /posts/:id?person=: a finished post
// owes nothing, and you're reading what they said, not working through it); the rest of the rule is the same. Pure.
function focusOn(row, personId, { every = false } = {}) {
  const all = row.order;
  const theirs = (v) => !v.fromMe && v.author && v.author.id === personId;
  const live = (v) => theirs(v) && (every || (v.owes && (v.owes.like || v.owes.reply)));
  const liveIds = new Set(all.filter(live).map((v) => v.id));
  // What each live message answers, and when that's a post of YOURS, the message your post was answering too (one
  // step, splitReopened's `keep`): your photo, kept because their live reply answered it, says nothing without the
  // question of theirs it answered, which was done and folded.
  const byId = new Map(all.map((v) => [v.id, v]));
  const answered = new Set(
    all
      .filter(live)
      .map((v) => v.replyOf)
      .filter(Boolean)
      .flatMap((id) => {
        const p = byId.get(id);
        return p && p.fromMe && p.replyOf ? [id, p.replyOf] : [id];
      })
  );
  const shown = (v) => liveIds.has(v.id) || answered.has(v.id) || (v.fromMe && liveIds.has(v.replyOf));
  const ids = all.filter((v) => theirs(v) && v.owes).map((v) => v.id);
  // Only on a waiting card (a done one's button reopens the whole thread). `who`: them, for the label.
  const who = row.owed.find((w) => w.id === personId);
  const focus = row.status === "waiting" && who && ids.length ? { who, ids, othersWaiting: all.some((v) => !v.fromMe && v.owes && !theirs(v)) } : null;
  const earlier = all.filter((v) => !shown(v));
  return { ...row, earlier: runsOf(earlier), dialogue: runsOf(all.filter(shown)), ...foldChat(all, new Set(earlier.map((v) => v.id))), focus };
}

// THE RAIL (a list of people at the left, only those still owed a like or a reply, with how many): the
// people in the view (its tab and
// search) who still have a like or a reply coming from you, each with how many (a message with neither owes 2, one
// you liked but didn't answer 1: `owed`), the closest first (leaderboard rank; nobody ranked after, the most owed
// first), each a filter (`person`). `rows`: the view's cards, already filtered. → { people: [{ id, username, profile,
// n, like, reply }] (up to `limit`), more (people past it), total (everyone's likes and replies owed), like, reply
// (the total split: the rail's columns, as the head's "♥ N to like · ↩ N to reply") }. Pure.
// Every row by default (a cap of 30 stranded people below it as rows cleared); `limit` remains for a caller
// that wants fewer, `more` says how many it left out.
// Each person also carries `latest` = { text, at }: their newest message still owed something, one plain line (the
// phone's list shows it under their name, as X's notifications do).
// A reply that's only pictures says what it sent ("Sent a GIF"), never plainLine's "[media]". Pure.
function previewOf(v) {
  const text = plainLine(v, 140);
  if (text !== "[media]") return text;
  const badges = (v.media || []).map((m) => m.badge || "");
  if (badges.some((b) => b === "GIF")) return "Sent a GIF";
  if (badges.some((b) => b.startsWith("▶"))) return "Sent a video";
  return badges.length > 1 ? `Sent ${badges.length} photos` : "Sent a photo";
}
function railOf(rows, { limit = Infinity } = {}) {
  const byPerson = new Map();
  for (const r of rows) {
    for (const w of r.owed) {
      const was = byPerson.get(w.id) || { n: 0, like: 0, reply: 0 };
      byPerson.set(w.id, { ...w, latest: was.latest, n: was.n + w.n, like: was.like + w.like, reply: was.reply + w.reply });
    }
    for (const v of r.order || []) {
      const p = !v.fromMe && v.owes && (v.owes.like || v.owes.reply) && v.author && byPerson.get(v.author.id);
      if (p && (!p.latest || BigInt(v.id) > BigInt(p.latest.id))) p.latest = { id: v.id, text: previewOf(v), at: v.createdAt };
    }
  }
  const ranked = [...byPerson.values()].sort((a, b) => a.rank - b.rank || b.n - a.n || (a.id < b.id ? -1 : 1));
  const sum = (k) => ranked.reduce((s, p) => s + p[k], 0);
  return { people: ranked.slice(0, limit).map(({ rank, ...p }) => p), more: Math.max(0, ranked.length - limit), total: sum("n"), like: sum("like"), reply: sum("reply") };
}

// THE RAIL OF ONE CARD (a post's page, /posts/:id: the Inbox's People rail inside a post): EVERYONE who wrote in it,
// owed or not (a finished post is what you read it for), each with what they still owe in its columns (as railOf: the
// same figures, 0 for most once it's finished) and `wrote`, how many replies they have in it. The most still owed
// first (the figures the rows show read in order, as the Inbox's), then the most replies (the post's own measure: who
// talked most here; all a finished post has), then who wrote first. → { people: [{ id, username, profile, wrote,
// like, reply }], like, reply (the card's totals: Everyone's row) }. Pure.
function railOfCard(row) {
  const owed = new Map(row.owed.map((w) => [w.id, w]));
  const byPerson = new Map(row.people.map((id, i) => [id, { first: i, wrote: 0, author: null }]));
  for (const v of row.order) {
    const p = !v.fromMe && v.author && byPerson.get(v.author.id);
    if (!p) continue;
    p.wrote++;
    p.author = p.author || v.author;
  }
  const owes = (id) => (owed.get(id) || { n: 0 }).n;
  const people = [...byPerson]
    .filter(([, p]) => p.author)
    .sort(([ai, a], [bi, b]) => owes(bi) - owes(ai) || b.wrote - a.wrote || a.first - b.first)
    .map(([id, p]) => ({ id, username: p.author.username, profile: p.author.profile, wrote: p.wrote, like: (owed.get(id) || {}).like || 0, reply: (owed.get(id) || {}).reply || 0 }));
  return { people, like: row.owedSplit.like, reply: row.owedSplit.reply };
}

// A card's subject, one plain line (post view → { text, author }): the rail's Posts view names a card by it. Pure.
const ABOUT_CHARS = 90; // a card's `about` line (the agent's inbox tool says it)
function aboutOf(view, meId) {
  return { id: view.id, text: plainLine(view, ABOUT_CHARS) || "A post", author: view.author, yours: view.author && view.author.id === meId };
}

// THE HEAD'S BREAKDOWN (the red count alone looked daunting; it is likes and replies, so the head splits
// it into the two, adding up to the count): over EVERY card, the likes
// and the replies you still owe, by THE rule (standingOf). like + reply = owedCount = the red count. Pure.
function owedTotals(rows) {
  return rows.reduce((t, r) => ({ like: t.like + r.owedSplit.like, reply: t.reply + r.owedSplit.reply }), { like: 0, reply: 0 });
}

// THE RAIL, BY POST (a toggle to filter the Inbox by post as well as by person):
// the cards in the view that still owe something, each named by what it's about (aboutOf), the most owed first (a post
// that took off on top), then the newest. A card IS one conversation, so picking one (`post`) drills into it alone.
// → { posts: [{ id (the conversation), about, n, like, reply }] (up to `limit`), more, total, like, reply (the rail's
// columns, as railOf) }. Pure.
function railOfPosts(rows, { limit = Infinity } = {}) {
  // `at`: when the newest of them wrote (the phone's list shows it beside what the post is about).
  const owing = rows
    .map((r) => ({ id: r.conversationId, about: r.about, at: r.latestAt, n: r.owedSplit.like + r.owedSplit.reply, like: r.owedSplit.like, reply: r.owedSplit.reply, latestId: r.latestId }))
    .filter((p) => p.n > 0)
    .sort((a, b) => b.n - a.n || (a.latestId < b.latestId ? 1 : -1));
  const sum = (k) => owing.reduce((s, p) => s + p[k], 0);
  return { posts: owing.slice(0, limit).map(({ latestId, ...p }) => p), more: Math.max(0, owing.length - limit), total: sum("n"), like: sum("like"), reply: sum("reply") };
}

// A LONG CARD in the list folds after its first CARD_SHOWS messages of theirs (a post with 55+ replies: a
// long conversation collapses, with a way to drill in): the rest go under "Show N more messages", beside a link to the card alone (`drill`: the rail's post
// filter, where nothing folds). Cut only before one of THEIR messages, so your answers stay with what they answer.
// Only in the plain list: a person's view (focusOn) and a post's view show everything they picked. Pure.
const CARD_SHOWS = 6;
function capCard(row, drill, max = CARD_SHOWS) {
  let seen = 0;
  const cut = row.dialogue.findIndex((v) => !v.fromMe && ++seen > max);
  if (cut === -1) return row;
  const rest = row.dialogue.slice(cut).map((v, k) => (k === 0 ? { ...v, runStart: true, ruleBefore: false } : v));
  // Drawn in place like any fold (people.foldChat): what was folded already, and the rest.
  const hidden = new Set([...row.earlier, ...rest].map((v) => v.id));
  return { ...row, dialogue: row.dialogue.slice(0, cut), rest, drill, ...foldChat(row.order, hidden) };
}

// BULK LIKE's targets (within X's API limits; it replaced an earlier "no bulk like": the guard rails are X's own window, a hard per-press cap and only what the page
// showed): every message in `rows` (the view, already narrowed: its tab, search, person, post) still owed a like, in
// the order the page reads (cards top to bottom, each card's messages in chat order), none newer than `upTo` (the
// newest message when the page was drawn: a like never lands on something you haven't had the chance to see). In a
// person's view, only theirs. → [post id]. Pure.
function likeTargets(rows, { person = "", upTo = null } = {}) {
  const out = [];
  for (const r of rows) {
    for (const v of [...(r.earlier || []), ...r.dialogue, ...(r.rest || [])]) {
      if (v.fromMe || !v.owes || !v.owes.like || !v.likeable) continue;
      if (person && (!v.author || v.author.id !== person)) continue;
      if (upTo !== null && BigInt(v.id) > upTo) continue;
      out.push(v.id);
    }
  }
  return [...new Set(out)];
}

// THE OWED TABLE (views/partials/owed-model.hbs → public/js/post-actions.js): every message still owed a like or a
// reply, one entry each, so the page computes every number about what's owed from ONE table at the moment you press
// (the rail's columns, the head's "♥ N to like · ↩ N to reply", People | Posts, the toolbar's Done N replies, each bulk
// ♥'s N and the messages a bulk like will take) instead of waiting for the server to recount the Inbox after each press.
// `rows`: every card (the head counts all of them); `inView`: Set of the conversation ids the page's tab and search
// show (the rail and the presses count only those). In THE BULK LIKE's order (likeTargets: cards newest first, as the
// route reads them, each card's messages in its order), so the page predicts exactly which messages a capped press
// takes. → [[post id, author id, conversation id, flags]]: 1 a like owed, 2 a reply owed, 4 likeable (the ♥ can take
// it), 8 in view. Pure.
function owedModel(rows, inView) {
  const out = [];
  const seen = new Set();
  for (const r of [...rows].sort((a, b) => (a.latestId < b.latestId ? 1 : a.latestId > b.latestId ? -1 : 0))) {
    const v = inView.has(r.conversationId) ? 8 : 0;
    for (const m of [...(r.earlier || []), ...(r.dialogue || []), ...(r.rest || []), ...(r.order || [])]) {
      if (seen.has(m.id) || m.fromMe || !m.owes || !(m.owes.like || m.owes.reply) || !m.author) continue;
      seen.add(m.id);
      out.push([m.id, m.author.id, r.conversationId, (m.owes.like ? 1 : 0) | (m.owes.reply ? 2 : 0) | (m.likeable ? 4 : 0) | v]);
    }
  }
  return out;
}

// FOLLOW A THREAD's people (follow everyone who wrote in a thread, or only those who follow you): everyone who wrote in the card (`row.people`, in the order they first
// wrote) whom you don't follow as far as the pairs know (models/Follow.js; `follows`: signalsFor's { followers,
// following } Sets), and of them `back`, those who follow you. → { all: [ids], back: [ids] }. Pure.
function followTargets(row, follows) {
  const all = row.people.filter((id) => !follows.following.has(id));
  return { all, back: all.filter((id) => follows.followers.has(id)) };
}

// The list: Waiting by default, newest first, 20 cards a page; `person` narrows it to the cards where someone still
// has a like or a reply coming (the rail's links), `post` to one card (the rail's Posts view); `by` is which the rail
// lists (people | posts), kept in every link.
const listing = createListing({
  path: "/",
  defaultSort: "newest",
  pageSize: 20,
  text: (r) => r.haystack,
  sorts: {
    newest: { value: (r) => r.latestId, natural: "desc" },
    // Named, in place of a reverse arrow (an arrow beside "Newest" was unclear; reversing the other two,
    // least talked-with or fewest followers first, did nothing useful).
    oldest: { value: (r) => r.latestId, natural: "asc" },
    closest: { value: (r) => r.closeness, natural: "asc" }, // the people you go back and forth with most, first
    followers: { value: (r) => r.followers, natural: "desc" },
  },
  filters: {
    show: { values: ["waiting", "done", "all"], default: "waiting", test: (r, v) => v === "all" || r.status === v },
    person: { accepts: (v) => /^\d{1,20}$/.test(v), default: "", test: (r, v) => !v || r.owed.some((w) => w.id === v) },
    post: { accepts: (v) => /^\d{1,20}$/.test(v), default: "", test: (r, v) => !v || r.conversationId === v },
    by: { values: ["people", "posts"], default: "people", test: () => true },
  },
});

module.exports = { ABOUT_CHARS, inboxRows, threadAbove, THREAD_ABOVE_MAX, draftOf, inboxStart, incomingCards, owedCount, standingOf, splitReopened, railOf, railOfPosts, railOfCard, previewOf, owedTotals, capCard, likeTargets, owedModel, followTargets, CARD_SHOWS, focusOn, listing };
