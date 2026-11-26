# X Activity API (push): spike findings

Question: X's API has push (webhooks, a stream); should it replace the sync? Not built yet when written; this is what
a live spike on the owner's account established, so the decision is made on evidence.

## Products (docs.x.com)
- **Account Activity API**: being deprecated ("Check out the X Activity API (XAA)"); pay-per-use gets 3 subscribed
  users and 1 webhook. Not an option.
- **X Activity API (XAA)**: the forward product. Delivery by webhook (`webhook_id`, needs a public HTTPS endpoint, CRC,
  signatures) or a persistent HTTP stream, `GET /2/activity/stream`. Self-serve cap: 1,500 subscriptions.
- Filtered stream webhooks: Enterprise only.

## Verified live (owner's account, pay-per-use)
- **Subscriptions are allowed on pay-per-use.** `POST /2/activity/subscriptions` with the owner's OAuth 2.0 USER token,
  one per event type: `{ event_type, filter: { user_id }, tag, expires_at }` → 200. The response nests the object as
  `data.subscription` (the quickstart's flat `data` is wrong). GET (`?user_id=`) and DELETE also take the user token.
  `expires_at` works: a crashed run's subscriptions die by themselves.
- **The stream takes ONLY the app's Bearer token** (`.env X_BEARER_TOKEN`, from the console's Keys and tokens). A
  client-credentials token minted from the OAuth 2.0 client id/secret (`POST /2/oauth2/token`, client_type
  third_party_app + scope) is issued but the stream calls it "Unknown" authentication.
- **No catch-up on pay-per-use**: `backfill_minutes` → 400 "Stream is not authorized to use backfill_minutes". Events
  while disconnected are lost, so a slower reconciliation sync must stay.
- **`start_time` is accepted and ignored** (a one-off test with the app stopped meanwhile):
  the stream's documented `start_time` / `end_time` ("the earliest UTC timestamp from which the activities will be
  provided") answer HTTP 200 with `start_time` 4 and 60 minutes back, and deliver NOTHING older than the connection,
  though the app had stored 30 events (19 likes, 5 replies/mentions, 5 own posts, 1 follow) live in that hour. X closed
  each test connection after ~25 s. `backfill_minutes=5` was refused again. The docs name no plan for either (they say
  `backfill_minutes` is at most 5). So nothing replays on pay-per-use: the catch-up sync is the answer (a follower
  check was built for follows and deleted: the Follows tab is best effort). The follower list (`GET /2/users/:id/followers`) takes only `max_results` / `pagination_token` (no since or
  time filter, order unstated: newest-first is measured, not documented), and no v2 endpoint lists unfollowers.
- After a subscription change the stream answers 503 `ProvisioningSubscription` ("try again in a minute") for about
  2 minutes; retry every 20 s worked.
