// routes/pages.js — what every page route shares: the gate before a module's page (readyOrRender: the front page, the
// start page, a module that's off, "how far back?", a first read's progress), the sidebar (navFor), where a form goes
// back to (safeBack, withNotice), the answers a press gets (wantsJson, backTo, balanceText, refusedJson, xFailure),
// the reply box, a conversation's page, and the header's balance and Live state. No routes here: routes/*.js and
// web.js mount those.
"use strict";

const config = require("../config");
const hbsOptions = require("../lib/hbs");
const hbsHelpers = hbsOptions.helpers;
const { MEDIA_LIMITS, ACCEPT: MEDIA_ACCEPT } = require("../lib/media");
const { noticeFor, failureNotice: xFailure } = require("../lib/notices");
const { PRICE } = require("../lib/pricing");
const Account = require("../models/Account");
const Post = require("../models/Post");
const SyncState = require("../models/SyncState");
const PullQueue = require("../models/PullQueue");
const pullQueue = require("../services/pullQueue");
const livePush = require("../services/livePush");
const people = require("../services/people");
const listing = require("../services/listing");
const likes = require("../services/likes");
const follows = require("../services/follows");
const tagged = require("../services/tagged");
const { handleOf } = require("../lib/handle");
const waitlistDms = require("../services/waitlistDms");
const billing = require("../services/billing");
const mediaLibrary = require("../services/mediaLibrary");
const { demoTour, TOUR_CASES } = require("../services/demo");
const agentOAuth = require("../services/agentOAuth"); // RESOURCE: the address an agent app adds (the front page says it)
const { historyOptions, firstReadLikes } = require("../services/history");
const pause = require("../services/pause");
const further = require("../services/further");
const { isOwner, syncSettings } = require("../services/accounts");
const { profilesFor } = require("../services/accountData");
const { writesLeft, setFollow, setLike } = require("../services/extras");
const { metered } = require("../services/usage");
const { FEATURES, MODULES, isOn, granted, active, modulesOn, stormOnly, firstReadGoing } = require("../services/features");
const { FOLLOW_ALL_MAX, LIKE_ALL_MAX } = require("../services/conversations");
const likeLatest = require("../services/likeLatest");
const { createClient } = require("../lib/x");
const { refreshOwedSafely } = require("../services/inboxCount");
const { landingView, moduleEstimate, MODULE_WORDS, measureHandle, accountEstimate } = require("../services/estimateView");

// The front page's tour (views/landing.hbs): its use cases, and the page flags its drawn pages read from the root as the
// app's own pages do (the account it draws has Following on and the pair facts known; its likes left out, so a person's
// row fits the drawn page), and /circle.css for its circle.
const TOUR_VIEW = { tourCases: TOUR_CASES, canFollow: true, showFollows: true, circlePage: true };
// Your circle's page (a sidebar place of its own, People's ranking drawn around you).
const CIRCLE_PAGE = "/people/circle";
// THE LIKESTORM's page (a sidebar place of its own while Liking is active: routes/likestorm.js, answerStorm).
const STORM_PAGE = "/likestorm";
// THE START PAGE's own address (GET /start, web.js): home ("/") draws it until the account starts, and a LIKESTORM ONLY
// account, whose home is the Likestorm page, reaches it here to get the rest.
const START_PAGE = "/start";

// The money figure in the header, off the request's own account (no lookup): the owner's X API credit (Account.xBalance,
// saved with every reading), or an account that pays its own balance here. null for anyone else (billing off).
function headerBalance(account) {
  if (!account) return null;
  if (isOwner(account._id)) return account.xBalance && Number.isFinite(account.xBalance.usd) ? { label: "Balance", usd: account.xBalance.usd, href: "/usage" } : null;
  if (!billing.enabled) return null;
  return { label: "Balance", usd: (account.balanceMicros || 0) / 1e6, href: "/usage" };
}

// Is this account live: X's stream up (services/livePush.js, in memory) and the account subscribed (Account.live.subs).

// "● Live" means new replies arrive live: the Replies, live extra's post events (likes or follows alone don't make the
// Inbox live).
const isLiveFor = (account) => livePush.isLive() && !!(account && account.live && account.live.subs && account.live.subs.some((s) => s.eventType.startsWith("post.")));

const requireAccount = (req, res, next) => (req.account ? next() : res.redirect("/"));
// Where a form sends you back to: a same-origin path only ("/x", never "//evil.com" or "https://…"). Judged AFTER the
// URL parser has normalised it, and returned normalised: the callers re-parse it (withNotice, backTo), and dot segments
// collapse there, so "/..//evil.com" passed a check on the raw string and came out as "//evil.com", another site.
const safeBack = (back, fallback) => {
  if (typeof back !== "string" || !/^\/(?![/\\])/.test(back)) return fallback;
  let u;
  try {
    u = new URL(back, config.appOrigin);
  } catch {
    return fallback;
  }
  if (u.origin !== new URL(config.appOrigin).origin || /^\/[/\\]/.test(u.pathname)) return fallback;
  return u.pathname + u.search + u.hash;
};
// That path with ?n=<notice> (kept before any #fragment): the toast it lands on (lib/notices.js); `undo`: a Done
// press's undo token (?u=), so the toast offers Undo. Any earlier ?u= goes (a toast never offers a stale one).
const withNotice = (back, n, undo = null) => {
  const u = new URL(back, config.appOrigin);
  u.searchParams.set("n", n);
  u.searchParams.delete("u");
  if (undo) u.searchParams.set("u", undo);
  return u.pathname + u.search + u.hash;
};

