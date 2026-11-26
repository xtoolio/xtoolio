// Who you go back and forth with, derived from stored posts. Pure functions
// over plain post objects, so it's testable without a database.
//
//   you → them : your posts that reply to them (in_reply_to_user_id)
//   them → you : their posts that mention you (a reply to you is a mention)
//   back and forth : the SMALLER of the two — a real exchange outranks
//                    someone who only ever replies to you (or vice versa)
//
// What counts is what a post says (exchangeWith), whichever feed delivered it:
// a thread-context post that replies to you counts like a mention. `stream`
// (per account: services/accountData.js sets it from the post's `accounts`
// membership) only matters for display and for which quotes the sync walks.
//
// Names and pictures come from `profiles` (the Person collection, filled by
// sync's profile pass). Until someone's profile is fetched, their username
// falls back to posts' own @mentions; with neither they show by id.

const { segments } = require("./text");
const { sourceOf } = require("../lib/media"); // pure: which pictures could go in a reply (and so be saved)

// The stored fields these functions need (`accounts` becomes `stream`). Load
// posts with exactly this projection (services/accountData.js) so the raw
// API copy stays on disk.
// raw.display_text_range: where X's own app starts showing a reply (services/text.js), when X sent it.
const POST_FIELDS = "accounts authorId text createdAt inReplyToUserId quotedAuthorId mentions urls media conversationId referenced gone likersCheckedAt raw.display_text_range";

// Who an exchange post is with, and which way: { personId, dir: "out"|"in" },
// or null when it isn't an exchange. The one definition the leaderboard and
// the thread view share.
//
// Decided by what the post SAYS, never by which feed it came from:
//   out = you wrote it, replying to someone else
//   in  = someone else wrote it, replying to you, mentioning you, or quoting your post (Post.quotedAuthorId;
//         without it a quote of yours never showed, though it's plainly them talking to you)
// It used to require the "mention" stream for "in", but X's mentions feed only
// reaches back ~800 mentions (days for a busy account, whose own posts reach
// back months), so their older replies — fetched as thread context because
// you answered them — counted as nothing: "7 from you · 0 from them" with
// someone you'd plainly talked to.
//
// A plain REPOST is never an exchange, either way (@xtoolio's repost of an account's post sat in that
// account's Inbox as "Mentioned you" with nothing to answer): its text is "RT @you: …" and X tags that @you as a mention, and the
// shared store loads any stored post mentioning you (accountData.accountPosts), so another account's own repost of
// your post, or anyone's repost of a post that tagged you, read as them talking to you. A repost of yours is counted
// on Your posts (models/Repost.js); a quote is a post and still counts.
// EXCHANGE_FIELDS: what it reads, for a query that projects less than POST_FIELDS (inboxCount, inboxStart).
const EXCHANGE_FIELDS = "authorId inReplyToUserId mentions quotedAuthorId referenced gone";
function exchangeWith(p, meId) {
  if (p.gone || !p.authorId || refOf(p, "retweeted")) return null;
  if (p.authorId === meId) return p.inReplyToUserId && p.inReplyToUserId !== meId ? { personId: p.inReplyToUserId, dir: "out" } : null;
  const toMe = p.inReplyToUserId === meId || (p.mentions || []).some((m) => m.id === meId) || p.quotedAuthorId === meId;
  return toMe ? { personId: p.authorId, dir: "in" } : null;
}

function usernameMap(posts) {
  const names = new Map();
  for (const p of posts) for (const m of p.mentions || []) if (m.id && m.username) names.set(m.id, m.username);
  return names;
}

// What to call anyone shaped { id, username, profile }: their name, else @username, else the bare id. THE one rule:
// the displayName view helper, a conversation's likes line and its breadcrumb all use it. Pure.
const displayNameOf = (p) => (!p ? "" : (p.profile && p.profile.name) || (p.username ? `@${p.username}` : `id ${p.id}`));

// The shape views (the avatar partial) expect for anyone: { id, username, profile }.
function identify(id, profiles, names) {
  const profile = profiles.get(id) || null;
  return { id, username: (profile && profile.username) || names.get(id) || null, profile };
}

// "A", "A and B", "A, B and C". Pure.
const andList = (names) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

