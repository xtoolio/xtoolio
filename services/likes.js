// YOUR POSTS (/posts, web.js; the Likes module's page: the Likes page was really a list of your posts that
// had drawn a like, each row only a link to X, so it was repurposed; it was "Likes", only the posts someone liked):
// every post you wrote, and each reply of yours that drew something, with what it drew: likes, reposts, replies. A row
// opens the post HERE (/posts/:id: its conversation through the Inbox's engine, services/conversations.js
// conversationCard). Pure: the posts, the likes and
// reposts on them (extras.likerOp / reposterOp rows) and the replies to them in, rows out. Drawn by
// partials/like-card.hbs; listed by the one listing engine (services/listing.js). Nothing here reads X: it's what the
// sync, the likers check and Live stored.
"use strict";

const { createListing, ROWS_PER_PAGE } = require("./listing");
const { postView, plainLine, refOf } = require("./people");
const { previewOf } = require("./inbox");

// A like X said the time of is one that came live, as it happened. The likers check finds the ones Live missed a day
// or more after the fact, and X gives those no time. ONE rule, in its two forms (a row, a Mongo filter): only a timed
// like is NEWS (the tab's red count, services/unseenCount.js; a card's pink edge). The check's finds used to be
// dated by when xtoolio found them, so a day-old like came in at the top as "now", lit the count and the pink edge.
const isTimed = (l) => !!l.likedAt;
const TIMED = { likedAt: { $exists: true } };
// NEWS = a timed like you haven't already watched arrive on another page (Like.viewedAt, POST /posts/viewed:
// a like you saw arrive isn't new). The same rule's two forms; the tab's count and a card's
// pink edge both read it.
const isNews = (l) => isTimed(l) && !l.viewedAt;
const NEWS = { ...TIMED, viewedAt: { $exists: false } };

// How many faces a row shows (newest first); its count says how many in all (no names: the words were
// noise, a count says it; it said "Maya and 3 others liked your reply").
const FACES = 5;

// A plain repost of someone's post isn't a post of yours to list (it's their words); a reply of yours is one only when
// it drew something (most of them draw nothing, and a page of them would bury your posts).
const isRepost = (p) => !!refOf(p, "retweeted");
const isReply = (p) => !!refOf(p, "replied_to");

// What a post of yours drew, every kind shaped alike ({ who, at (Date | null: X's time, when known), kind, seenAt,
// news }), newest first: the likes (Like rows by others), the reposts (Repost rows by others: Live's, timed, news) and
// the replies (others' posts replying to it directly). One shape, so one ordering and one set of faces serve all three.
// → Map postId → [engagement]
function engagementOf({ meId, likes = [], reposts = [], replies = [] }) {
  const byPost = new Map();
  const add = (postId, e) => {
    if (e.who === meId) return;
    byPost.set(postId, [...(byPost.get(postId) || []), e]);
  };
  for (const l of likes) add(l.postId, { who: l.likerId, at: l.likedAt ? new Date(l.likedAt) : null, kind: "like", seenAt: l.seenAt, news: isNews(l) });
  for (const r of reposts) add(r.postId, { who: r.reposterId, at: new Date(r.repostedAt || r.seenAt), kind: "repost", seenAt: r.seenAt, news: true });
  for (const p of replies) {
    const to = refOf(p, "replied_to");
    if (to) add(to, { who: p.authorId, at: new Date(p.createdAt), kind: "reply", replyId: p._id });
  }
  return byPost;
}

