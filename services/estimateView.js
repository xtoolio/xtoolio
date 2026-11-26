// services/estimateView.js — THE ESTIMATE as pages draw it: the module picker's month (moduleEstimate) for the front
// page, the start page, Settings and a module's off page, so a person sees the same figures everywhere; the front
// page's price list (landingView); an account's own month (accountEstimate). The prices come from
// lib/pricing.js and services/modulePrices.js; the sums are only ever done here.
"use strict";

const config = require("../config");
const billing = require("./billing");
const syncPrefs = require("./syncPrefs");
const estimator = require("./estimator");
const { PRICE, PRICE_LIST_URL, LIKES_PER_OWN_POST } = require("../lib/pricing");
const { historyOptions, pullCost } = require("./history");
const { isOwner } = require("./accounts");
const { MODULES, isOn } = require("./features");
const { modulePrices } = require("./modulePrices");
const { NEW_LIKES_FIRST_PAGE } = require("./extras");

// What Replies, live adds per post over the sync reading it (X bills a live post event as a post, $0.005, and the
// sync's later read is then free that day): for the app's owner the sync's read is an Owned Read ($0.001), so 5× per
// post; for anyone else the sync pays the post price anyway, so nothing. ONE rule for Settings and the front page.
const liveRepliesExtraEach = (owned) => Math.max(0, PRICE.post - (owned ? PRICE.owned : PRICE.post));

// The front page's markup ("X's own price plus 50%"), the platform's (billing.multiplierFor with no account).
// "Pay as you go" (views/landing.hbs: prices are X's API price plus the markup; cut to four rows):
// X's per-item prices (lib/pricing.js PRICE) beside what you pay for each (× the platform's multiplier).
// Every number from the code that bills, never typed. (The history read is the estimator's onboarding row; the
// deposit is the waitlist page's and the start page's to say.)
const landingView = (() => {
  const m = billing.multiplierFor(null);
  const item = (x) => ({ x, you: x * m });
  return {
    markupPct: Math.round((m - 1) * 100),
    markupCapUsd: billing.markupCapUsd || null, // the fee's monthly threshold (services/balance.js)
    markupAfterPct: billing.markupAfterPct, // the rate past it
    priceListUrl: PRICE_LIST_URL, // "X's own API price" links X's price list
    price: { post: item(PRICE.post), user: item(PRICE.user), press: item(PRICE.like) },
  };
})();

