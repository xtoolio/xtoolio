const mongoose = require("mongoose");
const { THEMES, DEFAULT_THEME } = require("../lib/theme");

// Someone who signed in with X. `_id` is their X user id — the same id their posts carry as authorId and the
// id Post.accounts[].id points at, so their data needs no join table.
//
// tokens: their OAuth 2.0 user tokens, sealed with lib/crypto.js (AES-256-GCM). The access token lasts ~2h; the
// refresh token (scope offline.access) gets a new access token AND a new refresh token each time (X rotates
// them), so services/accounts.js saves both after every refresh. Only the sync opens them, right before
// calling X.
// needsReauth: a refresh X refused (revoked in X's settings, expired). Syncing stops for this account until
// they sign in again, which clears it.
const SealedSchema = new mongoose.Schema({ v: Number, iv: String, tag: String, data: String }, { _id: false });

// (What X has cost lives on the usage ledger, models/UsageEntry.js + BalanceReading.js; what the account has been
// charged, on models/BalanceEntry.js. The account holds only the balance itself.)
// A module or add-on (services/features.js): on or off, `since` = when it was last turned on, `first` = when it was
// first turned on, ever (the Inbox starts a week before that: inbox.inboxStart). Written by features.turnOn.
const FeatureSchema = new mongoose.Schema({ on: { type: Boolean, default: false }, since: Date, first: Date }, { _id: false });

const AccountSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    username: { type: String, required: true },
    name: String,
    // Their own picture, for the header: kept here (not looked up from Person per request) and refreshed at
    // sign-in and by Person.store whenever anything refreshes their own Person doc.
    image: String,
    // Their own follower / following counts, for the header (same refresh points as `image`).
    followers: Number,
    following: Number,
    // +1 with every write of those two (a read of your profile, a follow pair flipping), carried by each LiveEvent "me"
    // and drawn on the header (data-me-v): "me" notes from two processes can land out of order, and an open page takes
    // only a newer one (public/js/post-actions.js xtoolioMe.set).
    countsV: Number,
    tokens: {
      access: SealedSchema,
      refresh: SealedSchema,
      expiresAt: Date,
      scope: String,
    },
    needsReauth: { type: Boolean, default: false },
    lastLoginAt: Date,
    // X's tweet_count at sign-in: sizes the "how far back?" options (services/history.js).
    postCount: Number,
    // X's like_count at sign-in: how many likes a first read can have to reconcile, at most (history.firstReadLikes).
    likeCount: Number,
    // Their choice of how far back to read (posts + mentions, going backwards). Unset = not chosen yet: the
    // home page asks, and the scheduler leaves the account alone until it's answered.
    // `further`: READ FURTHER BACK asked and not done yet (services/further.js): the depth before it (`from`), whether to
    // move the Inbox's start back when done (`inbox`), when (`at`). The sync takes it in stages and removes it.
    history: { budget: Number, chosenAt: Date, further: { type: new mongoose.Schema({ from: Number, inbox: Boolean, at: Date }, { _id: false }), default: undefined } },
    // WHERE THE INBOX STARTS (services/inboxStart.js): `want` (set by Get started) = open with the newest
    // N replies once the first read is done, resolved then into `id` (an X id: replies from it on are the Inbox), which
    // the Inbox's "Load 20 earlier replies" moves back. Unset: accounts from before, on inbox.inboxStart's week.
    inboxFrom: { want: Number, id: String },
    // THE INBOX'S WINDOW (services/inboxStart.js WITHIN): "1d" shows only the last 24 hours (the start moves up to then,
    // so the cards, the red count and the agent's inbox follow); unset, everything from the start.
    inboxWithin: { type: String, enum: ["1d"] },
    // The modules switched on (services/features.js MODULES): every module needs its path here, or mongoose's strict
    // mode drops the $set that turns it on (Liking once shipped without one; verify-people checks the two lists
    // match). The add-ons have no switch of their own: they come with a module.
    features: {
      inbox: { type: FeatureSchema, default: () => ({}) },
      people: { type: FeatureSchema, default: () => ({}) },
      likes: { type: FeatureSchema, default: () => ({}) },
      follows: { type: FeatureSchema, default: () => ({}) },
      likestorm: { type: FeatureSchema, default: () => ({}) }, // LIKESTORM ONLY (services/features.js): beside the modules
    },
    // Light / dark / follow the system (lib/theme.js, the one list; light by default). Rendered server-side on
    // <html data-theme>, so there's no flash.
    theme: { type: String, enum: THEMES, default: DEFAULT_THEME },
    // The interface font (lib/fonts.js keys; unset = the default there). Rendered on <html data-font>.
    font: String,
    // The accent colour (lib/accents.js key, Settings → Accent); unset = the default.
    accent: String,
    // The sidebar (views/partials/side-nav.hbs) folded to its icons, on a screen wider than a phone. Rendered
    // server-side on <body>, so a page never draws open and then folds.
    navCollapsed: { type: Boolean, default: false },
    // Your media's pins (services/mediaLibrary.js): X's media keys of pictures from your own posts you keep at the top of
    // the reply box's 📎 panel, newest pin first, at most PINS_MAX. Keys only: the pictures stay on X.
    mediaPins: { type: [String], default: undefined },
    // SAVED MEDIA (services/mediaLibrary.js save): photos and GIFs from OTHER people's posts you kept, newest
    // first, at most SAVED_MAX. A reference only (X's media key, the post it's in, its author: who it's tagged to);
    // the picture stays on X and is fetched from there when you send it, as your own are.
    mediaSaved: { type: [new mongoose.Schema({ key: String, postId: String, by: String, at: Date }, { _id: false })], default: undefined },
    // REMOVED from your media (services/mediaLibrary.js hide): X's media keys of pictures in your own posts you took off
    // the Media page and the 📎 panel, newest first, at most HIDDEN_MAX. The posts stay on X; only xtoolio's list skips
    // them.
    mediaHidden: { type: [String], default: undefined },
    // When the Media page was last opened: the sidebar's Media count is what you saved since (mediaLibrary.unseenOf).
    mediaSeenAt: Date,
    // Your circle (services/circle.js) as a public page, /@<username>, opt in (People → Your circle → Share). `ids`: who's
    // in it, in order, kept while it's public (so the public page and its image need no ranking of their own): written
    // when it's turned on, when you open your circle and by every sync run's profile pass, only when it changed; `at`
    // when it last changed (the image's cache key). Turned off: ids and at are removed. `size`: how big it's drawn
    // (services/circle.js SIZES: "50" the classic, the default; "100"; "250"), picked on the circle page, kept public or
    // not. The public page leaves out private accounts (routes/people.js publicCircle).
    circle: {
      public: { type: Boolean, default: false },
      ids: { type: [String], default: undefined },
      at: Date,
      size: { type: String, enum: ["50", "100", "250"] },
    },
    // Live (services/live.js, docs/LIVE.md): this account's subscriptions to X's activity stream, as last made to match
    // live.desiredSubs. `due`: something changed what it should have (a sign-in, an extra on or off, a pause); the
    // worker sees the flag (a change stream on accounts) and makes X match within seconds. `error`: the last attempt's.
    live: {
      // `direction`: the filter it was made with ("inbound": follows of you only; services/liveRules.js EVENTS).
      subs: { type: [{ eventType: String, id: String, direction: String, _id: false }], default: undefined },
      due: Boolean,
      ensuredAt: Date,
      error: String,
    },
    // The IANA zone every date is shown in (lib/timezone.js; unset = UTC). The browser's, saved at the first
    // sign-in that reports one; changed in Settings.
    timeZone: String,

    // ── Billing (docs/BILLING.md; moved ONLY by services/balance.js, which writes a BalanceEntry with every move) ──
    // The prepaid balance in integer micro-dollars ($1 = 1,000,000): a sync often costs X a fraction of a cent, which
    // whole cents would round to nothing. Charges may take it below zero by one unit (the gate stops the next one).
    balanceMicros: { type: Number, default: 0 },
    // This account's own multiplier on X's cost (design partners), in [1, 3]; unset = the platform's
    // (MARGIN_MARKUP_PCT). Set with scripts/margin.js; `marginNote` says why.
    marginMultiplier: Number,
    marginNote: String,
    // The markup charged this calendar month (UTC "YYYY-MM"), against the monthly cap (MARKUP_CAP_USD): moved only by
    // services/balance.js chargeUnit, in the same atomic write as the charge.
    markupMonth: String,
    markupMicros: Number,
    // The app OWNER only: X's API credit as last read (services/accounts.js readOwnerBalance saves it with every
    // reading), so the header can show it without a lookup per page. The readings themselves are BalanceReading.
    xBalance: { usd: Number, at: Date },
    // X's write windows the header's countdown shows (a like, a follow, a reply...: lib/writeLimits.js `shows`: spent,
    // or a bulk one used at all), window → { left: X's remaining, ends: its reset }, kept by services/ratelimits.js
    // from X's own answers, so the countdown needs no lookup per page.
    writeLimits: { type: Map, of: new mongoose.Schema({ left: Number, ends: Date }, { _id: false }) },
    // The Inbox tab's red count: the likes and replies you still owe (services/inbox.js owedCount; services/inboxCount.js
    // keeps it; unset until first counted). It replaced `inboxWaiting`, the cards Waiting.
    inboxOwed: Number,
    // The Likes and Follows tabs' counts: their rows xtoolio stored after the account last opened that page
    // (services/unseenCount.js keeps both pairs). A new account starts caught up.
    likesSeenAt: { type: Date, default: Date.now },
    likesUnseen: Number,
    followsSeenAt: { type: Date, default: Date.now },
    followsUnseen: Number,
    // The exactly-once guard: the last 500 movements applied ("run:<UsageEntry id>", "topup:<invoice id>"). A
    // movement's filter requires its key absent and pushes it in the same atomic write as the $inc.
    appliedRefs: { type: [String], default: undefined },
    // Their customer in xtoolio's Stripe account (services/billing.js ensureCustomer: verified before reuse, so an id
    // from test mode read under the live key is replaced, not a dead end).
    stripeCustomerId: String,
    // Auto-refill (services/autoRefill.js): when a charge leaves the balance at or under AUTO_REFILL_THRESHOLD_CENTS,
    // charge the saved card `amountUsd`. The card is Stripe's (we keep its id and a label, never the number).
    // inFlightAt is the claim (one refill at a time, across processes; stale after 15 min), lastAttemptAt the cooldown
    // (an hour between attempts); two failures in a row switch it off (disabledReason "failed") with the cause in
    // plain words (lastError). Saving a card resets all of that. `monthlyLimitUsd`: THE MONTHLY LIMIT on refills (autoRefill.js
    // LIMITS, 0 = none; unset = its default); `limitMonth`: the month (UTC "YYYY-MM") it last stopped a refill (the banner).
    // THE PAUSE (services/pause.js): `at` when reading stopped, `why` "you" (Settings' switch), "balance" (it ran out:
    // services/balance.js chargeUnit, as it crosses $0) or "away" (Keep syncing live off and an hour without xtoolio
    // open: services/away.js). Unset while running. `resumedAt`: the last resume that asked for a read of what was
    // missed (features.pullDue starts it at once, like a first read).
    pause: { at: Date, why: String },
    resumedAt: Date,
    // KEEP SYNCING LIVE (services/away.js): false = stop after an hour away and ask on return. Unset = on (the default).
    keepLive: Boolean,
    // When the account last had xtoolio open (a tab's live stream joined: services/livePush.js join), at most every few
    // minutes: Admin → Activity's "last active". Presence says who's open NOW and lapses; this stays.
    seenAt: Date,
    autoRefill: {
      enabled: Boolean,
      amountUsd: Number,
      monthlyLimitUsd: Number,
      limitMonth: String,
      paymentMethodId: String,
      cardBrand: String,
      cardLast4: String,
      inFlightAt: Date,
      lastAttemptAt: Date,
      lastRefillAt: Date,
      failCount: Number,
      lastError: String,
      disabledReason: String,
    },
  },
  { versionKey: false, timestamps: true }
);