// The money side of a page, for an account that pays (billing on, not the owner); null otherwise.
// An account that pays here: billing on, and not the owner (who pays X directly). Its Usage page is its statement.
const paysHere = (account) => billing.enabled && !isOwner(account._id);
// `amounts`: what this account may top up by (billing.amountsFor), the ONE list its pages offer and /billing/topup
// accepts. Its first payment is the deposit, smaller for LIKESTORM ONLY (STORM_DEPOSIT_USD: nothing syncs, it pays per
// storm alone).
async function fundsView(account) {
  if (!paysHere(account)) return null;
  const paid = await billing.hasPaid(account._id);
  const deposit = stormOnly(account) ? config.billing.stormDepositUsd : config.billing.depositUsd;
  return { balance: (account.balanceMicros || 0) / 1e6, paid, deposit, amounts: billing.amountsFor(paid, { depositUsd: deposit, topupAmountsUsd: config.billing.topupAmountsUsd }), payable: config.billing.payable };
}

// THE BIG READS' CHOICES, priced on the spot for THIS account and its balance: each option (`estimate`: X's cost) with what this account pays for it (X's price plus the markup; `bulk`:
// the onboarding rate, 15%, which only reading your history gets: services/balance.js; the owner's own reads at the
// owner rate, no markup), whether its balance covers that, and, for one that pays and isn't covered, the ONE top-up
// that covers it (`topup`, billing.topupFor). One definition for each page, its POST and the top-up route (which
// accepts these amounts as well as the usual ones).
async function pricedChoices(account, options, { bulk = false } = {}) {
  const funds = await fundsView(account);
  return options.map((o) => {
    const price = billing.priceFor(account, o.estimate, { bulk });
    const affordable = billing.affords(account, o.estimate, { bulk });
    // Not covered only because the gate is shut (a free choice at $0): the smallest top-up opens it.
    const short = Math.max(price, funds ? funds.balance + 0.01 : 0);
    return { ...o, price, affordable, topup: funds && !affordable ? billing.topupFor(funds.balance, short, funds.paid) : null };
  });
}

// Who they tag's one read (services/tagged.js), priced for this account: [choice]. The page shows it on its button, the
// read refuses it unaffordable, and /billing/topup accepts its top-up.
const tagsChoices = (account) => pricedChoices(account, [{ key: "tags", estimate: tagged.quoteUsd() }]);

// "How far back?" for this account (pricedChoices). The stretches (1 day / 1 week: a first read goes back a week at
// most, history.js FIRST_READ_DAYS) are sized from the
// account's pace, measured as the front page measures a handle (services/estimator.js: kept a week per handle, so this
// page and its POST agree); unmeasured, post counts.
// `stored`: only a measurement already kept, never a new one (a resume prices itself on every page load while away).
async function paceOf(account, { stored = false } = {}) {
  const pace = await measureHandle(account.username, { fresh: !stored });
  return pace && !pace.error ? pace.written + pace.received : null;
}
async function historyChoices(account) {
  const perDay = await paceOf(account);
  // Each option's price includes your likes over the same stretch, at most the likes you have (history.firstReadLikes).
  return pricedChoices(account, historyOptions(account.postCount, { owned: isOwner(account._id), perDay, likeCount: account.likeCount }), { bulk: true });
}
// READ FURTHER BACK (services/further.js) for this account, priced at the onboarding markup like the first read: the
// stretches beyond what's read, each for the rest. Only with People on and a history chosen, none while one runs.
// `state`: its SyncState (own, mention, likes: what's read and where its likes stand).
const FURTHER_STATE = "own mention likes backfillRead furtherStage";
async function furtherChoices(account, state) {
  if (!isOn(account, "people") || !(account.history && account.history.budget) || account.history.further || !further.canReadFurther(state)) return [];
  // What's stored of each stream (further.leftToRead: what's left is X's count minus it): two indexed counts.
  const of = (kind) => Post.countDocuments({ accounts: { $elemMatch: { id: account._id, kind } } });
  const [own, mention] = await Promise.all([of("own"), of("mention")]);
  return pricedChoices(account, further.options(account, state, { owned: isOwner(account._id), perDay: await paceOf(account), stored: { own, mention } }), { bulk: true });
}

// "How far back?" ON RESUME (services/pause.js resumeOptions: the same stretches and pricing, up to everything since the
// pause, and "From now"), for this account and its balance. Not the onboarding rate: it reads forward, new to you, at the
// usual markup. Only while paused (none otherwise).
// The pace: X's own count (paceOf), else this account's own posts and mentions stored over the 30 days before it
// paused (one indexed count: what it really received here), so a stretch is never priced as everything X serves.
const PACE_DAYS = 30;
// Never measures anew (`stored`): the away bar prices it on page loads, and the bar, /resume and its POST must agree.
async function resumeChoices(account) {
  if (!(account.pause && account.pause.at)) return [];
  let perDay = await paceOf(account, { stored: true });
  if (!perDay) {
    const to = new Date(account.pause.at);
    const n = await Post.countDocuments({ "accounts.id": account._id, createdAt: { $gte: new Date(to.getTime() - PACE_DAYS * 864e5), $lt: to } });
    perDay = n ? n / PACE_DAYS : null;
  }
  return pricedChoices(account, pause.resumeOptions(account, { owned: isOwner(account._id), perDay, likeCount: account.likeCount }));
}