// `mine`: the account's own posts (stream "own", or any stored post of yours someone liked). ctx: { meId, likes,
// reposts (the rows on your posts), replies (others' posts replying to yours), byId (Map: what they quote), profiles,
// names, known (Set: who has a People page), seenBefore (Date: the account last opened this page) }.
// → rows, the latest activity first: { postId, href (its page here), latestAt / latestMs (the newest like, repost or
// reply X dated, else when you posted it), count (likes), reposts, replies, likers (the faces: everyone it drew, newest
// first, FACES of them), fresh (a live like or repost since you last opened the page), post (people.postView), pic (its
// first picture as a small square, X's 150px `thumb`, "GIF" / "▶" on a moving one), preview (its first words, one line: inbox.previewOf; none beside a picture-only post's
// pic), postedMs, kind ("post" | "reply": a reply to someone else), replyTo (whom, a reply's), haystack (the post's
// words and everyone's names) }.
// A like X didn't date (the likers check's: a day or more after the fact) dates nothing, so an old post it found
// doesn't jump to the top as if just liked (it once lit the count and the edge as "now").
// `quiet`: list the replies that drew nothing too (the agent's `your_posts`, services/agentTools.js: how you write is in
// every reply, not just the ones people liked).
function postRows(mine, { meId, likes = [], reposts = [], replies = [], byId = new Map(), profiles = new Map(), names = new Map(), known = new Set(), seenBefore = null, quiet = false }) {
  const drew = engagementOf({ meId, likes, reposts, replies });
  const seen = seenBefore ? new Date(seenBefore).getTime() : Infinity;
  const rows = [];
  const listed = new Set();
  for (const p of mine) {
    if (listed.has(p._id) || p.authorId !== meId || isRepost(p)) continue;
    const got = drew.get(p._id) || [];
    if (isReply(p) && !got.length && !quiet) continue;
    listed.add(p._id);
    const postedAt = new Date(p.createdAt || 0);
    got.sort((a, b) => (b.at || postedAt) - (a.at || postedAt));
    const latestAt = got.reduce((t, e) => (e.at && e.at > t ? e.at : t), postedAt);
    const post = postView(p, { meId, byId, profiles, names, known });
    const likers = [...new Set(got.map((e) => e.who))].map((id) => {
      const profile = profiles.get(id) || null;
      return { id, username: (profile && profile.username) || names.get(id) || null, profile, page: known.has(id) ? `/people/${id}` : null };
    });
    const m = (p.media || [])[0];
    const pic = m ? { src: `${m.url}?name=thumb`, badge: m.type === "animated_gif" ? "GIF" : m.type === "video" ? "▶" : null } : null;
    const n = (kind) => got.filter((e) => e.kind === kind).length;
    // A reply to someone else (Your posts' Replies tab, and "Replying to …" on the row); your own thread going on is
    // a post, as X shows it.
    const toId = isReply(p) && p.inReplyToUserId && p.inReplyToUserId !== meId ? p.inReplyToUserId : null;
    const toProfile = toId ? profiles.get(toId) || null : null;
    rows.push({
      postId: p._id,
      kind: toId ? "reply" : "post",
      replyTo: toId ? { id: toId, username: (toProfile && toProfile.username) || names.get(toId) || null, profile: toProfile } : null,
      // A reply of yours deep in a conversation: the page lands on it (#p<id>; its fold opens: web.js conversationPage).
      href: `${listing.path}/${p._id}${p.conversationId && p.conversationId !== p._id ? `#p${p._id}` : ""}`,
      latestAt,
      latestMs: latestAt.getTime(),
      postedMs: postedAt.getTime(),
      count: n("like"),
      reposts: n("repost"),
      replies: n("reply"),
      likers: likers.slice(0, FACES),
      fresh: got.some((e) => e.news && new Date(e.seenAt).getTime() > seen),
      post,
      pic,
      preview: pic && plainLine(post) === "[media]" ? "" : previewOf(post),
      // What a search looks in (services/listing.js matches): who liked it, whom a reply answers (its "Replying to …"),
      // and its words as shown.
      haystack: [...likers.flatMap((u) => [u.username, u.profile && u.profile.name]), ...(toId ? [toProfile && toProfile.name, (toProfile && toProfile.username) || names.get(toId)] : []), ...post.segments.map((s) => s.text)].filter(Boolean).join(" "),
    });
  }
  return rows.sort((a, b) => b.latestMs - a.latestMs);
}

const listing = createListing({
  path: "/posts",
  defaultSort: "newest",
  pageSize: ROWS_PER_PAGE,
  text: (r) => r.haystack,
  sorts: {
    newest: { value: (r) => r.latestMs, natural: "desc" }, // "Latest activity": what's moving comes up, as likes arrive
    posted: { value: (r) => r.postedMs, natural: "desc" },
    most: { value: (r) => r.count, natural: "desc" },
  },
  // The tabs: All / Posts / Replies (a row's `kind`).
  filters: { kind: { values: ["all", "post", "reply"], default: "all", test: (r, v) => v === "all" || r.kind === v } },
});

module.exports = { postRows, listing, FACES, TIMED, NEWS };
