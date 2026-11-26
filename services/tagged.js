// WHO THEY TAG (Follows → Who they tag, /follows/tags: routes/tagged.js). Someone recommends "follow @them and anyone
// they tag": this reads @them's recent posts and lists the accounts those posts @-tag, most often first, to follow from
// a list. Their OWN posts only (X's `exclude=replies,retweets`): a reply's @-names are whoever they were talking to and
// a repost's are someone else's words, neither is them pointing at someone. ONE read per press, priced first and never
// charged past its quote: their profile, up to READ_POSTS posts, then the profiles of the PROFILE_MAX most-tagged
// people xtoolio doesn't have fresh (each read with this account's token, so where you stand with them comes too:
// sync.storeProfiles). Kept per account and handle (models/TagRead.js, 30 days). Nothing about them is stored as
// this account's data: the read is public posts, and only who they tag is kept.
"use strict";

const { createClient, ReadCapReached } = require("../lib/x");
const { PRICE } = require("../lib/pricing");
const Person = require("../models/Person");
const TagRead = require("../models/TagRead");
const { metered } = require("./usage");
const { storeProfiles } = require("./sync");
const { createListing } = require("./listing");
const { isHandle } = require("../lib/handle");

const READ_POSTS = 200;
const PROFILE_MAX = 100;
// A stored profile younger than this is shown as it is (the profile policy's "everyone else", services/syncPrefs.js
// PROFILES: monthly); older or missing, it's read.
const PROFILE_FRESH_MS = 30 * 24 * 3600 * 1000;

// ── Rules (pure) ──

// THE QUOTE, in X's cost: their profile, the posts, and the profiles read after them, at most. → USD
const quoteUsd = () => PRICE.user * (1 + PROFILE_MAX) + PRICE.post * READ_POSTS;

// Who these posts (X's, `entities.mentions`) tag, each once per post, never their author: [{ id, username, n, lastAt }],
// the most-tagged first, then the most recent.
function taggedIn(posts, authorId) {
  const by = new Map();
  for (const post of posts) {
    const at = post.created_at ? new Date(post.created_at) : null;
    const seen = new Set();
    for (const m of (post.entities && post.entities.mentions) || []) {
      if (!m.id || m.id === authorId || seen.has(m.id)) continue;
      seen.add(m.id);
      const p = by.get(m.id) || { id: m.id, username: m.username, n: 0, lastAt: null };
      p.n++;
      if (at && (!p.lastAt || at > p.lastAt)) p.lastAt = at;
      by.set(m.id, p);
    }
  }
  return [...by.values()].sort((a, b) => b.n - a.n || (b.lastAt || 0) - (a.lastAt || 0));
}

// A read's people as Follows rows (partials/follow-card.hbs, kind "tagged"): their profile, where you stand (the
// stored pairs: `followsYou` / `youFollow` Maps of true / false), how many of the posts tagged them.
function rowsOf(read, { profiles = new Map(), followsYou = new Map(), youFollow = new Map(), meId = null } = {}) {
  return (read.people || [])
    .filter((p) => p.id !== meId)
    .map((p) => {
      const profile = profiles.get(p.id) || null;
      return {
        id: p.id,
        kind: "tagged",
        person: { id: p.id, username: (profile && profile.username) || p.username || null, profile, page: null },
        followsYou: followsYou.get(p.id) === true,
        youFollow: youFollow.get(p.id) === true,
        tagged: p.n,
        lastAt: p.lastAt,
        followers: profile && Number.isFinite(profile.followers) ? profile.followers : null,
      };
    });
}

// 50 a page: "Select all on this page" fills one bulk follow (routes/pages.js followMany: X's 50 per 15 minutes).
// `handle` rides in every link; `who` hides the people you already follow by default.
const listing = createListing({
  path: "/follows/tags",
  defaultSort: "tagged",
  pageSize: 50,
  text: (r) => `${(r.person.profile && r.person.profile.name) || ""} ${r.person.username || ""}`.toLowerCase(),
  sorts: {
    tagged: { value: (r) => r.tagged, natural: "desc" },
    followers: { value: (r) => (r.followers === null ? -1 : r.followers), natural: "desc" },
  },
  filters: {
    handle: { accepts: isHandle, default: "", test: () => true }, // a clean handle only (the links carry it so)
    who: { values: ["new", "all"], default: "new", test: (r, v) => v === "all" || !r.youFollow },
  },
});

// ── The read ──

// Read `handle`'s recent posts with this account's token and keep who they tag. One metered unit ("Who @them tags",
// kind "follows"), gated and charged like any read, never past the quote (`ceilingUsd`). A read cut short by the
// ceiling keeps what it got. → { read } | { error: "unknown" } (X has no such account, or it's private and posts
// came back empty: `posts` says 0)
async function readTags({ accountId, handle, getToken, ownerId = null, billing = null }) {
  const token = await getToken();
  const label = `Who @${handle} tags`; // named first: verify-billing reads each metered call's options up to their first closing brace
  return metered({ accountId, kind: "follows", label, billing, ceilingUsd: quoteUsd() }, async (meter) => {
    const x = createClient({ token, meter, ownerId, readCap: READ_POSTS, userCap: 1 + PROFILE_MAX });
    const user = await x.userByUsername(handle);
    if (!user) return { error: "unknown" };
    const posts = [];
    let next;
    try {
      do {
        const page = await x.timelinePage(user.id, "tweets", { paginationToken: next, maxResults: 100, exclude: "replies,retweets", what: "tagged" });
        posts.push(...page.posts);
        next = page.nextToken;
      } while (next && x.remainingPosts() >= 5);
    } catch (err) {
      if (!(err instanceof ReadCapReached) && !err.transient) throw err; // a clean stop keeps what came
    }
    const people = taggedIn(posts, user.id);
    // Profiles: the most-tagged first, only those not stored fresh.
    const top = people.slice(0, PROFILE_MAX).map((p) => p.id);
    const stored = await Person.find({ _id: { $in: top } }, "fetchedAt").lean();
    const fresh = new Set(stored.filter((p) => p.fetchedAt && Date.now() - new Date(p.fetchedAt) < PROFILE_FRESH_MS).map((p) => p._id));
    const due = top.filter((id) => !fresh.has(id));
    try {
      for (let i = 0; i < due.length; i += 100) await storeProfiles(await x.usersByIds(due.slice(i, i + 100)), { fetched: 0, gone: 0 }, accountId);
    } catch (err) {
      if (!(err instanceof ReadCapReached) && !err.transient) throw err;
    }
    const doc = { accountId, handle: user.username, userId: user.id, name: user.name, image: Person.imageOf(user.profile_image_url) || null, posts: posts.length, people, at: new Date() };
    await TagRead.replaceOne({ _id: `${accountId}:${user.username.toLowerCase()}` }, doc, { upsert: true });
    return { read: doc };
  });
}

// This account's read of `handle`, or null.
const readOf = (accountId, handle) => TagRead.findById(`${accountId}:${handle.toLowerCase()}`).lean();
// This account's reads, newest first (the page's "Read before": a handle to open again).
const readsOf = (accountId) => TagRead.find({ accountId }, "handle name image posts at").sort({ at: -1 }).limit(10).lean();

module.exports = { READ_POSTS, PROFILE_MAX, quoteUsd, taggedIn, rowsOf, listing, readTags, readOf, readsOf };