// Each module's page (its tab).
const MODULE_PATHS = { inbox: "/", people: listing.people.path, likes: likes.listing.path, follows: follows.listing.path };

// THE SIDEBAR's places (views/partials/side-nav.hbs: a vertical list, foldable, that new pages can join as
// features grow). A module's page each, in the order they're used: the modules that are on, then the ones that
// aren't, faded, each opening its page (views/module-off.hbs: what it is, its switch), so the sidebar shows what else
// there is. A count rides on the ones that have one, off the account (no lookup; public/js/live.js moves it): the
// Inbox's likes and replies owed (Account.inboxOwed), Likes' and Follows' new since you last opened them. `dot`: any
// count showing (the phone's ☰ wears it, so the drawer hides nothing). A new page joins this list.
const NAV_ORDER = ["inbox", "likes", "follows", "people"];
const NAV_ICONS = { inbox: "icon-inbox", likes: "icon-posts", follows: "icon-follows", people: "icon-people" };
// A place named apart from its module: the Likes module's page is YOUR POSTS, "Posts" in the sidebar as People's is
// "Your people"; Settings' switch keeps the module's name (MODULE_WORDS). Its count is new likes on your posts.
const NAV_LABELS = { likes: "Posts" };
const NAV_COUNTS = {
  inbox: { field: "inboxOwed", tip: "Likes and replies owed", sr: "likes and replies to send" },
  likes: { field: "likesUnseen", tip: "New likes", sr: "new" },
  follows: { field: "followsUnseen", tip: "New follows", sr: "new" },
};
function navFor(account, modules, tab) {
  const place = (key, label, href, icon, badge = null) => ({ key, label, href, icon, on: true, current: tab === key, badge });
  const item = (key) => {
    const c = NAV_COUNTS[key];
    return { key, label: NAV_LABELS[key] || MODULE_WORDS[key].label, href: MODULE_PATHS[key], icon: NAV_ICONS[key], on: modules[key], current: tab === key, badge: c && modules[key] ? { n: account[c.field] || 0, tip: c.tip, sr: c.sr } : null };
  };
  if (!NAV_ORDER.some((k) => modules[k])) {
    // LIKESTORM ONLY: its page, then the four modules faded, each to the start page (Get started turns them all on
    // at once), so the rest of the app is one press away.
    if (stormOnly(account)) {
      const items = [place("likestorm", "Likestorm", STORM_PAGE, "icon-storm"), ...NAV_ORDER.map((k) => ({ ...item(k), href: START_PAGE }))];
      return { items, ...navSums(items), collapsed: !!account.navCollapsed };
    }
    // Before Get started (the start page: no module on yet), no places at all: four faded "Off"s read as switched off,
    // the opposite of "everything is on by default", and each led back to the start page anyway. The foot
    // stays.
    return { items: [], ...navSums([]), collapsed: !!account.navCollapsed };
  }
  const items = [...NAV_ORDER.filter((k) => modules[k]), ...NAV_ORDER.filter((k) => !modules[k])].map(item);
  // Places that aren't modules, listed only while there's something to show (no switch of their own to offer):
  // Circle (your closest people around you, the ♥), right under People, whose ranking it draws; Media (the photos,
  // GIFs and videos you've posted) after the modules that are on, whenever your own posts are read (the Inbox or People).
  // Media's count: what you saved since you last opened it (mediaLibrary.unseenOf). Likestorm (like someone's latest
  // posts) right after Media, while Liking is active.
  if (modules.people) items.splice(items.findIndex((i) => i.key === "people") + 1, 0, place("circle", "Circle", CIRCLE_PAGE, "icon-heart"));
  if (modules.inbox || modules.people) items.splice(items.filter((i) => i.on).length, 0, place("media", "Media", mediaLibrary.PAGE, "icon-media", { n: mediaLibrary.unseenOf(account), tip: "Newly saved", sr: "new" }));
  if (active(account, "liking")) items.splice(items.filter((i) => i.on).length, 0, place("likestorm", "Likestorm", STORM_PAGE, "icon-storm"));
  return { items, ...navSums(items), collapsed: !!account.navCollapsed };
}
// The front page's drawn app (views/landing.hbs, THE TOUR): the sidebar of the demo account (every module on), lit on
// each screen's place, its Inbox count the drawn cards' own (what they still owe), Follows' the one new follow.
function tourWithNav(tour) {
  const allOn = Object.fromEntries(NAV_ORDER.map((k) => [k, true]));
  const owed = tour.inbox.reduce((s, r) => s + r.owedSplit.like + r.owedSplit.reply, 0);
  const account = { inboxOwed: owed, likesUnseen: 0, followsUnseen: 1 };
  return { ...tour, nav: Object.fromEntries([...NAV_ORDER, "circle"].map((tab) => [tab, navFor(account, allOn, tab)])) };
}
// THE COUNT: the sidebar's counts as they show, added up (one fading out on its own page doesn't count: it's seen).
// `total` is the window title's "(N)" (views/layouts/main.hbs) and each other account's number in THE ACCOUNT SWITCHER
// (countOf); `dot`, the ☰'s, is any of it. public/js/live.js `navSums` is the page's twin, off the same counts drawn.
const navSums = (items) => {
  const total = items.reduce((s, i) => s + (i.badge && !i.badge.clearing ? i.badge.n || 0 : 0), 0);
  return { total, dot: total > 0 };
};
// Which modules an account has on (paused ones too: their page says why).
const modulesOf = (account) => Object.fromEntries(MODULES.map((k) => [k, isOn(account, k)]));
// THE COUNT of an account not on screen (the switcher's other accounts): its sidebar as navFor would draw it.
const countOf = (account) => navFor(account, modulesOf(account), null).total;

