// Live's rules (services/live.js runs them): what xtoolio subscribes to and how an event becomes a stored like. Pure and
// config-free, so verify-people loads it without .env, like services/balance.js beside services/billing.js.
"use strict";

const { active, modulesOn } = require("./features");
const { yourLikeOp, likerOp, reposterOp } = require("./extras");

// Our subscriptions carry this tag; ensureSubs manages only those (a spike's or anything else on the app is left alone).
const TAG = "xtoolio";

// THE registry of what xtoolio subscribes to: per event type, the feature that must be active (every event is opt-in:
// Replies, live (inside the Inbox) / the Likes module / the Follows module), how a post event joins the account's posts (`kind`: sync.store's membership), and its ledger
// word (services/usage.js READ_WORDS), price class (lib/pricing.js PRICE) and the resource X dedups it as. A new event
// type is a row here plus its branch in live.ingest.
const EVENTS = [
  // Post events: the Replies, live extra ($0.005 each; without it they arrive with the 15-minute sync).
  { type: "post.reply.create", feature: "liveReplies", kind: "mention", what: "live-replies", cls: "post", resource: "post" },
  { type: "post.mention.create", feature: "liveReplies", kind: "mention", what: "live-mentions", cls: "post", resource: "post" },
  // Someone quoted your post (without this one never showed; no feed carries quotes, since they don't tag you).
  { type: "post.quote.create", feature: "liveReplies", kind: "mention", what: "live-quotes", cls: "post", resource: "post" },
  { type: "post.create", feature: "liveReplies", kind: "own", what: "live-posts", cls: "post", resource: "post" },
  { type: "like.create", feature: "likes", what: "live-likes", cls: "likeEvent", resource: "like" },
  // Someone reposting your post, plainly (X notifies it on a phone, so it belongs somewhere): the Likes module, beside
  // the likes. `row`: it stores a Repost, never the repost itself as a post (it "mentions" you, and a stored post that
  // mentions you would count as them talking to you). Billed as a post (INFERRED: lib/pricing.js repostEvent).
  { type: "post.repost.create", feature: "likes", row: "repost", what: "live-reposts", cls: "repostEvent", resource: "post" },
  // Follows and unfollows OF YOU only (`direction` "inbound", X's filter): $0.01 an event, measured, and the Follows page
  // lists only the ones to you. Both directions until then, so a heavy follower paid for every follow they made
  // themselves. X's docs define inbound for likes ("likes the user's Posts
  // receive") and list direction for follows without defining it: INFERRED to mean the same (being followed). What the
  // outbound half did that's gone: a follow you make on X itself updates your Follow button here at the next profile
  // read, not at once (a press here records the pair itself).
  { type: "follow.follow", feature: "follows", what: "live-follows", cls: "followEvent", resource: "follow", direction: "inbound" },
  { type: "follow.unfollow", feature: "follows", what: "live-follows", cls: "followEvent", resource: "follow", direction: "inbound" },
];
const EVENT = new Map(EVENTS.map((e) => [e.type, e]));
// The filter direction a type is subscribed with (null: X's default, both ways).
const directionOf = (type) => (EVENT.get(type) && EVENT.get(type).direction) || null;

// The event types this account should be subscribed to. None for an account that doesn't sync (no module picked yet,
// X refused its token) or that the gate refuses (`paused`: out of balance with billing on).
function desiredSubs(account, { paused = false } = {}) {
  if (!account || account.needsReauth || !modulesOn(account).length || paused) return [];
  return EVENTS.filter((e) => active(account, e.feature)).map((e) => e.type);
}

// What to change so X has exactly `want` (one subscription per type): create the missing types, remove the rest (types
// no longer wanted, and a second subscription of one type). `have`: X's list, ours only. → { keep, create, remove }
// A subscription whose filter's direction isn't the registry's (`directionOf`) is removed and made again: X keeps one
// per type, and ensureSubs removes before it creates. X's list is read for the direction; where it doesn't say (its
// shape there is unverified), what we recorded making (`recorded`: Account.live.subs, { id, direction }), else none.
function diffSubs(have, want, recorded = []) {
  const keep = new Map();
  const remove = [];
  const ours = new Map(recorded.map((r) => [r.id, r.direction || null]));
  for (const s of have) {
    const listed = s.filter && "direction" in s.filter ? s.filter.direction || null : ours.has(s.subscription_id) ? ours.get(s.subscription_id) : null;
    const sameDirection = listed === directionOf(s.event_type);
    if (want.includes(s.event_type) && sameDirection && !keep.has(s.event_type)) keep.set(s.event_type, s);
    else remove.push(s);
  }
  return { keep: [...keep.values()], create: want.filter((t) => !keep.has(t)), remove };
}

// One like event, as the Like it stores for this account (extras' own ops), or null when it's neither the account's
// like nor a like on the account's post.
function likeOpFor(payload, accountId) {
  const { liking_user_id: liker, liked_tweet_id: postId, liked_tweet_author_id: author, created_at: likedAt } = payload || {};
  if (!postId || !liker) return null;
  if (liker === accountId) return yourLikeOp(accountId, postId, author, likedAt); // the account liked something (on X, another device)
  if (author === accountId) return likerOp(accountId, postId, liker, likedAt); // someone liked the account's post
  return null;
}

// One repost event, as the Repost it stores for this account (extras.reposterOp), or null when it isn't someone else
// reposting the account's post. X calls it a post event, so its payload is taken to be the repost (id, author_id, its
// `retweeted` reference) with the original in includes.tweets; that shape is INFERRED until the first one arrives
// (services/live.js logs one it can't read). `data`: the event.
function repostOpFor(data, accountId) {
  const p = (data && data.payload) || {};
  const ref = (p.referenced_tweets || []).find((r) => r.type === "retweeted");
  const original = ref && ((data.includes && data.includes.tweets) || []).find((t) => t.id === ref.id);
  if (!ref || !p.author_id || p.author_id === accountId) return null;
  if (original && original.author_id && original.author_id !== accountId) return null;
  return reposterOp(accountId, ref.id, p.author_id, p.created_at || data.created_at);
}

// One follow event, as the FollowEvent it stores for this account, or null when the account is neither end. `data`: the
// event (event_uuid, created_at, event_type, payload { source, target }).
function followEventFor(data, accountId) {
  const p = data.payload || {};
  const source = p.source && p.source.data && p.source.data.id;
  const target = p.target && p.target.data && p.target.data.id;
  const kind = data.event_type === "follow.unfollow" ? "unfollow" : "follow";
  if (!data.event_uuid || !source || !target || source === target) return null;
  const at = new Date(data.created_at || Date.now());
  if (target === accountId) return { _id: data.event_uuid, accountId, direction: "in", kind, personId: source, at };
  if (source === accountId) return { _id: data.event_uuid, accountId, direction: "out", kind, personId: target, at };
  return null;
}

module.exports = { TAG, EVENTS, EVENT, directionOf, desiredSubs, diffSubs, likeOpFor, repostOpFor, followEventFor };