// Who liked a post, said as a conversation shows it under the post: "You", "Maya", "You and Maya",
// "Maya and 2 others", "Maya Okafor and Dev Raman", "3 people". `likers`: ids (services/extras.js likersByPost).
// null when nobody is known. `named`: [{ id, name }], the people the view is with (one in a conversation; everyone who
// wrote in an Inbox card), named when they liked it; anyone else is counted. Pure.
// THE LIKE LINE'S FACES (a line like "You, Maya, Dev, Sam, Priya and 10 others" was too long, so it shows
// the likers' pictures, no names, a little smaller, as the Likes page does): yours first when you liked it, then the others as stored, LIKE_FACES of them; the rest a "+N". The names
// (likeLine) stay the line's words for a screen reader and its tooltip. → ids. Pure.
const LIKE_FACES = 5;
const likeFaceIds = (likers, meId) => [...(likers.includes(meId) ? [meId] : []), ...likers.filter((id) => id !== meId)].slice(0, LIKE_FACES);

function likeLine(likers, meId, named = []) {
  if (!likers || !likers.length) return null;
  const names = [likers.includes(meId) && "You", ...named.filter((n) => likers.includes(n.id)).map((n) => n.name)].filter(Boolean);
  const others = likers.filter((id) => id !== meId && !named.some((n) => n.id === id)).length;
  if (!names.length) return `${others} ${others === 1 ? "person" : "people"}`;
  if (!others) return andList(names);
  return `${names.join(", ")} and ${others} ${others === 1 ? "other" : "others"}`;
}

const NO_LIKES = { byYou: new Map(), ofYou: new Map() };
const NO_FOLLOWS = { followers: new Set(), following: new Set() };

// `profiles`: Map of user id → Person doc (optional). opts:
//   likes   — { byYou: Map person → count, ofYou: Map person → count } (services/extras.js)
//   follows — { followers: Set, following: Set } (services/extras.js)
function leaderboard(posts, meId, profiles = new Map(), { likes = NO_LIKES, follows = NO_FOLLOWS } = {}) {
  const people = new Map();
  for (const p of posts) {
    const ex = exchangeWith(p, meId);
    if (!ex) continue;
    if (!people.has(ex.personId)) people.set(ex.personId, { id: ex.personId, out: 0, in: 0, last: null });
    const r = people.get(ex.personId);
    r[ex.dir]++;
    const at = p.createdAt ? new Date(p.createdAt) : null;
    if (at && (!r.last || at > r.last)) r.last = at;
  }

  const names = usernameMap(posts);
  return [...people.values()]
    .map((r) => ({
      ...r,
      ...identify(r.id, profiles, names),
      mutual: Math.min(r.out, r.in),
      total: r.out + r.in,
      likedByYou: likes.byYou.get(r.id) || 0,
      likedYou: likes.ofYou.get(r.id) || 0,
      followsYou: follows.followers.has(r.id),
      youFollow: follows.following.has(r.id),
    }))
    .sort((a, b) => b.mutual - a.mutual || b.total - a.total || (b.last || 0) - (a.last || 0));
}