// THE MODULE PICKER'S ESTIMATE (docs/MODULES.md), for the front page's estimator and Settings: one partial,
// partials/module-picker.hbs, so the two can't drift. One GET form (its switches and numbers submit on change, public/js/autosubmit.js); the sums
// only ever done here:
//   the visitor's posts and the ones to them — their real month (services/estimator.js, `measured`) or two guesses
//            (`write` / `get`), through syncPrefs.estimateMonth: the SAME parts Settings adds up for an account
//   the four modules, Settings-style rows in their fixed order, plus Replies, live inside the Inbox — each priced by
//            services/modulePrices.js exactly as Settings prices an account (additive: each row its own part; its
//            price shows whether it's on or not). People and Follows ask the one number that can't be measured before
//            sign-up (likes you give / follows and unfollows a day), only while on
//   = a month: the total row at the foot, as Settings' Estimated total
// Once, at the start (said in the rows): the Inbox's week before, People's history read (services/history.js). Only
// offered values are read.
const ESTIMATE_PER_DAY = [2, 5, 10, 25, 50, 100];
const ESTIMATE_DEFAULT = 50; // an active user's day (it was 10)
const LIKES_PER_DAY = [10, 25, 50, 75, 100, 150, 250]; // steps close enough that rounding a default UP stays near it
const FOLLOWS_PER_DAY = [2, 5, 15, 50];
// Reposts of your posts a day (the Likes module, Live's post.repost.create): one measured account's posts drew 2.4 a
// day over 30 days (X's retweet_count), so 3 is the default.
const REPOSTS_PER_DAY = [1, 3, 10, 30];
// Replies you send from xtoolio a day (WHAT YOU SEND). The default follows the replies you get: one reply sent per
// reply received, rounded up to a choice here (moduleEstimate's `upTo(REPLIES_SENT_PER_DAY, received)`).
const REPLIES_SENT_PER_DAY = [0, 5, 10, 20, 30, 40, 50, 75, 100];
// Reposts you send with the ↻ a day (WHAT YOU SEND; reposts priced beside likes and replies): 1 by
// default.
const REPOSTS_SENT_PER_DAY = [0, 1, 3, 10, 25];
const MODULE_WORDS = {
  // A sentence or two each, kept simple: the module-off page's line, and the module picker's (i) beside
  // each name, saying what it is.
  inbox: { label: "Inbox", hint: "Replies, mentions and quotes to you, until you mark them done." },
  people: { label: "People", hint: "Everyone you talk with, ranked, and your history with each." },
  // Honest about what X sends: about a third of the likes on one measured account's posts never came
  // through X's live stream, and some people's never do (docs/ACTIVITY-API.md).
  likes: { label: "Likes", hint: "Who likes and reposts your posts. X skips some likes." },
  // Best effort: nothing re-reads what X doesn't send (the follower check was deleted).
  follows: { label: "Follows", hint: "Who follows and unfollows you." },
};
// `defaultOn`: every module starts ticked until the form has been used (`edited`, a hidden field in it: an unticked
// box sends nothing, so without it "unticked everything" and "first visit" look alike). The front page (every
// module on by default, so the full price shows).
// `modulesOn`: the switches as they are (Settings: the account's own), in place of the query's. `once`: the onboarding
// row (off in Settings: an account's history was read when it started).
// `owned`: price the ONE column as X bills the app's own developer account (the app's owner: X's own bill, no markup;
// on a self-hosted copy that's whoever runs it). `selfHosted`: a SECOND column priced that way beside the hosted one,
// the front page only (Settings shows what this account pays on this deployment, one column).
// THE estimate: the front page, the start page, Settings and a module's off page all price through it, so a person
// who estimated themselves on the front page sees the same figures once signed in (every assumption the
// same).
function moduleEstimate(query, measured = null, { multiplier = billing.multiplierFor(null), owned = false, selfHosted = false, defaultOn = false, modulesOn: fixedOn = null, once = true } = {}) {
  const m = multiplier;
  const pick = (list, v, d) => (list.includes(Number(v)) ? Number(v) : d);
  const opts = (list, chosen) => list.map((value) => ({ value, selected: value === chosen }));
  const real = measured && !measured.error ? measured : null;
  const written = real ? real.written : pick(ESTIMATE_PER_DAY, query.write, ESTIMATE_DEFAULT);
  const received = real ? real.received : pick(ESTIMATE_PER_DAY, query.get, ESTIMATE_DEFAULT);
  const prefs = syncPrefs.PROFILES;
  const base = syncPrefs.estimateMonth({ written, received }, prefs);
  const part = (key) => base.parts.find((p) => p.key === key).usd;
  const countOf = (key) => base.parts.find((p) => p.key === key).count;
  // WHAT YOU SEND's defaults: YOU LIKE AND ANSWER EVERY REPLY YOU GET, the Inbox's own rule (each reply owes a like and
  // a reply: inbox.standingOf), not one account's habits (it was one measured account's ratios of likes and
  // replies per reply received; X has no per-handle measure of either, its profile's like_count being lifetime). On
  // that account it gave about the presses a day it really made. Rounded UP to a dropdown choice, so it errs high; one
  // you pick stands.
  const upTo = (list, v) => list.find((o) => o >= v) ?? list[list.length - 1];
  // The picks belong to the pace they were made at (`basis`, a hidden field): a new handle or a new guess starts from
  // ITS defaults (a handle getting 27 replies a day kept the 100 likes / 50 replies picked for one getting 64).
  const basis = `${written}:${received}`;
  const newPace = query.basis !== undefined && query.basis !== basis;
  const mine = (v) => (newPace ? undefined : v);
  const likesPerDay = pick(LIKES_PER_DAY, mine(query.lpd), upTo(LIKES_PER_DAY, received));
  const followsPerDay = pick(FOLLOWS_PER_DAY, query.fpd, 5);
  const repostsPerDay = pick(REPOSTS_PER_DAY, query.rpd, 3);
  const repliesPerDay = pick(REPLIES_SENT_PER_DAY, mine(query.spd), upTo(REPLIES_SENT_PER_DAY, received));
  const repostsSentPerDay = pick(REPOSTS_SENT_PER_DAY, query.rspd, 1);
  const fresh = defaultOn && query.edited !== "1";
  const on = Object.fromEntries(MODULES.map((k) => [k, fixedOn ? !!fixedOn[k] : fresh || query[k] === "1"]));
  // Replies, live comes WITH the Inbox, never its own row (no separate cost switches; services/features.js:
  // no switch of its own anywhere): for anyone but the app's owner X bills a pushed
  // post what the check pays (liveRepliesExtraEach), so it adds nothing; self-hosted it's priced at the owner's rate.
  on.liveReplies = on.inbox;
  // The rows are at X'S OWN PRICE, and the platform's markup is its own line under them, the math shown:
  // what X charges × the markup = the markup line; the two = the
  // total. `m` is the multiplier (the platform's, or the account's own; 1 for the app's owner: no markup line).
  // The month at X's price for `w` posts and `r` replies to you a day, with these switches and per-day numbers: the
  // estimate below, and the self-hosted column's (`own`). `own`: as X
  // bills an app's own developer account: its own posts, mentions and likes at X's Owned Read rate (lib/pricing.js),
  // and Replies, live (with the Inbox) costing a pushed post's price over that read (liveRepliesExtraEach).
  // Like events a month at `w` posts and replies of yours a day: the likes they draw, and the likes you give.
  const likeEventsAt = (w) => Math.round(30 * (w * LIKES_PER_OWN_POST + likesPerDay));
  const pricesAt = (w, r, own) => {
    const b = syncPrefs.estimateMonth({ written: w, received: r }, prefs);
    const pt = (key) => b.parts.find((p) => p.key === key).usd;
    const read = own ? PRICE.owned : PRICE.post;
    return modulePrices(
      {
        conversations: b.parts.find((p) => p.key === "posts").count * read + pt("context") + pt("people"),
        tiers: pt("top") + pt("rest"),
        yourLikes: (likesPerDay * 30 + 30 * NEW_LIKES_FIRST_PAGE) * read,
        // Like events, both ways (like.create with Likes on): the likes your posts draw and your own, $0.001 each
        // (PRICE.likeEvent, measured); the likers check reads only what a stream gap hid.
        likers: likeEventsAt(w) * PRICE.likeEvent,
        reposts: repostsPerDay * 30 * PRICE.repostEvent,
        follows: followsPerDay * 30 * PRICE.followEvent,
        liveReplies: 30 * (w + r) * liveRepliesExtraEach(own),
        self: pt("self"),
        // WHAT YOU SEND: X's write price per press, the same hosted or self-hosted (writes have no owner rate).
        sends: 30 * (likesPerDay * PRICE.like + repliesPerDay * PRICE.reply + repostsSentPerDay * PRICE.repost),
      },
      on
    );
  };
  const prices = pricesAt(written, received, owned);
  const per = {
    // THE likes input, in What you send: it also prices People's reading of them and the Likes row's like events.
    sends: { name: "lpd", words: "likes you give a day", options: opts(LIKES_PER_DAY, likesPerDay) },
    replies: { name: "spd", words: "replies you send a day", options: opts(REPLIES_SENT_PER_DAY, repliesPerDay) },
    reposts: { name: "rspd", words: "reposts you send a day", options: opts(REPOSTS_SENT_PER_DAY, repostsSentPerDay) },
    follows: { name: "fpd", words: "follows and unfollows a day", options: opts(FOLLOWS_PER_DAY, followsPerDay) },
    likes: { name: "rpd", words: "reposts of your posts a day", options: opts(REPOSTS_PER_DAY, repostsPerDay) },
  };
  // The rows, as Settings draws them (Settings' look, a total at the foot, no waterfall). Each row's
  // price is its own part, so the rows add up (modulePrices: ADDITIVE); the Inbox's reading is
  // counted for People even with the Inbox off (`counted`). Under each row, ONLY ITS ASSUMPTIONS: the numbers a day it
  // rests on, each a dropdown (or X's measured figure for a handle). Rows of switches and assumptions, no
  // extra text: the derived counts a month (posts around them, profiles kept
  // fresh, likes sent back by X, each input × 30) are gone from the page; the price still counts every one of them.
  const reads = {
    // The two numbers everything scales from, IN the Inbox's row (the guesses moved into the table, lined
    // up with the other assumptions): a guess (a dropdown) or, with a handle, X's measured figure.
    inbox: [
      { label: "Your posts and replies", ...(real ? { measured: written } : { per: { name: "write", words: "your posts and replies a day", options: opts(ESTIMATE_PER_DAY, written) } }) },
      { label: "Replies and mentions to you", ...(real ? { measured: received } : { per: { name: "get", words: "replies and mentions to you a day", options: opts(ESTIMATE_PER_DAY, received) } }) },
    ],
    people: [],
    // THE likes input, here: it also prices People's reading of them and the Likes row's like events.
    sends: [
      { label: "Likes you give", per: per.sends },
      { label: "Replies you send", per: per.replies },
      { label: "Reposts you send", per: per.reposts },
    ],
    likes: [{ label: "Reposts of your posts", per: per.likes }],
    follows: [{ label: "Follows and unfollows", per: per.follows }],
  };
  // In whole cents, so the math on the page adds up to the cent as written: each row rounded, X's sum of the rows that
  // count, the markup on that sum, the total of the two (a "$7.53 + $3.77 = $11.29" from unrounded parts read as wrong).
  const cents = (v) => Math.round(v * 100) / 100;
  // The rows that add up: the four modules, then What you send (counted while the Inbox or People is on).
  const ROWS = [...MODULES, "sends"];
  const counts = (key) => (key === "sends" ? prices.sendsCounted : on[key] || (key === "inbox" && prices.inboxCounted));
  // Each row as shown, and the sum of the rows that count. Replies, live comes with the Inbox, so it rides on the
  // Inbox's row (not when the Inbox is only counted for People: then it isn't on).
  const rowsOf = (pr) => Object.fromEntries(ROWS.map((k) => [k, cents(pr[k] + (k === "inbox" && (on.inbox || !pr.inboxCounted) ? pr.liveReplies : 0))]));
  const sumOf = (rows) => cents(ROWS.filter(counts).reduce((s, k) => s + rows[k], 0));
  const rows = rowsOf(prices);
  const x = sumOf(rows);
  // The fee by billing's own rule (services/balance.js monthFee): the full rate until it reaches the threshold
  // (MARKUP_CAP_USD), then the lower rate (MARKUP_AFTER_CAP_PCT) on the rest of X's price.
  const cap = billing.markupCapUsd;
  const fullMarkup = cents(x * (m - 1));
  const markupUsd = cents(billing.monthFee(x, m));
  const firstX = cap > 0 && m > 1 ? cap / (m - 1) : null; // X's price that brings the fee to the threshold
  // SELF-HOSTED, the front page's second column: the same switches priced as X bills an app's own developer account, no markup.
  let self = null;
  if (selfHosted) {
    const ownRows = rowsOf(pricesAt(written, received, true));
    self = { rows: ownRows, total: sumOf(ownRows) };
  }
  const modules = MODULES.map((key) => ({ key, ...MODULE_WORDS[key], on: on[key], counted: key === "inbox" && prices.inboxCounted, usd: rows[key], selfUsd: self ? self.rows[key] : null, reads: reads[key] }));
  // WHAT YOU SEND (no switch): its month, counted while the Inbox or People is on, else what it would be.
  // Its (i) (partials/info-tip.hbs), as MODULE_WORDS' hint is a module's: what the row is, for where you press.
  const press = `$${PRICE.like}`;
  // A post's On X (partials/post-foot.hbs) is the free way: nothing pressed there passes through here.
  const hint = `Likes, replies and reposts sent from ${config.brandName}: ${press} each. Free on X itself.`;
  const sends = { counted: prices.sendsCounted, usd: rows.sends, selfUsd: self ? self.rows.sends : null, reads: reads.sends, hint };
  // ONBOARDING, once: reading your history is a bulk read, its own markup (BULK_MARKUP_PCT, 15%,
  // services/balance.js; never more than the account's own rate): hosted at X's price + 15%, owned (and
  // the self-hosted column) at X's price with your own posts and mentions at the owner rate. With People: the "how far
  // back?" tiers this account's post count allows (services/history.js; ~4,000 at most, X's limit), picked here
  // (`hist`). With the Inbox alone: the week before you start. `usd`: this column; `self`: the self-hosted one.
  const historyM = Math.min(1 + billing.bulkPct / 100, m);
  let onboarding = null;
  if (once && on.people) {
    // Each tier with your likes over the same stretch (history.firstReadLikes; the handle's own like count isn't
    // measured here, so not capped by it), as "how far back?" prices it.
    const tiers = historyOptions(real ? real.posts : undefined, { perDay: written + received });
    // Default: everything X serves (their actual posts, to X's limit).
    const chosen = tiers.find((t) => t.key === query.hist) || tiers[tiers.length - 1];
    const ownPull = cents(pullCost(chosen.budget, chosen.likes, { owned: true }));
    onboarding = {
      what: "history",
      options: tiers.map((t) => ({ value: t.key, label: `${t.label} (${t.budget.toLocaleString("en-US")} posts)`, selected: t === chosen })),
      usd: owned ? ownPull : cents(chosen.estimate * historyM),
      self: ownPull,
    };
  } else if (once && on.inbox) {
    const week = (own) => ((countOf("posts") * (own ? PRICE.owned : PRICE.post) + part("context") + part("people")) * 7) / 30;
    onboarding = { what: "week", usd: cents(week(owned) * historyM), self: cents(week(true)) };
  }
  if (onboarding) onboarding.pct = Math.round((historyM - 1) * 100);
  return {
    // The handle the form sent, else the one measured (Settings and the start page measure the account's own).
    handle: typeof query.handle === "string" ? query.handle.slice(0, 20) : (measured && measured.handle) || "",
    measured: real, // { handle, name, image, written, received, days, posts }
    // Whose month it is, as THE avatar partial takes a person: the estimate's header row draws their picture, name and
    // @handle, so it's clearly them. None measured: null, and the header shows a blank picture beside "Cost estimator".
    who: real ? { username: real.handle, profile: { name: real.name, image: real.image } } : null,
    measureError: measured && measured.error, // "unknown" | "busy" | "off" (this copy can't measure: said nowhere)
    modules,
    sends,
    basis, // the pace the dropdowns' picks were made at (a hidden field: a new pace re-derives them)
    // The math under the rows: X's sum, the markup on it, and what you pay.
    x,
    markup:
      m > 1
        ? {
            pct: Math.round((m - 1) * 100),
            afterPct: billing.markupAfterPct,
            usd: markupUsd,
            full: fullMarkup,
            cap: cap > 0 ? cap : null,
            // Past the threshold: the working, "50% on the first $100 = $50, then 15% on the other $32.99 = $4.95".
            over: firstX && x > firstX ? { firstX: cents(firstX), restX: cents(x - firstX), restFee: cents(markupUsd - cap) } : null,
          }
        : null,
    total: cents(x + markupUsd),
    owned, // the one column is X's bill to the app's own developer account (the owner)
    self, // { rows, total } or null: the self-hosted column
    press: { x: PRICE.like, you: PRICE.like * m },
    onboarding,
  };
}

