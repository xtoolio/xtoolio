# Live: X pushes to xtoolio, xtoolio pushes to the page

Status: **steps 1 (ingest) and 2 (SSE) BUILT**, and step 3's follows (follows and unfollows OF the account, X's
"inbound" filter); `oauth.revoke` not built. With **Keep syncing live** off (an account's choice), an hour without
xtoolio open pauses the account (services/away.js), which drops its subscriptions until it comes back.
Evidence for every X fact here: [ACTIVITY-API.md](ACTIVITY-API.md) (live spike on the owner's account). Anything
marked VERIFY is still inferred and gets checked in the step that needs it. The code (`services/live.js`,
`services/liveRules.js`) is the working reference for what's built.

Changed from this design while building step 1:
- Money: not one unit held open per account per hour (when units had per-unit real costs, an open unit marked
  every other unit overlapped; every unit is now charged exactly at X's prices anyway). Each billed event is a `LivePending` row; hourly, an account's rows
  become ONE short metered unit.
- `live.due` is set inside each door's own write (no shared helper, no import cycle), and an hourly `ensureAll` heals
  pauses, top-ups and missed flags instead of hooking billing.
- The pure rules live in `services/liveRules.js` (config-free, so verify loads them).
- VERIFIED: a database user with readWrite on this database only may open change streams (a one-off probe).

Changed while building step 2:
- `post` events don't pill on the Inbox (your own post isn't news there), only in its conversation; a post already on
  the page (a reply you just sent from the box) never pills.
- The first-pull progress page keeps its meta refresh: it shows the pull's progress counts as it goes, which one
  "done" event can't.
- Verified end to end on the running app (a minted session, a one-off check): status, a like row and a balance
  row arrived on /live with their ids; the like line came back drawn by the partial.

## The whole picture

```
X ──(one stream, the app's Bearer token)──▶ xtoolio-worker ──writes──▶ Mongo (posts, likes, people, follows)
                                                  │                         │
                                                  └──inserts──▶ liveevents ─┘ (one small row per change, per account)
                                                                    │
                                                         change stream (web process)
                                                                    │
                                     browser ◀──SSE GET /live── xtoolio-web (only that account's rows)
```

Two hops, each one-way, each server-driven: X pushes to the worker, the web process pushes to the open page. No
client polls anything. Sync stays, demoted to the catch-up pass.

## Hop 1: X → worker (the ingest)

**Transport: the stream, not a webhook.** Both are X's push (the X Activity API, "XAA"); the difference is who opens
the connection.
- Stream (`GET /2/activity/stream`): the worker opens ONE connection for the whole app, every account's events on it.
  Works on a development machine and on the server the same way; no public URL, no CRC handshake, no signature checking.
- Webhook (`webhook_id`): X calls a public HTTPS URL on xtoolio-web. Needs the deploy first, a CRC responder, HMAC
  signature checks, and the web process (not the worker) doing the ingest. X advertises "retry and recovery", but no
  retry policy was found in the docs, and catch-up (`backfill_minutes`) is refused on pay-per-use.
- Either way a gap is possible (worker restart, X outage), so sync's catch-up pass is needed with both. The stream is
  one mechanism with fewer moving parts. Revisit only if gaps prove common.

**Subscriptions: per account, made with that account's own user token** (X: "Subscriptions for private events can only
be created for users who have authorized your application"; the token's scope must match: `like.read` for likes,
`tweet.read` for posts, `follows.read` for follows). One subscription = one event type for one user.

| event | what it gives xtoolio | needs | X price |
|---|---|---|---|
| `post.reply.create` | someone replied to you: the Inbox, live | tweet.read | billed as a Post ($0.005) |
| `post.mention.create` | someone tagged you: the Inbox, live | tweet.read | as a Post |
| `post.create` | your own posts/replies made on X: conversations and the Inbox see your answer at once | tweet.read | $0.005 |
| `like.create` (no direction = both) | likes ON your posts (who, which post) and likes BY you (from X or another device) | like.read (Likes on) | not on the price list; measured $0.001 |
| `follow.follow` / `follow.unfollow` | new followers / unfollows of you, live (`direction: "inbound"`: never your own) | follows.read (Follows on) | $0.01 |

So 4 to 6 subscriptions an account. The self-serve cap is 1,500 subscriptions: ~250-375 accounts. Past that, new
accounts fall back to sync alone (logged) until the plan changes.

**The desired set is a pure function** of the account (`services/live.js desiredSubs(account)`): its granted scopes,
its extras, and whether it may spend (THE gate: out of runway = no subscriptions). `ensureSubs(account)` makes X match
it: list X's (`GET /2/activity/subscriptions?user_id=`), create what's missing, delete what's extra, save the ids on
`Account.live` (`{ subs: [{ eventType, id, direction }], ensuredAt, error }`; a subscription whose filter direction
isn't the registry's is made again, liveRules.js diffSubs). Called:
- by the worker on boot, for every account (X is the truth; a crash mid-change heals);
- after anything that changes the desired set: first sign-in, an extra turned on/off (its scope changes), a top-up
  that ends a pause, the gate refusing (out of balance), `needsReauth` (a refused token: delete with the Bearer token,
  which DELETE accepts).
The web process doesn't call X for this: it sets `Account.live.due = true`, and the worker (watching `accounts` with
the same change-stream mechanism as hop 2) ensures within seconds. One place talks to X about subscriptions.
A subscription change does NOT drop the open stream; it only delays a connection made while it provisions (503
`ProvisioningSubscription` on connect, ~2 minutes). Checked against the stream's recorded gaps (`LiveGap`, every outage
over 75 s): every first subscription made while the stream was up was followed by no gap, where a dropped stream
would have reconnected into the provisioning wait and left a ~2 minute gap every time. What remains: a reconnect for
any other reason (a deploy, X closing it) within ~2 minutes of a change waits it out; the reconnect's catch-up sync
covers what it missed.