// What the header shows about the account itself, from an X user object: name, picture (the same size choice as
// everyone else's, via Person.fromApi) and follower / following counts. One definition for sign-in
// (services/accounts.js) and every profile save (Person.store).
AccountSchema.statics.selfFields = function selfFields(user) {
  const p = require("./Person").fromApi(user, new Date());
  return { name: user.name, image: p.image, followers: p.followers, following: p.following };
};

// A follow pair flipped (models/Follow.js fromEvent: a press, or a live event): the follower's "following" and the
// followee's "followers" move by `by`, for whichever of them is an account here (usually one), and its open pages
// hear the result (LiveEvent "me": the header's counts, public/js/live.js, with `v` = countsV). An account whose counts
// were never read isn't moved ($type: a number to move from).
AccountSchema.statics.followFlipped = async function followFlipped(followerId, followeeId, by) {
  const LiveEvent = require("./LiveEvent");
  for (const [_id, field] of [[followerId, "following"], [followeeId, "followers"]]) {
    const a = await this.findOneAndUpdate({ _id, [field]: { $type: "number" } }, { $inc: { [field]: by, countsV: 1 } }, { returnDocument: "after", projection: { followers: 1, following: 1, countsV: 1 } }).lean();
    if (a) await LiveEvent.note(_id, "me", this.meOf(a));
  }
};
// The header's counts as the pages take them (LiveEvent "me", a Follow press's answer): with their version.
AccountSchema.statics.meOf = (a) => ({ followers: a.followers, following: a.following, v: a.countsV || 0 });

