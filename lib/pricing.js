// What X charges, and what a pull or refresh is likely to cost — the ONE place these numbers live. Pure.
//
// X API pay-per-use (docs.x.com/x-api/getting-started/pricing):
//   - reads bill "per resource returned in the response": a post $0.005, a user $0.010 (Following/Followers too).
//   - OWNED READS: $0.001 per resource for /2/users/{id}/tweets, /mentions, /liked_tweets, /followers, /following
//     (and a few we don't use) "when {id} matches the authenticated user and that user is the owner of the
//     developer app".
//   - "All resources are deduplicated within a 24-hour UTC day window": the same post or user returned again that
//     day isn't charged again (services/usage.js models this with ReadMark).
//   - Media from expansions has no price row; treated as free (inferred, not confirmed).
//   - WRITES bill "per request" (no dedup stated). The table has no row named for likes; the closest are "User
//     Interaction: Create" $0.015 and "Interaction: Delete" $0.010, taken here as a like and an unlike (INFERRED:
//     the ledger's real cost, X's balance around each press, is what settles it).
//     Measured: 7 likes moved X's balance $0.10 in all (~$0.014 each). X's balance reads in WHOLE CENTS, so
//     one $0.015 like settles as $0.01 or $0.02 by turns: a single write's "real" cost is rounding, the sum is right.
//   - A reply is "Post: Create" $0.015, or "Post: Create (with URL)" $0.200 when it carries a link.
//     The first reply settled at $0.01 (one sample; whole cents again).
//     X also lists "Post: Create (summoned)" $0.010 without defining it (a reply to someone who mentioned you, maybe);
//     the ledger's real cost settles which applies.
//   - LIVE EVENTS (the Activity API, docs/LIVE.md) bill "per event delivered". Post events
//     (post.reply.create, post.mention.create, post.create) are "billed as a Post": $0.005, even for the owner (they
//     aren't Owned Reads). like.create has NO row on the price list; it was taken as free until a cost
//     audit measured it at $0.001 (A LIKE EVENT, below), and every post event is billed, never deduplicated.
//     follow.follow / follow.unfollow are $0.01 an event, both directions (someone following you AND you following
//     someone): MEASURED, 6 events moved X's balance $0.06 with nothing else running
//     (docs/ACTIVITY-API.md).
// X's real spend per day is its balance (services/balanceClock.js reads it once a minute); these prices are what each
// run is recorded and charged at, and the quotes shown before a button is pressed.
"use strict";

// Price per resource, by class: "owned" (an Owned Read), else what the resource is; per request for a write; per
// event delivered for a live event ("likeEvent", "followEvent"). A follow / unfollow is INFERRED to bill like a like /
// unlike: X's "User Interaction: Create" / "Interaction: Delete" rows (the ledger's real cost settles it).
// "counts": one request to GET /2/tweets/counts/all (the front page's estimate): X's "Counts: All" row, $0.010 per
// request ("Counts: Recent", the 7-day endpoint used before, is $0.005). It was priced at
// the recent endpoint's $0.005 after the switch; the cost audit's fit measured recent at
// $0.0056 and all at $0.0100.
// A repost / unrepost (the ↻ press) INFERRED to bill like a like / unlike ("User Interaction" rows), and a repost OF your
// post (Live's post.repost.create) as a post: X has no row for it and says each post event "is billed as a Post"
// (docs.x.com activity). The ledger's real cost settles both.
// WHICH ROW A WRITE IS, matched against X's console ("Requests by day", over several days): our likes
// + follows = "User Interaction Create" exactly every day (so $0.015, VERIFIED as the row; the price is the list's); our
// unlikes + unfollows = "Interaction Delete" exactly ($0.010). Our replies = "Content Create" exactly, a name the price list
// doesn't have: $0.015 ("Post: Create") is still INFERRED. Each reply WITH PICTURES also makes one "PostCreate" (the
// counts matched reply for reply), most likely the upload: recorded since a cost audit as `mediaUpload` at "Post:
// Create" ($0.015, the row of that name; lib/x.js uploadMedia), INFERRED until a quiet picture reply settles it.
// X's own price list, where every number above comes from (the front page links it). Writes are its
// "Write operations" table, per request, with no owner rate.
const PRICE_LIST_URL = "https://docs.x.com/x-api/getting-started/pricing";
// A LIKE EVENT (Live's like.create, both ways: likes on your posts and your own) is $0.001, MEASURED: X's
// console counts them as "Like" billable events (its count within a few percent of ours over several days) and its daily
// cost is $0.001 × ours, and with it the ledger's days came within ±2% of X's real spend. It was taken as free (no row
// on the price list; an earlier spike couldn't see it under X's whole-cent rounding).
// A DIRECT MESSAGE (the waitlist's "you're in", sent by the site's own account: services/waitlistDms.js) is INFERRED as
// "DM Interaction: Create", $0.015 per request, the price list's only DM write row; the console's row
// for the first sends settles it.
const PRICE = { owned: 0.001, post: 0.005, user: 0.01, like: 0.015, unlike: 0.01, follow: 0.015, unfollow: 0.01, repost: 0.015, unrepost: 0.01, mediaUpload: 0.015, reply: 0.015, replyLink: 0.2, likeEvent: 0.001, followEvent: 0.01, repostEvent: 0.005, counts: 0.01, dm: 0.015 };

