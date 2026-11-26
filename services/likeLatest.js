// LIKE SOMEONE'S LATEST POSTS (a person's page, "♥ Like latest N": routes/people.js POST /people/:id/like-latest):
// read their newest posts from X and like the ones you haven't, as many as X's like window allows right now. Their OWN
// posts, X's profile "Posts" tab (`exclude=replies,retweets`: a reply is them talking to someone else, a repost
// someone else's words). Read with this account's token, newest first, a page at a time, only until there are enough
// not yet liked (or READ_MAX, or the end of what X serves), and stored as context posts this account was shown
// (sync.storeContext: THE write a like needs, extras.setLike acts only on a stored post the account may see). The
// likes themselves are THE bulk like's loop (routes/pages.js likeEach), in the same ledger unit as the read.
"use strict";

const { createClient, ReadCapReached } = require("../lib/x");
const { PRICE } = require("../lib/pricing");
const Like = require("../models/Like");
const { storeContext, storeProfiles } = require("./sync");
const { metered } = require("./usage");

// The most of their posts one press reads (X's pages are 100): enough to find a window's worth not yet liked when
// you've liked many of their recent ones already.
const READ_MAX = 200;

// THE QUOTE, in X's cost: the posts read and the likes sent, at most. → USD
const quoteUsd = (n) => PRICE.post * READ_MAX + PRICE.like * n;
// The first page asked for: only as big as the likes it's for, and a few spare for ones liked already (X bills each
// post it returns); later pages, X's most.
const firstPage = (n) => Math.min(100, Math.max(5, n + 10));
// THE ESTIMATE, in X's cost (the Likestorm page's slider, priced for the account by billing.priceFor): one page of
// their posts and n likes. More only if many of their latest are liked already. → USD
const estimateUsd = (n) => PRICE.like * n + PRICE.post * firstPage(n);

// THE LIKESTORM's first step (POST /likestorm/find): who is @handle NOW (a handle changes hands, so X is asked, never
// a stored name), their profile stored (sync.storeProfiles, with where you stand with them), so the page can show
// them to confirm before anything is liked. One metered unit, kind "profile" ("Find @them"), gated and charged as a
// profile ↻ is. → X's user, or null (no such account)
async function findPerson({ accountId, handle, getToken, ownerId = null, billing = null }) {
  const token = await getToken();
  const label = `Find @${handle}`; // named first: verify-billing reads a metered call's options up to their first closing brace
  return metered({ accountId, kind: "profile", label, billing, dropEmpty: true }, async (meter) => findOn(createClient({ token, meter, ownerId, readCap: 0, userCap: 2 }), { accountId, handle }));
}
// The find on a client `x` (a fake one in a test). The handle's lookup only says who (its fields
// are few: storing them would blank a stored bio), so the profile is then read whole by id, as the sync reads
// profiles (lib/x.js USER_FIELDS: the bio, where you stand), free the second time that UTC day, and stored through
// THE profile writer (sync.storeProfiles takes { users, missing }). → X's user (the whole profile) | null
async function findOn(x, { accountId, handle }) {
  const found = await x.userByUsername(handle);
  if (!found) return null;
  const read = await x.usersByIds([found.id]);
  await storeProfiles(read, { fetched: 0, gone: 0 }, accountId);
  return read.users[0] || found;
}

// Of their posts (newest first), the ones to like: not yours, not liked already, up to `n`, newest first. Pure.
function toLike(posts, liked, n, meId) {
  return posts.filter((p) => p.author_id !== meId && !liked.has(String(p.id))).slice(0, n).map((p) => String(p.id));
}

// Read `userId`'s latest posts on `x` (a client on the press's meter) until `n` of them aren't liked by `accountId`.
// A clean stop (the read cap, the balance's ceiling, X's limit or a hiccup) keeps what came. → [post ids to like]
async function latestToLike(x, { accountId, userId, n }) {
  const posts = [];
  const liked = new Set();
  let next;
  let size = firstPage(n);
  try {
    do {
      const page = await x.timelinePage(userId, "tweets", { paginationToken: next, maxResults: size, exclude: "replies,retweets", what: "tagged" });
      size = 100;
      next = page.nextToken;
      if (!page.posts.length) break;
      await storeContext(page.posts, accountId);
      const ids = page.posts.map((p) => String(p.id));
      (await Like.find({ accountId, likerId: accountId, postId: { $in: ids } }, "postId").lean()).forEach((l) => liked.add(l.postId));
      posts.push(...page.posts);
    } while (next && toLike(posts, liked, n, accountId).length < n && x.remainingPosts() >= 5);
  } catch (err) {
    if (!(err instanceof ReadCapReached) && !err.transient && !err.paced) throw err;
  }
  return toLike(posts, liked, n, accountId);
}

module.exports = { READ_MAX, quoteUsd, estimateUsd, findPerson, findOn, toLike, latestToLike };