// A typed or own handle's real month (services/estimator.js), the platform's cost (~3 cents, kept a week per handle).
// `fresh`: whether this caller may spend (the front page's per-visitor limit); `visitor`: a signed-out visitor's
// (counted against the day's cap). Any failure → the dropdowns. Settings' Re-estimate is POST /estimate.
const measureHandle = (handle, { fresh = true, visitor = false } = {}) =>
  estimator.measure(handle, { token: config.x.bearerToken, fresh, visitor }).catch((e) => (console.error(`[estimate] ${e.message}`), { error: "busy" }));

// THIS account's estimate: THE estimate (moduleEstimate) for its own real month on X (the front page's measure of its
// handle, cached a day) and its own switches, so it's the figure the front page gave the same handle (a
// person who estimated their cost must find the same figure in Settings). ONE column, what this account pays on THIS
// deployment (Settings works the same hosted or self-hosted): a paying account at its own rate; the owner (the hosted
// site's operator, or whoever runs a self-hosted copy) X's own bill at the owner rate, no markup. The front page alone
// shows hosted and self-hosted side by side. Settings used to have its own engine (accountPrices, off the
// account's stored activity), which gave different figures, and the owner saw both columns. Settings
// and a module's off page. `query`: the per-day guesses (lpd, fpd; write / get when X couldn't measure).
// BEFORE GET STARTED (no module on yet: the start page's account), every module is priced ON and `beforeStart` set, so
// Settings draws the switches on and locked (Settings is reachable during onboarding, and showed them off):
// Get started turns them all on, so that's the month to show.
// (Not `onboarding`: that's the estimate's own "Once, to start" row.)
async function accountEstimate(account, query = {}) {
  const measured = await measureHandle(account.username);
  const beforeStart = !MODULES.some((k) => isOn(account, k));
  const cost = moduleEstimate(query, measured, {
    multiplier: billing.priceFor(account, 1),
    owned: isOwner(account._id),
    modulesOn: Object.fromEntries(MODULES.map((k) => [k, beforeStart || isOn(account, k)])),
    once: false,
  });
  return { ...cost, beforeStart };
}

module.exports = { landingView, MODULE_WORDS, moduleEstimate, measureHandle, accountEstimate };