// THE START PAGE, the onboarding (choosing modules up front was too hard, so it's everything at once; it
// replaced decision 3, docs/MODULES.md): a signed-in account with no module yet. How
// far back to read: each option priced for this account (historyChoices), only one its balance covers can be picked,
// the deepest of those picked already, and beside the others the one top-up that covers each (the read can't charge
// past the balance anyway: THE CEILING, services/usage.js). Get started (POST /start) turns EVERY module on and
// records the depth in one write; it's live once the account has money in (or doesn't pay here). Nothing to choose
// about modules (a "Choose what to use" there was removed: choosing modules is a monthly matter, not an
// onboarding one); Settings has the switches. An account missing a scope from before is sent to sign in again
// (a LINK: form-action 'self').
// A WIZARD of two steps (a welcome, then add a balance, then how far back), the step decided by the server:
// "money" while an account that pays here has nothing in (or asked to add more, ?step=money), else "history". Each
// amount says the deepest history it pays for (`covers`: the last option whose price the balance plus it reaches), so
// what you're buying is plain before you pay. An account that doesn't pay here (the owner, billing off) has one step.
async function startView(req) {
  const account = req.account;
  const options = await historyChoices(account);
  const deepest = [...options].reverse().find((o) => o.affordable);
  const funds = await fundsView(account);
  const paying = !!(funds && funds.payable);
  const step = paying && (!funds.balance || req.query.step === "money") ? "money" : "history";
  // `covers` only when the amounts differ in it (a light account's every amount reads everything: saying so on each
  // tile restates its neighbours). `whole`, never `usd` or `add`: a field named like a helper (lib/hbs.js) renders the
  // helper.
  const coverOf = (usd) => {
    const o = [...options].reverse().find((c) => c.price <= funds.balance + usd);
    return o ? o.label[0].toLowerCase() + o.label.slice(1) : null;
  };
  // The full app's amounts, its usual deposit first, even for a LIKESTORM ONLY account come for the rest (fundsView
  // gives that account the smaller deposit, for storms).
  const amounts = paying ? billing.amountsFor(funds.paid).map((whole) => ({ whole, covers: coverOf(whole) })) : [];
  if (new Set(amounts.map((a) => a.covers)).size < 2) amounts.forEach((a) => (a.covers = null));
  return {
    priced: billing.enabled || isOwner(account._id),
    funds,
    options: options.map((o) => ({ ...o, selected: o === deepest })),
    start: {
      regrant: MODULES.some((k) => !granted(account, k)),
      ready: !billing.paused(account) && !!deepest,
      handle: account.username,
      steps: paying,
      step,
      amounts,
      // LIKESTORM ONLY (POST /start/storm): offered until chosen, when X granted the likes it needs; `stormOnly`, chosen
      // (this page is then reached from its sidebar, for the rest of the app). `stormDeposit`: its smaller first payment.
      storm: !isOn(account, "likestorm") && granted(account, "likestorm"),
      stormOnly: stormOnly(account),
      stormDeposit: paying && !funds.paid ? config.billing.stormDepositUsd : null,
    },
  };
}

// A module that's off, on its own page (a bookmark, a link from elsewhere): what it is, what it would add to this
// account's month (THE estimate's row for it, as Settings shows it), and its switch (Settings has them all). On but
// without X's permission (an account from before every scope was asked for): paused, and signing in again asks for all.
async function moduleOffView(account, key) {
  const row = (await accountEstimate(account)).modules.find((m) => m.key === key);
  return { module: { key, ...MODULE_WORDS[key], on: isOn(account, key), paused: isOn(account, key) && !granted(account, key), monthly: row.usd, toggle: moduleSwitch(account, key, MODULE_PATHS[key]) } };
}

// A MODULE'S SWITCH ON ITS OWN PAGE (partials/page-switch.hbs, the title row's right; Settings has them all): the
// switch, landing back on the page (off: its module-off page, with the switch to turn it on again). No cost beside it
// (it was there, the month so far: noise in a title row; Usage has the spending).
const pageSwitch = (account, key) => ({ label: MODULE_WORDS[key].label, hint: MODULE_WORDS[key].hint, toggle: moduleSwitch(account, key, MODULE_PATHS[key]) });