// One line of plain text for a post, for a table cell: its display segments flattened, whitespace collapsed.
function plainLine(item, max = 140) {
  if (!item || item.gone) return "";
  const s = item.segments.map((seg) => (seg.media ? "[media]" : seg.text)).join("").replace(/\s+/g, " ").trim();
  if (!s && item.media.length) return "[media]"; // only pictures: say so rather than nothing
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

// A post's stored media as the `media` partial shows it: X's small rendition (680px wide, plenty for a ≤560px
// slot on a 2x screen) and, for a video or GIF, the badge over its preview frame. `saved` (a Set of the media keys you
// saved, given only on someone else's post where your media exists): each photo or GIF that could go in a reply
// carries `save` { saved }, the "+ Save" on it (services/mediaLibrary.js save). `gif`: an animated GIF's looping MP4
// on X's video server (lib/media.js sourceOf), which the partial plays over the preview frame (public/js/gifs.js).
function mediaView(media, saved = null) {
  return (media || []).map((m) => {
    const s = Math.floor((m.durationMs || 0) / 1000); // whole seconds, as X's player counts them
    const badge = m.type === "video" ? `▶ ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : m.type === "animated_gif" ? "GIF" : null;
    const src = sourceOf(m);
    const save = saved && src ? { saved: saved.has(m.key), kind: m.type === "animated_gif" ? "GIF" : "photo" } : null;
    const gif = src && src.kind === "gif" ? src.url : null;
    // THE VIEWER (partials/lightbox.hbs, public/js/lightbox.js): what a press on it opens, big. A photo at X's original
    // size (to read a dense screenshot), a GIF as its looping MP4, a video as its frame at X's large size (its file
    // isn't stored: it plays on X).
    const view = src ? { src: src.url, kind: src.kind } : { src: `${m.url}?name=large`, kind: m.type === "video" ? "video" : "photo" };
    return { key: m.key, thumb: `${m.url}?name=small`, alt: m.alt || "", width: m.width, height: m.height, badge, save, gif, view };
  });
}

const refOf = (p, type) => {
  const r = (p.referenced || []).find((x) => x.type === type);
  return r ? r.id : null;
};

// Wherever a post shows (its own card, a chat bubble, a quote card) its stored pictures show with it, so its
// pic.x.com link leaves the text; a post without stored media keeps the marker.
const say = (p) => segments(p, { isReply: !!refOf(p, "replied_to"), quotedId: refOf(p, "quoted"), mediaShown: !!(p.media && p.media.length) });

// WHOM X TAGS IN YOUR REPLY to post `p`: its author, then everyone it mentions ANYWHERE (its reply prefix and any
// @handle typed in it), in order, never you, each once. X writes those @handles into the reply itself; checked on real
// replies sent through xtoolio (a one-off check): every one matched, a reply to Maya's
// "@dev @you …" went to "@maya @dev", and one to a post naming eleven people went to twelve.
// → ["username", …] (as X spells them). Pure.
function addressees(p, meId, authorUsername) {
  const seen = new Set();
  const out = [];
  const add = (id, username) => {
    if (!username || (id && id === meId) || seen.has(username.toLowerCase())) return;
    seen.add(username.toLowerCase());
    out.push(username);
  };
  add(p.authorId, authorUsername);
  for (const m of [...(p.mentions || [])].sort((a, b) => (a.start || 0) - (b.start || 0))) add(m.id, m.username);
  return out;
}
// "Replying to @a @b and 10 others", X's way, the reply box's line (partials/reply-box.hbs): up to REPLYING_ALL named,
// else the first REPLYING_SHOWN and how many more (`all`: every handle, THE tooltip on "N others"). → view | null.
const REPLYING_ALL = 3;
const REPLYING_SHOWN = 2;
function replyingView(usernames) {
  if (!usernames.length) return null;
  const n = usernames.length <= REPLYING_ALL ? usernames.length : REPLYING_SHOWN;
  return { shown: usernames.slice(0, n).map((u) => `@${u}`), more: usernames.length - n, all: usernames.map((u) => `@${u}`).join(" ") };
}

// ONE post as every view draws it (a conversation's seed and chat, the inbox): who wrote it, its text and pictures,
// its quote, who liked it and whether the ♥ shows. ctx: { meId, personId + personName (whom the likes line names
// besides you), people (optional: everyone it should name, an Inbox card's writers under a post of yours that isn't an
// answer to one of them), byId (Map of posts, for the quote), profiles, names (usernameMap), likers (Map postId →
// [likerId]), canLike (the Liking extra), known (Set of the people who have a People page: everyone you've exchanged
// with), follows (optional: the pair facts, extras.signalsFor's { followers, following } Sets, given only once any is
// known) }. Every author carries `page`: their People page when they have one (not you), so their picture and name open
// it (partials/who-av.hbs and post-who.hbs fall back to their X profile), and, with `follows`, `follow` { followsYou,
// youFollow }: where you two stand, beside their name in a conversation (partials/follow-inline.hbs). `mediaSaved`
// (optional: a Set of the media keys you saved, given where you have a media library): someone else's pictures offer
// "+ Save" (mediaView). Pure.
function postView(p, { meId, personId, personName, people = null, byId = new Map(), profiles = new Map(), names = new Map(), likers = new Map(), canLike = false, reposted = new Set(), canRepost = false, known = new Set(), follows = null, mediaSaved = null }) {
  const quoted = byId.get(refOf(p, "quoted"));
  const who = (id) => ({
    ...identify(id, profiles, names),
    page: id && id !== meId && known.has(id) ? `/people/${id}` : null,
    follow: follows && id && id !== meId ? { followsYou: follows.followers.has(id), youFollow: follows.following.has(id) } : null,
  });
  const named = (people || (personId ? [personId] : [])).map((id) => ({ id, name: id === personId && personName ? personName : displayNameOf(who(id)) }));
  const postLikers = likers.get(p._id) || [];
  return {
    id: p._id,
    createdAt: p.createdAt,
    gone: !!p.gone,
    fromMe: p.authorId === meId,
    author: who(p.authorId),
    segments: say(p),
    media: mediaView(p.media, p.authorId !== meId && !p.gone ? mediaSaved : null),
    // Your own like counts on your own post too ("You and 21 others"), so the line adds up to X's number.
    liked: likeLine(postLikers, meId, named),
    // Their faces (`profiles` must hold them: callers load likeFaceIds' people) and how many more.
    likedFaces: postLikers.length ? { people: likeFaceIds(postLikers, meId).map(who), more: Math.max(0, postLikers.length - LIKE_FACES) } : null,
    likesPerson: named.map((n) => n.id).join(",") || null, // on the post's likes slot: a live like redraws the line naming them

    // What it replies to (a chat keeps your answer under what it answers: chatOrder), and whom its "↩ Reply" answers
    // (partials/post-foot.hbs: a composer opens right under it): every post still on X, your own too ("yourself": a
    // follow-up under your own reply, X's way). Replying to your own post owes nothing and moves no count.
    replyOf: refOf(p, "replied_to") || null,
    replyTo: p.gone ? null : p.authorId === meId ? "yourself" : displayNameOf(who(p.authorId)),
    replyingTo: p.gone ? null : replyingView(addressees(p, meId, who(p.authorId).username)), // whom X tags in your reply (never you)
    likeable: canLike && p.authorId !== meId && !p.gone,
    youLiked: (likers.get(p._id) || []).includes(meId),
    // The ↻ (the Reposting add-on, partials/repost-button.hbs): on someone else's post still on X; which way it toggles.
    repostable: canRepost && p.authorId !== meId && !p.gone,
    youReposted: reposted.has(p._id),
    quoted: quoted && { id: quoted._id, createdAt: quoted.createdAt, gone: !!quoted.gone, author: who(quoted.authorId), segments: say(quoted), media: mediaView(quoted.media) },
  };
}
// X ids are time-ordered snowflakes; unlike createdAt, a `gone` post has one.
const byIdAsc = (a, b) => (BigInt(a._id) < BigInt(b._id) ? -1 : 1);

// A chat in the order it reads, X's way (post views, given in time order): a TREE, every message directly under what it
// answers, whoever wrote either, siblings in time order (replies to your own follow-up post in your thread
// sat far below it by time, and the follow-up itself read as an answer to whoever wrote just before it). It was: everyone's in time order, each followed by YOUR answers only
// (replies open under the message, and land there; a sent reply still lands at the end of what's under
// the message, post-actions.js, which is where this puts it, being the newest). What answers something not in the
// chat (the seed, an older post) starts a branch, at its time. Then each item's side, run and line (runsOf). THE order
// for a conversation's chat and an Inbox card's. Pure.
function chatOrder(views) {
  const ids = new Set(views.map((v) => v.id));
  const under = new Map(); // id → the messages answering it, in time order
  const roots = [];
  for (const v of views) {
    if (v.replyOf && v.replyOf !== v.id && ids.has(v.replyOf)) under.set(v.replyOf, [...(under.get(v.replyOf) || []), v]);
    else roots.push(v);
  }
  const out = [];
  const placed = new Set();
  // Iterative, depth first (a long back and forth is a long chain).
  const walk = (root) => {
    const stack = [root];
    while (stack.length) {
      const v = stack.pop();
      if (placed.has(v.id)) continue;
      placed.add(v.id);
      out.push(v);
      stack.push(...(under.get(v.id) || []).slice().reverse());
    }
  };
  roots.forEach(walk);
  views.forEach(walk); // anything only reachable through a loop of ids (never seen; X ids can't), at its time
  return runsOf(out);
}
// Each item's side, whether it starts a run (a run shows its avatar, name and time once) and whether a line opens it,
// for a chat AS SHOWN: chatOrder's whole chat, and again for each part a card shows on its own (inbox.splitReopened's
// folded and shown parts, focusOn's), since what's next to what changes once something folds (computed on
// the whole card, a back and forth with one person kept the lines of the 35 messages folded away between them). Pure.
// THE LINE opens each BRANCH (a thin line between messages in the same thread): a message whose
// parent isn't in the block since the last line, yours too (your follow-up in your own thread is its own branch, not
// an answer to what's above it). A back and forth, and everyone answering the same message, stays one block
// (a line only after a whole back and forth); so does one person writing twice in a row (one run).
// THE THREAD LINE (each back and forth is a unit, and the design had lost who you'd answered): `joinsNext` when the message drawn right under this one
// ANSWERS it, so app.css draws X's line from this face down to that one. Only a direct answer: two people answering
// the same message stay in one block, unjoined (a line would say the second answered the first).
// A RUN is one person writing on: the same author answering their own message above, or the same thing it answered
// (someone's first reply answered a second person and the one right under it answered your post, but as
// one run the second had no header and no line and read as more of the first). Anything else from the same author starts its own run (its own header), and
// a line when it opens a new branch.
// Answering the same thing again is one run only when that thing ISN'T in the chat (two replies in a row to the seed):
// when it is, the second needs "Replying to" (its parent isn't right above it) and that line needs a header to sit
// under (two replies of yours to the same message: the second's "Replying to …" hung inside the first,
// hard to see). Two posts on X, two headers here.
function runsOf(out) {
  let block = new Set();
  const ids = new Set(out.map((v) => v.id));
  const runs = out.map((v, k) => {
    const prev = out[k - 1];
    const sameThing = (v.replyOf || null) === (prev && (prev.replyOf || null)) && !ids.has(v.replyOf);
    const sameRun = !!prev && prev.author.id === v.author.id && (v.replyOf === prev.id || sameThing);
    const runStart = !sameRun;
    const ruleBefore = k > 0 && runStart && !(v.replyOf && block.has(v.replyOf));
    if (ruleBefore) block = new Set();
    block.add(v.id);
    return { ...v, side: v.fromMe ? "me" : "them", runStart, ruleBefore };
  });
  // REPLYING TO, X's words, only where the drawing can't say it (someone answered a second person
  // right under YOUR answer to that person, and read as answering you): a message whose parent is in the chat but isn't the message right
  // above it names whom it answers (`answering`: the parent's author). Right above = the thread line or the run says it.
  const byId = new Map(runs.map((v) => [v.id, v]));
  return runs.map((v, k) => {
    const parent = v.replyOf && byId.get(v.replyOf);
    const answering = parent && k > 0 && runs[k - 1].id !== parent.id ? parent.author : null;
    return { ...v, joinsNext: k + 1 < runs.length && runs[k + 1].replyOf === v.id, answering };
  });
}

// A chat WITH A FOLD, drawn in place (a reply that arrived on a card marked done: opening "Show N earlier
// replies" put the old ones in a block above and the new reply alone below, not under the message it answers, where X
// shows it): every message stays where chatOrder puts it, and the fold only HIDES some (`hidden`: their ids), so
// opening it shows the whole tree in order and closed you see what's left, in the same order. The fold's one toggle
// (partials/thread.hbs, a checkbox and CSS: no script) covers every reason something folds: done (inbox.splitReopened),
// not this person's (focusOn), past a long card's first few (capCard). Who-and-when heads and the lines differ between
// the two states (what's next to what changes), so each message gets both: runStart / ruleBefore say whether to draw
// it at all, headWhen / ruleWhen ("open" | "shut") when it's only for one state. `order`: chatOrder's list.
// → { chat, fold: { n, word ("earlier" | "more" | "other"), top (the toggle above the chat, else below) } | null }. Pure.
function foldChat(order, hidden = new Set()) {
  const open = runsOf(order);
  const folded = open.filter((v) => hidden.has(v.id));
  if (!folded.length) return { chat: open, fold: null };
  const shut = new Map(runsOf(order.filter((v) => !hidden.has(v.id))).map((v) => [v.id, v]));
  const when = (o, s) => (o === s ? null : o ? "open" : "shut");
  const chat = open.map((v) => {
    if (hidden.has(v.id)) return { ...v, folded: true };
    const s = shut.get(v.id);
    return { ...v, runStart: v.runStart || s.runStart, ruleBefore: v.ruleBefore || s.ruleBefore, joinsNext: v.joinsNext || s.joinsNext, answering: v.answering || s.answering, headWhen: when(v.runStart, s.runStart), ruleWhen: when(v.ruleBefore, s.ruleBefore), joinWhen: when(v.joinsNext, s.joinsNext), answerWhen: when(!!v.answering, !!s.answering) };
  });
  const first = chat.findIndex((v) => !v.folded);
  const last = chat.length - 1 - [...chat].reverse().findIndex((v) => !v.folded);
  const at = chat.map((v, k) => (v.folded ? k : null)).filter((k) => k !== null);
  const word = first === -1 || at.every((k) => k < first) ? "earlier" : at.every((k) => k > last) ? "more" : "other";
  return { chat, fold: { n: folded.length, word, top: word !== "more" } };
}

// Every exchange with one person, grouped by thread, newest thread first.
// A thread is the chain of stored posts behind your exchanges, oldest first,
// split in two:
//   topic    — what the thread is about: the posts before the first
//              exchange, all of them (no folding: a fold hid the posts that
//              explain the thread, for little height saved)
//   dialogue — from the first exchange on; each item knows its side ("me"
//              right, everyone else left) and whether it starts a new run of
//              one author's posts (a run shows its avatar, name and time once).
// Plus { id, lastAt } and the row the person page's table shows: { about:
// { text, author, fromMe } (the thread's first stored post, one line), you,
// them (dialogue posts each), lastWord ("you" | "them": who wrote the newest
// exchange) }. Each post also carries `liked` (likeLine: who liked it, as far as this account can see), from
// opts.likers (Map postId → [likerId]; services/extras.js likersByPost), and, with opts.canLike (the Liking extra),
// `likeable` (someone else's post still on X: the ♥ button) and `youLiked` (which way it toggles).
function threads(posts, meId, personId, profiles = new Map(), { likers = new Map(), canLike = false, reposted = new Set(), canRepost = false, known = new Set(), follows = null, mediaSaved = null } = {}) {
  const byId = new Map(posts.map((p) => [p._id, p]));
  const names = usernameMap(posts);
  const personName = displayNameOf(identify(personId, profiles, names));
  const groups = new Map(); // conversation id → Map of post id → post

  for (const p of posts) {
    const ex = exchangeWith(p, meId);
    if (!ex || ex.personId !== personId) continue;
    const key = p.conversationId || p._id;
    if (!groups.has(key)) groups.set(key, new Map());
    const g = groups.get(key);
    for (let cur = p; cur && !g.has(cur._id); cur = byId.get(refOf(cur, "replied_to"))) g.set(cur._id, cur);
  }

  const ctx = { meId, personId, personName, byId, profiles, names, likers, canLike, reposted, canRepost, known, follows, mediaSaved };
  const view = (p) => ({ ...postView(p, ctx), exchange: (() => { const ex = exchangeWith(p, meId); return !!ex && ex.personId === personId; })() });

  return [...groups.entries()]
    .map(([id, g]) => {
      const items = [...g.values()].sort(byIdAsc).map(view);
      const exchanges = items.filter((i) => i.exchange);
      const last = exchanges[exchanges.length - 1]; // items are in id (= time) order
      const first = items.indexOf(exchanges[0]);
      const topic = items.slice(0, first);
      const dialogue = chatOrder(items.slice(first));
      return {
        id,
        lastAt: new Date(last.createdAt),
        about: { text: plainLine(items[0]), author: items[0].author, fromMe: items[0].fromMe, gone: items[0].gone },
        you: dialogue.filter((i) => i.fromMe).length,
        them: dialogue.filter((i) => i.author.id === personId).length,
        lastWord: last.fromMe ? "you" : "them",
        // The likes in it, as the cards count them: their posts you liked, your posts they liked.
        youLiked: items.filter((i) => i.author.id === personId && (likers.get(i.id) || []).includes(meId)).length,
        theyLiked: items.filter((i) => i.fromMe && (likers.get(i.id) || []).includes(personId)).length,
        topic,
        dialogue,
        chat: dialogue, // what partials/thread.hbs draws (a conversation's page folds nothing)
      };
    })
    .sort((a, b) => b.lastAt - a.lastAt);
}

module.exports = { POST_FIELDS, EXCHANGE_FIELDS, likeLine, likeFaceIds, displayNameOf, exchangeWith, leaderboard, threads, usernameMap, postView, addressees, replyingView, refOf, chatOrder, runsOf, foldChat, plainLine };
