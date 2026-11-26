# Modules: xtoolio as four things you can buy separately

Status: **built** (written to hand over; the three decisions answered and steps 1–7 built). The code (`services/features.js`) is the record of how it works now; this doc keeps the design, the decisions and what's open.
Changes made while building, beyond the plan below: the Inbox's floor is a week before it was FIRST turned on
(`features.inbox.first`), not before the account joined, so turning it on long after joining doesn't list months of old
replies as Waiting; an account that reads no conversations is quoted the Inbox and People from its real week on X
(the estimator), never "+$0"; the start page is the front page's picker (one partial), priced from the account's own
week. This doc is the design and the plan; the code stays the record of what's built.

## The ask

- every paid thing is its own switch: you opt in to everything;
- from the base (just the Inbox) to everything, dead simple, on the front page and through the app;
- someone can take just the Inbox, or just Likes, or just Follows, or just People.

So: no fixed base. Four **modules**, each on or off on its own, in any combination, each priced before you choose,
and the app shows only what you turned on. The front page's estimator (built, see below) and Settings become the same
list, and sign-up starts from what you picked.

## The four modules

| Module | Tab | What it shows | What it needs from X |
|---|---|---|---|
| **Inbox** | Inbox | Replies, mentions, quotes to you, one card per conversation, Waiting / Done | the mentions feed, your own timeline (your answers, "answered"), thread context (parents, quotes), profiles of the people in the cards (once each) |
| **People** | People | Everyone you go back and forth with, ranked; a person's conversations | your own timeline + mentions over your HISTORY (the "how far back?" read), thread context, profiles kept fresh by tier (top N weekly, rest monthly) |
| **Likes** | Likes | Who liked your posts, live | Live `like.create` events ($0.001 each, measured; they carry the liked post and both profiles); the likers check only for stream gaps (models/LiveGap.js) |
| **Follows** | Follows | Who followed / unfollowed you, as X sends them (best effort) | Live `follow.follow` / `follow.unfollow` ($0.01 an event; follows of you only, X's "inbound" filter); nothing re-reads what X doesn't send (the follower check was deleted) |

Inbox and People share the expensive part (reading your conversations). Likes and Follows are nearly independent of it.

### Cost of each, alone

Priced on the first account's volume (X's counts endpoint, matching the store): the Inbox is most of the
month (posts + mentions + context + new people, i.e. the "base" minus the profile tiers); People adds the profile
tiers and the history read once; Likes is small (gap checks only); Follows grows with follow churn ($0.01 an event).