// Before a page shows a module's data, it's one of these: signed out → the front page; no module picked yet → the
// start page; this page's module off, or on without X's permission → its "turn it on" page (the Inbox, home, sends you to the first module that's
// on instead); People's history not chosen → "how far back?"; a first read of the conversations still running (the
// Inbox, People, Posts: features.firstReadGoing, which includes reconciling its likes) → progress (moves by itself). → the SyncState once it can show, else null (and the
// page is rendered). `tab`: the module whose page this is.
// What a first read's (or a resume read's) hold and progress read off SyncState: readyOrRender and GET /pull/progress.
const PULL_STATE = "lastRunAt likes.reconciled likes.backfillRead resume";
async function readyOrRender(req, res, tab) {
  if (!req.account) {
    // The pricing parts (the markup, the estimator) only on a site that charges: a self-hosted copy with billing off
    // charges nobody, so they'd be untrue there.
    const charges = billing.enabled;
    // `wide`: main is 1440px (the reading pages' 880 would squeeze the two-column layout); .landing sets its own width.
    const measured = charges && handleOf(req.query.handle) ? await measureHandle(req.query.handle, { fresh: !req.estimateSpent, visitor: true }) : null;
    // "@xtoolio will DM you when you're in" beside the hero's Join the waitlist: only while it's true (the waitlist is
    // the way in, and the sender is connected: THE "YOU'RE IN" DMs, services/waitlistDms.js isOn, a minute's cache).
    const dms = res.locals.waitlistOn && res.locals.siteX ? await waitlistDms.isOn() : false;
    // `footGo`: the footer opens with the call to action (layouts/main.hbs), where the site charges (the hosted page).
    res.render("landing", { wide: true, charges, priced: charges, footGo: charges, landing: charges ? landingView : null, cost: charges ? moduleEstimate(req.query, measured, { selfHosted: true, defaultOn: true }) : null, dms, ...TOUR_VIEW, tour: tourWithNav(demoTour()), mcpUrl: agentOAuth.RESOURCE });
    return null;
  }
  if (!modulesOn(req.account).length) {
    if (stormOnly(req.account)) res.redirect(STORM_PAGE); // LIKESTORM ONLY: home is the Likestorm page
    else res.render("start", await startView(req)); // a reading page (840), like Settings: the picker it was wide for is gone
    return null;
  }
  if (!isOn(req.account, tab) || !granted(req.account, tab)) {
    if (tab === "inbox") res.redirect(MODULE_PATHS[modulesOn(req.account)[0]]);
    else res.render("module-off", await moduleOffView(req.account, tab));
    return null;
  }
  // People's first time: a paying account at $0 is asked for its deposit before any option is affordable.
  if (tab === "people" && !(req.account.history && req.account.history.budget)) {
    res.render("history", { options: await historyChoices(req.account), funds: await fundsView(req.account) });
    return null;
  }
  const state = (await SyncState.findById(req.account._id, PULL_STATE).lean()) || {};
  // Posts too: its cards carry the same ♥ and bulk like as the Inbox's (features.firstReadGoing: likes reconciled first).
  if ((tab === "inbox" || tab === "people" || tab === "likes") && firstReadGoing(req.account, state)) {
    // The first read hasn't finished (lastRunAt is set at the end of a run, after it). It may not have claimed its
    // lock yet when this renders, so don't read "running" off the lock. If a pull ever dies, the scheduler resumes it
    // within a pass. The page MOVES IN PLACE (a meta refresh every 4 s made the screen jump):
    // the worker says when it moved (LiveEvent "pull") and when it's done ("sync"), and public/js/live.js redraws the
    // block from GET /pull/progress (this same pullView), going on once that says done. Without script, the meta
    // refresh is still there inside <noscript> (`refreshNoScript`); paused (out of balance), nothing moves, so none.
    res.render("pulling", { ...(await pullView(req.account, state)), refreshNoScript: res.locals.paused ? null : 4 });
    return null;
  }
  return state;
}

// THE FIRST READ's progress, for the page and for its block alone (GET /pull/progress): how many of the account's
// posts are stored, against People's chosen depth (`budget`; without it, the Inbox's week, which has no count to show
// against); and while it's in line behind other first reads (a launch's sign-ups arrive together; the worker reads
// SYNC_SLOTS at once), where and about how long, from the worker's published line (models/PullQueue.js, one read by
// _id; services/pullQueue.js standing). `likes`: a first read that reconciles the account's likes to its history
// (SyncState.likes.reconciled set either way) shows them as the second step on the same page, right after the posts
// (services/sync.js reads them next): { read, reached, max }, its bar filling toward the quote's own estimate for the
// depth chosen (history.firstReadLikes) and, once past it, holding just short of full while the count goes on, full
// when reconciled (it used to sit empty, then fill in one go). `rest`: the threads and the people, the
// read's last step, working once the likes are done (or there are none to reconcile and the posts are): the page sat
// ~30 s with both bars full and nothing moving. `state`: its SyncState.
const LIKES_BAR_HOLD = 0.95;
// THE RESUME READ (SyncState.resume, services/pause.js) is the same page, its own counts: the posts read back to the
// moment chosen, of what the option was priced on, and your likes read to it (`resume`: the heading says catching up).
async function pullView(account, state) {
  const queue = await PullQueue.findById("first").lean();
  const line = pullQueue.standing(queue, account._id);
  const lineView = line && { ...line, minutes: line.readyMs === null ? null : Math.max(1, Math.round(line.readyMs / 60000)) };
  const r = state && state.resume;
  if (r) {
    const likes = r.likesDone && !r.likesRead ? null : { read: r.likesRead || 0, reached: !!r.likesDone, max: Math.max(firstReadLikes({ budget: r.budget || 0, likeCount: account.likeCount }), Math.ceil((r.likesRead || 0) / LIKES_BAR_HOLD), 1) };
    const postsDone = !!(r.likesRead || r.likesDone);
    return { resume: true, stored: r.read || 0, budget: r.budget || null, postsDone, likes, rest: likes ? likes.reached : postsDone, line: lineView };
  }
  const stored = await Post.countDocuments({ "accounts.id": account._id });
  const budget = isOn(account, "people") && account.history && account.history.budget;
  const reached = state && state.likes && state.likes.reconciled;
  let likes = null;
  if (typeof reached === "boolean") {
    const read = state.likes.backfillRead || 0;
    const expected = firstReadLikes({ budget: budget || 0, likeCount: account.likeCount });
    likes = { read, reached, max: Math.max(expected, Math.ceil(read / LIKES_BAR_HOLD), 1) };
  }
  const postsDone = !!(likes ? likes.read || likes.reached : budget && stored >= budget);
  const rest = likes ? likes.reached : postsDone;
  return { stored, budget: budget || null, postsDone, likes, rest, line: lineView };
}