**The stream loop** (`services/live.js`, worker only, started by app.js beside the scheduler): connect; read
newline-delimited JSON; hand each event to `ingest`; on any end or error, reconnect with backoff (20 s while
`ProvisioningSubscription`, then 5 s, 10 s, 30 s, 60 s capped). It writes its health to ONE doc
(`livestate`: `connectedAt`, `lastEventAt`, `lastError`) every 30 s (the heartbeat, `lib/heartbeat.js`), which the
header reads.

**Ingest: one function per event type, each storing through the SAME writers sync uses** (no second storage path):
- post events → `sync.store([post], accountId, kind)` (membership "mention" for reply/mention events, "own" for
  post.create; `$addToSet`, idempotent), `includes.tweets` as context (`$setOnInsert`), `includes.users` through
  `Person.store` (a free profile refresh: events carry current profiles).
- like.create, inbound (`liked_tweet_author_id` = the account) → the same `Like` upsert `storeLikers` does
  (`{ accountId, postId, likerId }`, unique). Outbound (`liking_user_id` = the account) → the same upsert the
  likes pass does; it clears `fromApp` like seeing it in X's list does.
- follow events → `liveRules.followEventFor` → a `FollowEvent` (the Follows page), and the pair through `Follow.fromEvent`.
Duplicate deliveries (a reconnect, two accounts subscribed to one post) are harmless: every write is an upsert.
`event_uuid` isn't stored. Events for an account xtoolio no longer has are dropped (and its subscriptions deleted).

**Sync after this:** unchanged code, a smaller job. It still does history, thread context, profiles, and catches up
anything the stream missed. Its forward pass re-reads posts the stream already stored; X bills a post once per UTC day,
so a re-read the same day is free (cross-midnight ones are paid twice: a few cents). Keep `SYNC_EVERY_MINUTES` at 15
for now. The daily "who liked your reply" check stays as the catch-up for likes (no backfill on pay-per-use).

**Money (the ledger, billing):** events trickle in all day, so the worker counts them per account and closes ONE
metered unit per account per hour, kind `live`, label "Live", lines recorded through the meter;
every delivery is billed, never deduplicated against a read (found by a cost audit). Billing charges it at X's prices, like every unit (docs/BILLING.md decision 3). New `READ_WORDS`: "3 replies to
you, live", "2 likes on your posts, live". The gate inside `metered()` refusing → `ensureSubs` removes that account's
subscriptions (paused accounts receive nothing, pay nothing). Owner caveat: a post event costs $0.005 where the owner's
own polling read costs $0.001 (Owned Reads).