(As built: no waterfall. The prices were made to ADD UP, as Settings' rows with a total, so each row is
its own part and the Inbox's reading counts for People even with the Inbox off: services/modulePrices.js.)
These were the right numbers to show as a **waterfall of marginal costs** in a fixed order (Inbox → People → Likes →
Follows): each step is what that module ADDS given the ones above it. The front page drew this shape as a waterfall
at the time; it now draws the picker (`services/estimateView.js moduleEstimate`, `views/partials/module-picker.hbs`).

## Decisions

**Decided** (all three, as proposed):

1. **Likes = who liked YOUR posts.** "The posts you like" (`liked_tweets`, $0.005 each for a paying account) is a
   different thing: it feeds People's "You liked" counts and the ♥'s liked
   state. Read it only when People is on, or when Liking is on (the ♥ must know what you've liked). The old
   Likes extra read both. So: `extras.runLikes`' "your likes" half is gated by people || liking, its likers-check half
   by likes; Liking's `needs` becomes inbox | people (it no longer needs the Likes module). Considered and not taken:
   the ♥ learning your likes only from Live's free `like.create` events (they carry your own likes too) and presses
   made in xtoolio; cheaper, but a like made on X while the stream was down would show an empty ♥.
2. **Follows = one module.** Merge `follows` (free badges) and `followsLive` (events + check) into one key. The free
   "Follows you / Mutual" tags come with whichever module reads profiles (Inbox or People) regardless; the Follows
   module is the live events, the follower check and the Follows tab. Open check this rests on: whether X's
   `connection_status` needs `follows.read` (UNVERIFIED). Test on an account without it in step 1: if it
   does, the tags need that scope at base (a read, asked of every sign-in), else they come with no extra scope.
3. **At least one module per account, no default**: picked at sign-up (pre-filled from the front page's estimator);
   the page can't be left with none. REVISED for the front page: its estimator starts with all four
   ticked, so the full price shows and an untouched "Get started" asks for all four.
   **REVERSED** (after the first real sign-up: choosing modules up front was too hard, so the default is
   everything; a hidden "choose what you use" on the start page went too, since choosing modules is a
   monthly matter, not an onboarding one): the start page is the onboarding, with no module choice on it. Get started turns EVERY module on and records how far back to read in one write, an option the balance
   covers (and the read can't charge past the balance: THE CEILING, docs/BILLING.md). Changing modules is Settings'
   job. Signing in turns nothing on (the front page's picks don't ride `?add=`: they'd have skipped that
   page); the front page keeps its switches as an estimator.

REVISED while building, as built:
- **Add-ons have no switch of their own.** Replies, live, Liking, Replying and Following are active whenever a module
  that shows them is (the Buttons toggles were removed; live replies come with the Inbox as the front page priced
  them). Only the four modules are switched.
- **Every sign-in asks for every scope** (no half state): incremental consent is gone; switching a module on never
  leaves the site.
- **Settings' What you use IS the front page's picker**, priced by the same estimate for the account's real week, so
  the figures a person was quoted are the figures they see (every assumption the same); the per-account profile
  choices are gone (one policy, `syncPrefs.PROFILES`), and Settings' own engine (`accountData.activityMonthly`) with it.

Settled (keep):
- Every paid live thing comes with a module (liveRules.EVENTS has no event without one): post events with the Inbox
  (free for paying accounts, $0.004/post extra for the owner), like events with Likes, follow events with Follows.
- Writes are charged per press, drawn by the module that shows the button: Liking (Inbox, conversations), Replying
  (Inbox, conversations), Following (Follows, People, a person's page).
- One column for feeds; tabs only for modules that are on.
- Never fold new X spend into an existing switch.

## Plan (each step its own commit, verify green, screenshots where it shows)

1. **Registry.** `services/features.js` grows a MODULES list (inbox, people, likes, follows) beside the extras, with
   `needs` for the nested extras (liveReplies → inbox, liking → inbox|people, replying → inbox|people, following →
   follows|people, profile tiers → people). `Account.features.<module>` paths (mongoose strict drops unknown $set:
   verify-people checks FEATURES vs Account.features). Migration: the owner gets all four on (a one-off script). Decide what an account with NO module sees (a "pick what you want" page, like "how far back?").
2. **Sync gating** (`services/sync.js runPasses`): timeline + mentions + context only if inbox || people; profile
   tiers only if people (Inbox still looks up new people once); `liked_tweets` only per decision 1; the follower check
   only with follows; the likers check only with likes. Live subscriptions already per extra (liveRules.desiredSubs):
   map them to modules. The first pull ("how far back?", services/history.js, scheduler startFirstPulls) only with
   People; Inbox alone starts a week before joining (inbox.inboxStart already does this).
3. **Settings** (`views/settings.hbs`, web.js `/settings`): the four modules as the top-level rows (switch + monthly
   price, same numbers as the front page). (Superseded: see REVISED above; Settings renders the front
   page's picker itself.)
4. **Tabs and pages** (`views/layouts/main.hbs`, `res.locals.tab`): a tab per module that's on; the red counts
   (inboxCount, unseenCount) only for modules that are on; routes for a module that's off show "turn on X" with its
   price (not a 404).
5. **Sign-up** (`routes/auth.js`, `readyOrRender` in web.js): carry the front page's choices (`?inbox=1&likes=1…`)
   through sign-in (the session's `oauth` holds `tz` the same way); then "how far back?" only if People.
6. **Front page** (then `web.js landingCost`, now `services/estimateView.js landingView`; `views/landing.hbs`): the four modules as the switches (replacing "Inbox,
   always on" + three extras), marginal waterfall in the fixed order, the measured base split into Inbox's part and
   People's tiers. Policy follows code: Terms, Privacy, README, "What it does".
7. **Docs**: modules, gating, what each tab needs; superseded notes deleted whole.

## Where things are now (so the next session doesn't re-derive them)

- **Front page estimator**: `services/estimator.js` (a typed @handle → profile + X's post counts
  over the last 30 days, ~3¢, platform-paid, capped 5/visitor/day and 500/day), `services/estimateView.js`
  (`moduleEstimate` / `landingView`: the picker's rows through `syncPrefs.estimateMonth` and
  `services/modulePrices.js`), drawn by `views/partials/module-picker.hbs` in `views/landing.hbs` section `#estimate`
  and in Settings.
- **Modules and add-ons** (`services/features.js`): the four modules (inbox, people, likes, follows) are the only
  switches; the add-ons (live replies, liking, replying, following, pictures, reposting) come with them. Live events:
  liveRules.EVENTS, every one gated by a module.
- **Feeds**: Your posts (`/posts`, services/likes.js; `/likes` redirects there), Follows (`/follows`, services/follows.js, models/FollowEvent.js),
  one counter module `services/unseenCount.js`, one feed shape in public/js/live.js (`intoFeed`).
- **Follower check**: DELETED (it was services/followers.js: X's follower count against the live events every
  sync, the newest followers read when it rose, and a priced whole-list "Find out who" read when it fell). The Follows
  tab is best effort; bulk actions are offered only on Not following back. It was built for a machine that slept; on
  an always-on server it mostly surfaced X's own skips (one unexplained drop with the stream up), and its follows half
  could only name anyone after a whole-list read.
- **Stream gaps**: models/LiveGap.js (recorded at each reconnect > 75 s); the likers check reads only replies whose
  first day overlapped one.
- **X facts this rests on**: docs/ACTIVITY-API.md (follow events both directions, $0.01; like events $0.001, measured (first taken as free); start_time
  accepted but ignored and backfill_minutes refused on pay-per-use; followers list newest-first, no since filter; post
  counts endpoint works with the app token, ~$0.005 a request; counts/all, used now, is $0.010).

## Open, not part of this

- The header redesign: proposed (picture as the menu; tabs stay visible; a bottom tab bar on phones); not decided. With modules, the tab count varies 1–4, which helps the phone header.
- The front page's "new people" scale linearly with posts (0.25 a post, from one account); likely high for very heavy
  posters. Recalibrate when there's a second account.
- **LEARNED HABITS (banked: update the habits with each onboarded account; build it at 5 accounts with a
  week of data each).** The estimate's per-handle measures are X's counts
  (posts and replies a day). Everything else is a habit: lib/pricing.js `MONTH_CONTEXT_PER_POST` 0.41,
  `MONTH_PEOPLE_PER_POST` 0.25, `LIKES_PER_OWN_POST` 2.1 (all the first account's), and What you send's defaults (the
  rule "you like and answer every reply you get", since X has no per-handle measure of either). Every onboarded account
  already records each one: UsageEntry lines per day (`context`, `profiles`, `liked`, `replied`, `reposted`), Like rows
  with `likedAt` (likes on its posts as delivered), and the replies and mentions it receives (Post membership). Shape: a
  worker job once a day computes each habit per account over its last 30 days (only accounts with 7+ days of a module
  on), takes the MEDIAN across accounts (one heavy user can't skew it), and stores it in ONE doc (`models/Habits.js`,
  with how many accounts and when); moduleEstimate reads it, falling back to today's constants / rule below 5 accounts.
  The estimate says "based on N accounts" beside a learned figure. Mind: the owner is an outlier (bulk likes, a viral
  week); the median is why.