// The reply box for this account (partials/reply-box.hbs): the link price it warns with, or null without Replying.
// `pictures` (the Pictures add-on): the attachment rules and their messages for public/js/attach.js, from THE rules
// (lib/media.js) and THE notices, so the box says no in the same words the server would.
const PICTURE_RULES = JSON.stringify({
  ...MEDIA_LIMITS,
  accept: MEDIA_ACCEPT,
  say: Object.fromEntries(["media-type", "media-mix", "media-many", "media-big"].map((k) => [k, noticeFor(k).text])),
});
const replyBox = (account) => (active(account, "replying") ? { linkPrice: billing.priceFor(account, PRICE.replyLink), pictures: active(account, "pictures") ? PICTURE_RULES : null } : null);

// X's like allowance as the page shows it (the ♥'s JSON answer; the bulk button keeps it live): how many are left, and
// when more come, written in the account's zone by THE clock helper.
const likeAllowance = async (account, timeZone) => {
  const a = await writesLeft(account._id, "like");
  return { left: a.left, at: a.resetAt ? `at ${hbsOptions.helpers.clock(a.resetAt, { data: { root: { timeZone } } })}` : a.left ? null : "tomorrow", ends: a.windowEnds, after: a.afterReset };
};

// A CONVERSATION'S PAGE (views/conversation.hbs): THE ENGINE's card (conversationCard), or, when there's none to draw,
// `alone` (a thread partial's shape), plus what the card's presses read off the page. Shared by a post of yours'
// page and a person's conversation, so they can't drift. `subject`: the post the page is for; a fold hiding it
// opens (thread.hbs `fold.open`).
function conversationPage(account, { engine, alone = null, subject = null }) {
  let card = engine && engine.card;
  if (card && subject && card.fold && card.chat.some((v) => v.id === subject && v.folded)) card = { ...card, fold: { ...card.fold, open: true } };
  return {
    ...(engine || {}),
    card,
    thread: card ? null : alone,
    conversationId: card ? card.id : alone && alone.id,
    reply: replyBox(account), // each reply opens its own composer (partials/bubble.hbs)
    canFollow: active(account, "following"), // THE Follow beside each name (partials/follow-inline.hbs)
  };
}


// A bulk press's ledger row, named for what it did and whom (the distinct people, in order): "Liked Maya", "Liked
// Maya and Dev", "Liked Maya, Dev and 12 others". Pure.
const bulkLabel = (verb, names) => {
  const who = [...new Set(names.filter(Boolean))];
  if (who.length <= 2) return `${verb} ${who.join(" and ")}`.trim();
  const more = who.length - 2;
  return `${verb} ${who[0]}, ${who[1]} and ${more} other${more === 1 ? "" : "s"}`;
};

// People's names by id, from their stored profiles (THE display rule, people.displayNameOf), for a bulk press's row.
const namesOf = async (ids) => {
  const profiles = await profilesFor(ids);
  return ids.map((id) => people.displayNameOf({ id, username: (profiles.get(id) || {}).username || null, profile: profiles.get(id) || null }));
};

// THE BULK FOLLOW of a list of people (a thread's writers: POST /inbox/follow-all; the people an account tags: POST
// /follows/tags/follow): at most what X allows now (extras.writesLeft "follow") and FOLLOW_ALL_MAX, in that order, one
// after another through THE write (extras.setFollow, each flipping its pair, so the header's "following" counts up),
// ONE ledger row for the press named with whom (as the bulk like), stopping at X's limit, the gate, or three refusals
// in a row. Never retried (a second press follows the next ones). → { done: [ids followed], n: the notice key }
async function followMany(account, targets) {
  const allow = await writesLeft(account._id, "follow");
  const ids = targets.slice(0, Math.min(allow.left, FOLLOW_ALL_MAX));
  const s = syncSettings(account._id);
  const done = [];
  // Fewer than asked (X's window or day ran short of the picks, or more than one press takes): the toast says so, as
  // the bulk unfollow's does, never a plain "Followed." over picks left unfollowed.
  let n = !ids.length ? (allow.left ? "follow-all-none" : "follow-all-wait") : ids.length < targets.length ? "followed-some" : "followed-many";
  let misses = 0;
  const followEach = async (meter) => {
    for (const [i, personId] of ids.entries()) {
      // THE CEILING for a bulk press: past the first follow, none once what's sent has reached what the balance covers.
      if (i && meter.atCeiling()) {
        n = "followed-balance";
        break;
      }
      try {
        // "pending": a protected account's request, sent all the same; "same": already followed (another tab).
        if (["followed", "pending", "same"].includes(await setFollow({ ...s, personId, on: true, meter }))) done.push(personId);
        misses = 0;
      } catch (err) {
        const why = xFailure(err, `[follow-many] ${personId} for @${account.username} (${done.length} done)`);
        if (why !== "x-failed" || ++misses >= 3) {
          n = why === "x-limit" ? "follow-all-limit" : why;
          break;
        }
      }
    }
    if (done.length) await meter.setLabel(bulkLabel("Followed", await namesOf(done)));
  };
  if (ids.length) {
    try {
      await metered({ accountId: account._id, kind: "follow", label: "Followed", billing: s.billing }, followEach);
    } catch (err) {
      n = xFailure(err, `[follow-many] for @${account.username}`); // the gate refused it before X
    }
  }
  return { done, n };
}