## Hop 2: worker → page (SSE)

**The channel between processes: a `liveevents` collection.** Ingest (and the sync, and billing) insert one small row
per thing the page should know: `{ _id: ObjectId, accountId, type, data, at }`, TTL 1 day. The web process holds ONE
MongoDB change stream on it (inserts only) and fans each row out to that account's open connections. VERIFY first: the
app's database user (readWrite on this database only) may open a change stream (readWrite includes the `changeStream`
action; if not, a tailable cursor on a capped collection does the same job without widening the role).

**`GET /live`** (signed in; `text/event-stream`): sends only rows whose `accountId` is the session's account. `id:` is
the row's ObjectId, so a reconnecting EventSource sends `Last-Event-ID` and gets what it missed (rows after it, from
the collection) before going live. A comment line every 25 s keeps proxies from closing it. On deploy, nginx needs
`proxy_buffering off` for `/live`, and HTTP/2: browsers allow only 6 HTTP/1.1 connections per host, and each open tab
holds one (locally, over HTTP/1.1, 6+ tabs will stall).

**What the page does with it** (`public/js/live.js`, one EventSource per tab; every change is server-rendered HTML
from the pages' own partials, like the reply bubble, so there's one way to draw a post):
| row type | on screen |
|---|---|
| `inbox` (a new reply/mention) | Inbox: a "3 new · Show" pill at the top (cards never slide in under you mid-read or mid-reply); the Waiting / All counts move. Other pages: nothing |
| `like` (on your post, or yours from elsewhere) | the post's like line swaps in place, wherever that post is on screen (Inbox card, conversation): "♥ Maya" appears |
| `post` in an open conversation | a "New in this conversation · Show" pill |
| `sync` (a sync run finished) | the header's time; the first-pull page's progress (replacing its meta refresh poll) |
| `balance` (a charge or top-up) | the header balance |
| `status` (stream up/down) | the header's live dot |

**The header:** the sync status reads "● Live" (green) while the worker's stream is healthy (`livestate` heartbeat
fresh) and the account has its subscriptions, otherwise "Synced 4m ago". It isn't a button and has no tooltip: it
opens a small menu with Pause / Resume syncing. The ↻ beside it runs the catch-up sync now.

## What stays the same
- `lib/x.js` is still the ONE door to api.x.com: subscribe, list, delete, and the stream are methods there; the Bearer
  token comes from config (`X_BEARER_TOKEN`), the ONE reader of the environment.
- Every write still goes through the existing writers; the shared-store rules (membership, `$setOnInsert` context)
  are unchanged.
- A protected account's posts in the shared store: settled (`services/accountData.js visibleTo`: drawn only for an
  account X showed them to; a live event's posts count as shown to the account it was sent for).
- Terms / Privacy: policy follows code, so the same commit says xtoolio keeps a live connection to X for each account's
  replies, mentions and likes.

## Tests (verify, no network)
- `services/live.js` pure parts: `desiredSubs` per scopes / extras / gate; each event type → the writes it makes,
  from synthetic payloads shaped like the spike's (no real people's data in fixtures).
- verify-security: `/live` refuses signed-out; seeds `liveevents` for account A ONLY and asserts account B's stream
  gets nothing (a store both sides leave empty would pass vacuously); the CSP needs nothing new (EventSource is
  same-origin `connect-src`).
- verify-billing: the hourly live unit is charged through `billing`, and the gate removes subscriptions.

## Build order
1. **Ingest** (worker): config + lib/x.js methods, `services/live.js` (desiredSubs, ensureSubs, stream loop, ingest),
   `livestate`, the hourly ledger unit, tests. Done when: likes and a reply land in the database within seconds on the
   owner's account AND on a second, non-owner account (the first non-owner proof), and the ledger shows the live unit.
2. **SSE**: `liveevents`, the change stream (VERIFY the role first), `GET /live`, live.js, the Inbox pill and counts,
   like lines in place, the header's live state, the first-pull page off its meta refresh.
3. **Follows and revocation**: `follow.*` events into `Follow.record`; `oauth.revoke` (a user revoking xtoolio on X
   → `needsReauth` at once instead of at the next refused refresh).