- Rate-limit headers on the stream: limit 450 / 15 min (connections).
- **`like.create` with no direction delivers both ways**, within seconds: likes BY the account (including ones made
  through xtoolio's own ♥) and likes ON its posts. Payload: `liking_user_id`, `liked_tweet_id`, `liked_tweet_author_id`,
  `created_at`; `includes` carries the FULL liked post and FULL profiles of both people (public_metrics, bio,
  picture, entities). 19 events in 20 minutes, incl. 6 from a second test account liking the owner's posts.
- **But X does NOT send every like on your posts** (measured, owner): from the first live like
  to the day of the measurement, of the likes on the owner's posts that were stored, 35% only came from the likers
  check a day later. About a fifth of the likers never had a like arrive live (one of them several likes, all found
  later). The stream's gaps (LiveGap: a minute or two at each reconnect) can't account
  for a third of a day, so it's X's side; WHICH likes it skips is unknown (the likers it skipped were public,
  blue-verified accounts, as most likers are). The case that found it: someone's like of a reply posted while
  connected, in X's own notifications, never in the stream. Consequence: since the likers check only reads replies
  posted around a gap (services/extras.js likersWindows, a cost decision), a like X skips on a reply
  posted while connected is never seen. Kept that way by decision, and said plainly: the Likes module's description
  says "X doesn't send every like, so some you'll only see on X" (services/estimateView.js MODULE_WORDS).
  To make Likes complete again, check every reply a day after posting.
- Not exercised in the spike window: `post.reply.create`, `post.mention.create` (see the next bullet). Follows weren't
  subscribed (`follow.follow` / `follow.unfollow`, $0.01 an event on the price list).
- **A reply further down YOUR thread never arrives live** (measured, owner, from the
  post subscriptions' creation on): posts tagging the owner, by whether they were stored within 30 s
  of being written (Live) or later (a sync): direct replies to the owner's posts 132 live / 56 later (the later ones
  most likely stream outages, not verified); replies to SOMEONE ELSE that tag the owner (X's "@them @you" reply prefix)
  3 / 93, and those 3 landed together 28 s late, a catch-up sync's signature, so effectively none. None of the 93 had
  the @handle typed in the text. X documents exactly this (docs.x.com, X Activity API):
  `post.reply.create` "Direct replies only (does not fire for replies to replies)"; `post.mention.create` "Fired when
  another user explicitly @mentions the filtered user in the body of a Post. Does not fire for implicit mentions
  carried by replies or reposts." X's mentions FEED (`GET /2/users/:id/mentions`) does return them. The case that
  found it: a GIF reply to a reply in the owner's thread, in X's notifications, in the Inbox only 15 minutes later.
  Answer: THE MENTIONS CHECK (services/sync.js checkMentions, services/mentionsCheck.js): the mentions feed read forward
  every 30 s for accounts someone has open (models/Presence.js). A per-post `post.reply.create` filter (`post_id`, "a
  reply to a reply matches the intermediate reply's ID") would need a subscription per reply in every active thread,
  against the 1,500 cap. Not tried: filtered stream (a separate product) with a rule per account.

## Follows spike (a one-off script, owner only, ~3 minutes of events)
- `follow.follow` and `follow.unfollow` subscribe with the owner's existing scopes (it has `follows.read`; whether
  they need it is still unknown: not tried on a token without it). Events arrived within a minute of subscribing, no
  503 provisioning wait this time.
- **Both directions, both events**: a second account following and unfollowing the owner (source = them, target =
  the owner), AND the owner unfollowing and re-following two accounts (source = the owner). So an unfollow OF you is
  delivered live; tell the direction by `payload.source.data.id` vs `payload.target.data.id`.
- Envelope: `data.event_uuid`, `data.created_at` (when it happened), `filter`, `event_type`, `tag`, `payload { source:
  { data: <full user> }, target: { data: <full user> } }`: full profiles of both (public_metrics, bio, picture,
  entities), so each event is also a free profile refresh of both people. Note the shape differs from post/like
  events: users sit under `payload.source.data` / `payload.target.data`, not `includes.users`.
- **Cost: $0.01 an event, as the price list says**: 6 events moved X's balance $0.06, nothing else ran in the
  window (no app events arrived). These are billed, and the owner's own follows count too.
- Not exercised: someone who never interacted with you (the second account had), a protected account, a block or a
  removal by X (suspension) — whether those emit `follow.unfollow`.
- **Missed while disconnected** (the stream down for hours once): nothing replays them. A follower
  check was built for it, then deleted (the Follows tab is what X sends, best effort). `GET
  /2/users/:id/followers` is NEWEST FOLLOWER FIRST: of the owner's top 100, the ones not in an earlier snapshot came
  first in one unbroken block, then only snapshot members. A re-follow moves you to the top.
- **Churn is real**: the first account saw dozens of follow events a day, both directions counted, each billed at
  $0.01. Worth pricing per account (the estimate asks for follows a day).

## Cost
- Creating / deleting subscriptions and holding the stream: $0.00 (three runs, exact balance readings).
- The 20-minute stream with 19 like events: the balance moved by what the owner's likes and replies through xtoolio
  cost at the inferred write prices, within a cent. What's left for the 19 events is inside X's whole-cent
  rounding: **at most a few cents, plausibly free**. `like.create` has no row on X's price list. Post events
  (`post.reply.create`, `post.mention.create`) are documented as billed as a Post ($0.005).
- **CORRECTED by the cost audit** (X's real spend per UTC day, over several days): (1) a
  like event is NOT free: $0.001 each, both ways. X's console counts them as "Like" billable events (its count within
  a few percent of ours) and its daily cost is $0.001 × ours. (2) A post event is billed on EVERY delivery,
  never deduplicated against a read of the same post earlier that UTC day (X: "billed per event delivered"); the
  ledger had priced those as free. With both corrected (before any account was charged), the ledger's days match X's
  real spend closely.

## What it would replace
- The likers check (a day after posting, or the ↻ "Did X like it?"): likes on your posts arrive live with the liker.
- Mentions/replies polling for the Inbox: real time for direct replies and typed @mentions only; replies further down
  a thread still need the mentions feed (above: the mentions check, every 30 s while the app is open).
- Profile refreshes, partly: every event carries current profiles of the people in it.
- It does NOT replace history (backfill), thread context, or catching up after downtime.

## Shape if built
The worker (pm2 `xtoolio-worker`) holds ONE stream for the app; each signed-in account gets subscriptions created with
its own user token (like.read for likes, tweet.read for posts); events are stored through the same writers the sync
uses (`Post.fromApi` / `Person.store` / `Like`), keyed by `filter.user_id`. Sync stays as the reconciliation pass.
Subscriptions per account: 3 to 5 (likes, replies, mentions, follows), so ~300 accounts fit the 1,500 cap.