// THE BULK LIKE'S LOOP (the Inbox's ♥ Like N: POST /inbox/like-all; someone's latest posts: the Likestorm's POST
// /likestorm), inside the caller's own metered unit `meter` (ONE ledger row for the press): each post
// through THE write (extras.setLike), one after another, stopping at the balance (THE CEILING, past the first like,
// which the gate let start as a single press would), X's limit, the gate or a stale sign-in, and skipping a post X
// refuses unless three in a row are (then it isn't the post). `onEach(i)` before each (the stream's progress line).
// The caller sized `ids` to what X allows (extras.writesLeft "like"). Never retried (a second press likes the NEXT
// ones). → { liked: [ids X took or that were liked already], gone: how many were deleted on X since, stop: the notice
// key that ended it early, or null }
async function likeEach(account, ids, meter, { onEach = () => {} } = {}) {
  const s = syncSettings(account._id);
  const liked = [];
  let gone = 0;
  let misses = 0;
  let stop = null;
  for (const [i, postId] of ids.entries()) {
    onEach(i);
    if (i && meter.atCeiling()) {
      stop = "liked-balance";
      break;
    }
    try {
      // "same": already liked (a press in another tab). "gone": deleted on X since (extras.goneCheck marked it).
      const r = await setLike({ ...s, postId, on: true, meter });
      if (["liked", "same"].includes(r)) liked.push(postId);
      if (r === "gone") gone++;
      misses = 0;
    } catch (err) {
      const why = xFailure(err, `[like-many] ${postId} for @${account.username} (${liked.length} done)`);
      if (why !== "x-failed" || ++misses >= 3) {
        stop = why === "x-limit" ? "like-all-limit" : why;
        break;
      }
    }
  }
  return { liked, gone, stop };
}