// Does this text carry a link, by X's lights (a URL, or a bare domain X turns into one)? It decides the reply's price
// row ($0.20 instead of $0.015), so the reply box warns before sending. Pure.
const hasLink = (text) => /https?:\/\/|\bwww\.|\b[a-z0-9-]+\.(com|org|net|io|ai|co|dev|app|xyz|me|so|gg|ly|tv|fm|news|info|us|uk|ca)\b/i.test(String(text || ""));

// The endpoints we call that qualify as Owned Reads (by their last path segment under /2/users/{id}/).
const OWNED_ENDPOINTS = new Set(["tweets", "mentions", "liked_tweets", "followers", "following"]);

// The price class of resources returned by GET /2/users/{userId}/{endpoint}, read with `ownerId`'s token when
// ownerId is the app owner (null otherwise). `type` is what the resources are ("post" | "user").
function classOf(type, { endpoint, userId, ownerId } = {}) {
  return ownerId && userId === ownerId && OWNED_ENDPOINTS.has(endpoint) ? "owned" : type;
}

// Dollars for billable counts by class: { owned, post, user }.
const costOf = (billed) => Object.entries(billed || {}).reduce((sum, [cls, n]) => sum + (PRICE[cls] || 0) * (n || 0), 0);

// A history pull costs more than its timeline posts: each one also brings thread context (the posts it
// replies to, read by id) and profiles (everyone it involves). Measured on the first real account's history
// pull: ~0.5 context posts and ~0.35 profiles per timeline
// post. Re-measure when there are more accounts; it varies with how much someone replies. The timeline posts
// themselves are Owned Reads for the app owner.
const CONTEXT_PER_POST = 0.5;
const PROFILES_PER_POST = 0.35;
const estimatePull = (posts, { owned = false } = {}) => posts * ((owned ? PRICE.owned : PRICE.post) + PRICE.post * CONTEXT_PER_POST + PRICE.user * PROFILES_PER_POST);

// A month going forward is lighter per post than a history pull (threads already read, people already known): on the
// first account's last 30 days (its own posts, replies and mentions, by
// accountData.activityMonthly's own counting) each post brought 0.41 posts around it in its thread and 0.25 people
// first seen that month. Used ONLY to estimate a month for someone not signed in (the front page,
// syncPrefs.estimateMonth); an account's own Settings measures its own. Re-measure when there are more accounts.
const MONTH_CONTEXT_PER_POST = 0.41;
const MONTH_PEOPLE_PER_POST = 0.25;
// Likes each of your posts and replies draws AS X DELIVERS THEM (the Likes module's like events, $0.001 each, billed per
// delivery): 2.1 on the first account, from the live like events themselves. Not X's like_count: stored
// when each post was read, often minutes after posting, it said 1.6; and X skips about a third of likes (docs/ACTIVITY-API.md), which it doesn't bill. The same "one account" caveat.
const LIKES_PER_OWN_POST = 2.1;
// YOUR likes over a history's stretch, per post and mention that history read: a first read reconciles your likes to it
// exactly (services/history.js firstReadLikes). 1.13 on the first account (its likes of posts inside the
// stretch its history covered, per post that history read); the earlier guess, one like per reply received, came out
// well short. The same "one account" caveat: someone
// who likes little pays less than quoted, someone who likes everything more (THE CEILING bounds it at the balance).
const LIKES_PER_POST_READ = 1.13;

module.exports = { PRICE, PRICE_LIST_URL, OWNED_ENDPOINTS, classOf, costOf, estimatePull, hasLink, CONTEXT_PER_POST, PROFILES_PER_POST, MONTH_CONTEXT_PER_POST, MONTH_PEOPLE_PER_POST, LIKES_PER_OWN_POST, LIKES_PER_POST_READ };