// THE write of a public circle's members (services/circle.js members → ids): only while it's public, and only when
// they changed (an array filter compares the whole list in order), so a sync that changes nothing writes nothing.
// Callers: the sync's profile pass, your circle page, turning sharing on.
AccountSchema.statics.keepCircle = function keepCircle(accountId, ids) {
  return this.updateOne({ _id: accountId, "circle.public": true, "circle.ids": { $ne: ids } }, { $set: { "circle.ids": ids, "circle.at": new Date() } });
};

// A public circle by its handle (/@<username>), case-insensitively as X treats handles: only public circles are in
// the index, and the query must use the same collation (CIRCLE_COLLATION) to use it.
AccountSchema.statics.CIRCLE_COLLATION = { locale: "en", strength: 2 };
AccountSchema.index({ username: 1 }, { collation: AccountSchema.statics.CIRCLE_COLLATION, partialFilterExpression: { "circle.public": true } });

// THE fields a signed-in request loads (one lookup by _id per request: web.js for a browser's session, routes/mcp.js for
// an agent's token). A field read as req.account.<field> that isn't here is silently undefined (verify-security checks
// every one the routes read is listed).
AccountSchema.statics.REQUEST_FIELDS = "createdAt inboxOwed likesUnseen followsUnseen username name image followers following countsV needsReauth postCount likeCount history inboxFrom inboxWithin features theme font accent navCollapsed timeZone tokens.scope balanceMicros marginMultiplier stripeCustomerId autoRefill pause resumedAt keepLive xBalance writeLimits mediaSaved mediaSeenAt live.subs circle.public circle.size";

module.exports = mongoose.model("Account", AccountSchema);