// THE LIKESTORM: like someone's latest posts you haven't liked, as many as X's like window allows now (at most
// LIKE_ALL_MAX), by their X id: the Likestorm page's second step (POST /likestorm: the person its first step found and
// you confirmed, routes/likestorm.js). The ONE door: a person's page had "Like latest N" too, unpriced, and it was
// removed (the Likestorm page shows the price on the press).
// services/likeLatest.js reads their own latest posts, then THE bulk like's loop (likeEach) likes them; ONE ledger unit
// for all of it, kind "like" (X's day counts them), gated and charged at a press's price, never past its quote or the
// balance. STREAMED when asked (Accept: application/x-ndjson, as /inbox/like-all: { total } once read, { left } per
// like, { final } the answer) to keep a 50-like press (~45 s) alive through nginx; the page says the progress on the
// button (public/js/post-actions.js likeLatest), and on the Likestorm page THE CELEBRATION: their card counts the likes
// and bursts with confetti when X is done. Without script, back to `back` with the toast. Never retried. The form's
// `n` (the Likestorm page's slider) asks for fewer than X allows; never more.
// THE SIZE OF A STORM: every like X's window has left, at most LIKE_ALL_MAX. The one rule for the slider, the press and
// the answer's `room`. Spending the whole window is fine: the header's stopwatch turns
// red quietly (public/js/limits.js; it only shakes and opens when X REFUSES one). (A storm once kept one like back to
// dodge the stopwatch's alarm at zero; the alarm was the bug.) → how many a storm may like now
const stormRoom = (left) => Math.max(0, Math.min(left, LIKE_ALL_MAX));
async function answerStorm(req, res, userId, back) {
  const stream = (req.get("accept") || "").includes("application/x-ndjson");
  const json = stream || wantsJson(req);
  const account = req.account;
  const allow = await writesLeft(account._id, "like");
  const asked = /^\d+$/.test(String(req.body.n || "")) ? Number(req.body.n) : Infinity;
  const n = Math.min(stormRoom(allow.left), asked);
  const s = syncSettings(account._id);
  let liked = [];
  let name = null;
  let key = n ? "liked-many" : "like-all-wait";
  const line = (o) => res.write(`${JSON.stringify(o)}\n`);
  if (stream) {
    res.set({ "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
    res.flushHeaders();
  }
  if (n) {
    const label = "Likestorm"; // named once done; named first: verify-billing reads a metered call's options up to their first closing brace
    const ceilingUsd = likeLatest.quoteUsd(n);
    try {
      [name] = await namesOf([userId]); // inside: a streamed answer's headers are out, so a failure must end as one
      await metered({ accountId: account._id, kind: "like", label, billing: s.billing, ceilingUsd }, async (meter) => {
        const x = createClient({ token: await s.getToken(), meter, ownerId: s.ownerId, readCap: likeLatest.READ_MAX, userCap: 0 });
        const ids = userId === account._id ? [] : await likeLatest.latestToLike(x, { accountId: account._id, userId, n });
        if (stream) line({ total: ids.length });
        if (!ids.length) return void (key = "latest-none");
        const r = await likeEach(account, ids, meter, { onEach: (i) => stream && i && line({ left: ids.length - i }) });
        liked = r.liked;
        if (r.stop) key = r.stop;
        if (liked.length) await meter.setLabel(`Liked ${liked.length.toLocaleString("en-US")} of ${name}'s posts`);
      });
    } catch (err) {
      key = xFailure(err, `[likestorm] ${userId} for @${account.username} (${liked.length} done)`);
    }
  }
  if (liked.length) await refreshOwedSafely(account._id); // one of theirs may have been waiting in your Inbox
  if (!json) return res.redirect(303, withNotice(back, key));
  const notice = noticeFor(key, liked.length ? `${liked.length.toLocaleString("en-US")} of ${name}'s posts` : null);
  const [likes, balance] = await Promise.all([likeAllowance(account, res.locals.timeZone), balanceText(account)]);
  const answer = { ok: true, liked, ...notice, likes, room: stormRoom(likes.left), balance };
  if (stream) res.end(`${JSON.stringify({ final: answer })}\n`);
  else res.json(answer);
}

// THE LIKESTORM's prices for its slider (views/likestorm.hbs, the second step): for each n from 1 to what X allows
// now, the estimate at this account's price (billing.priceFor of likeLatest.estimateUsd: a page of their posts and n
// likes), and the most the balance covers (`upTo`: the slider stops there; THE CEILING still caps the charge).
// → { left, at, ends (when X's window resets, ms, or null), max, upTo, prices: ["$0.034" written by the `cost` helper,
// for n = 1 …] }
async function stormChoices(account, timeZone) {
  const allow = await likeAllowance(account, timeZone);
  const left = stormRoom(allow.left);
  const ns = Array.from({ length: left }, (_, i) => i + 1);
  const prices = ns.map((n) => hbsOptions.helpers.cost(billing.priceFor(account, likeLatest.estimateUsd(n))));
  const upTo = ns.filter((n) => billing.affords(account, likeLatest.estimateUsd(n))).pop() || 0;
  return { left, at: allow.at, ends: allow.ends, max: LIKE_ALL_MAX, upTo, prices };
}

// What the two writes (a like, a reply) share. Each is a form that works without script (a redirect back to the post)
// and, from public/js, a JSON call that updates the page in place.
const wantsJson = (req) => (req.get("accept") || "").includes("application/json");
// Back to the page the form came from, on post `id` (#p<id>), without the page's earlier toast.
const backTo = (req, id) => {
  const u = new URL(safeBack(req.body.back, "/"), config.appOrigin);
  u.searchParams.delete("n");
  if (id) u.hash = `p${id}`;
  return u.pathname + u.search + u.hash;
};
// The header's balance after a write (it cost money): X's balance as just read for the owner, the account's own once
// its charge landed, written by the layout's own helper so the header reads the same either way.
const balanceText = async (account) => {
  const hb = headerBalance({ ...account, ...(await Account.findById(account._id, "xBalance balanceMicros").lean()) });
  return hb ? hbsHelpers.dollars(hb.usd) : null;
};
// A write X refused, as JSON: the notice, with X's own words when it said why (a reply too long, a duplicate).
const refusedJson = (res, n, err) => res.status(n === "x-limit" ? 429 : n === "out-of-balance" ? 402 : 502).json({ ok: false, ...noticeFor(n), ...(n === "x-failed" && err.detail && err.status >= 400 && err.status < 500 ? { text: `X said no: ${err.detail}` } : {}) });

// A module's switch as partials/switch.hbs draws it (the off page): POST /modules/:key with on=1|0.
// `back`: where the route lands after (a page's own switch, its title row: partials/page-switch.hbs); else Settings.
const moduleSwitch = (account, key, back) => ({ on: isOn(account, key), label: FEATURES[key].label, action: `/modules/${key}`, field: { name: "on", value: isOn(account, key) ? "0" : "1" }, back });
// KEEP SYNCING LIVE's switch (routes/pause.js /keep-live, services/away.js): the Inbox's title row and Settings.
const KEEP_LIVE_HINT = "Off: pauses after an hour away, and asks before catching up. Likes and follows meanwhile are missed.";
// → partials/page-switch.hbs's hash.
const keepLiveSwitch = (account, back) => {
  const on = account.keepLive !== false;
  return { label: "Keep syncing live", short: "Live", hint: KEEP_LIVE_HINT, toggle: { on, label: "Keep syncing live", action: "/keep-live", field: { name: "on", value: on ? "0" : "1" }, back } };
};

module.exports = {
  CIRCLE_PAGE,
  STORM_PAGE,
  START_PAGE,
  headerBalance,
  isLiveFor,
  requireAccount,
  safeBack,
  withNotice,
  paysHere,
  fundsView,
  pricedChoices,
  tagsChoices,
  historyChoices,
  furtherChoices,
  FURTHER_STATE,
  resumeChoices,
  pullView,
  navFor,
  navSums,
  modulesOf,
  countOf,
  startView,
  readyOrRender,
  PULL_STATE,
  replyBox,
  likeAllowance,
  conversationPage,
  xFailure,
  bulkLabel,
  namesOf,
  followMany,
  likeEach,
  answerStorm,
  stormChoices,
  stormRoom,
  wantsJson,
  backTo,
  balanceText,
  refusedJson,
  pageSwitch,
  keepLiveSwitch,
};
