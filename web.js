// web.js — the xtoolio Express app: createApp({ sessionStore }) builds the middleware + routes, with no listener and
// no DB connect (app.js does those and passes a Mongo-backed session store), so `npm run verify` can mount it on
// an in-memory store and check the security stack with no database.
"use strict";

const path = require("path");
const express = require("express");
const { engine } = require("express-handlebars");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = require("express-rate-limit");
const session = require("express-session");
const cookieParser = require("cookie-parser");
const { csrfProtection } = require("./lib/csrf");
const sessionAccounts = require("./lib/sessionAccounts");

const config = require("./config");
const hbsOptions = require("./lib/hbs");
const { limitsFrom, countdown } = require("./lib/writeLimits");
const { FONTS, DEFAULT_FONT, fontFor, fontsCss } = require("./lib/fonts");
const { ACCENTS, DEFAULT_ACCENT, accentFor, accentsCss } = require("./lib/accents");
const { tabIcons } = require("./lib/mark");
const circle = require("./services/circle");
const multer = require("multer");
const { MEDIA_LIMITS, MEDIA_MAX_BYTES, checkAttachments } = require("./lib/media");
const mediaLibrary = require("./services/mediaLibrary");
const { ZONES, DEFAULT_ZONE, zoneFor, dayIn } = require("./lib/timezone");
const { cursorTime } = require("./lib/feedCursor");
const { spendChart, chartSince } = require("./services/spendChart");
const theme = require("./lib/theme");
const { themeFor } = theme;
const permissionsPolicy = require("./lib/permissionsPolicy");
const { noticeFor } = require("./lib/notices");
const { PRICE } = require("./lib/pricing");
const Account = require("./models/Account");
const SyncState = require("./models/SyncState");
const LiveEvent = require("./models/LiveEvent");
const Draft = require("./models/Draft");
const { draftOf, threadAbove, railOfCard } = require("./services/inbox");
const inboxStart = require("./services/inboxStart");
const livePush = require("./services/livePush");
const people = require("./services/people");
const listing = require("./services/listing");
const { refreshOwedSafely } = require("./services/inboxCount");
const unseen = require("./services/unseenCount");
const likes = require("./services/likes");
const follows = require("./services/follows");
const Like = require("./models/Like");
const { accountPosts, postsById, profilesFor } = require("./services/accountData");
const { knownFor, knownAmong, savedMediaOf, conversationCard, postRowsFor, followRowsFor, loadPerson, loadThreadAbove, viewsOf } = require("./services/conversations");
const { runSync, summaryLine } = require("./services/sync");
const { syncSettings, isOwner, isAdmin } = require("./services/accounts");
const { usageSummary, usageRows, metered } = require("./services/usage");
const { createClient } = require("./lib/x");
const following = require("./services/following");
const estimator = require("./services/estimator");
const { handleOf } = require("./lib/handle");
const invites = require("./services/invites");
const { FEATURES, MODULES, isOn, granted, active, modulesOn, stormOnly, pullDue, firstReadGoing, turnOn } = require("./services/features");
const { likersByPost, setLike, setRepost, writesLeft, setFollow, sendReply, REPLY_MAX } = require("./services/extras");
const Follow = require("./models/Follow");
const billing = require("./services/billing");
const { toMicros } = require("./services/balance");
const autoRefill = require("./services/autoRefill");
const { accountEstimate } = require("./services/estimateView");
const auth = require("./routes/auth");
const inboxRoutes = require("./routes/inbox");
const peopleRoutes = require("./routes/people");
const mcpRoutes = require("./routes/mcp");
const agentRoutes = require("./routes/agents");
const accountRoutes = require("./routes/account");
const pauseRoutes = require("./routes/pause");
const pause = require("./services/pause");
const feedbackRoutes = require("./routes/feedback");
const adminRoutes = require("./routes/admin");
const taggedRoutes = require("./routes/tagged");
const likestormRoutes = require("./routes/likestorm");
const tagged = require("./services/tagged");
const agentOAuth = require("./services/agentOAuth");
const { connectionsFor } = require("./services/agentConnections");
const { CIRCLE_PAGE, STORM_PAGE, START_PAGE, startView, headerBalance, isLiveFor, requireAccount, safeBack, withNotice, paysHere, fundsView, pricedChoices, tagsChoices, historyChoices, furtherChoices, FURTHER_STATE, resumeChoices, pageSwitch, keepLiveSwitch, pullView, navFor, navSums, modulesOf, countOf, readyOrRender, PULL_STATE, likeAllowance, conversationPage, xFailure, bulkLabel, namesOf, wantsJson, backTo, balanceText, refusedJson, refuseBusy } = require("./routes/pages");
const { inFlight, inFlightMiddleware } = require("./lib/inFlight");

function createApp({ sessionStore }) {
  const app = express();

  /* ============================================================
      Basics
  ============================================================ */

  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy); // TRUST_PROXY (1 = nginx in front): req.ip / req.secure read X-Forwarded-*
  app.engine("hbs", engine(hbsOptions));
  app.set("view engine", "hbs");
  app.set("views", path.join(__dirname, "views"));

  // ONE address: a request on another hostname (localhost vs 127.0.0.1, www vs bare) goes to APP_ORIGIN first.
  // The session cookie belongs to one hostname and X calls back to exactly one, so they have to be the same.
  const canonicalHost = new URL(config.appOrigin).hostname;
  app.use((req, res, next) => {
    if (req.hostname === canonicalHost || (req.method !== "GET" && req.method !== "HEAD")) return next();
    res.redirect(301, config.appOrigin + req.originalUrl);
  });

  /* ============================================================
      Security — a strict CSP.
      All JS and CSS is first-party and served from here: no CDN, no inline <script>, no inline style, no on*=
      handlers (`npm run verify` greps the views for all three). The ONE outside origin is X's image CDN, for
      profile pictures, and only for images.
  ============================================================ */

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          // Profile pictures are served by X (Person.image → pbs.twimg.com). Allowing exactly that host, not
          // `https:`, keeps a stored post's text from ever pulling a tracking pixel from anywhere else.
          imgSrc: ["'self'", "data:", "https://pbs.twimg.com"],
          // GIFs play as X's own looping MP4s (partials/media-pic.hbs; lib/media.js sourceOf: video.twimg.com/
          // tweet_video/…). Exactly that host; a video post still plays on X, through the exit.
          mediaSrc: ["https://video.twimg.com"],
          fontSrc: ["'self'"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          frameAncestors: ["'self'"],
          // Forms only go to us, and a browser applies this to every redirect a form leads to: anything that ends
          // on x.com (sign-in, granting an extra's permission) must be a plain LINK to /auth/x, never a form.
          // verify-security fails on a form that points at /auth/x or a route that redirects there.
          formAction: ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false, // COEP would block X's avatars, which aren't served with CORP headers
    })
  );

  // Permissions-Policy: every powerful browser feature off (the list + the why: lib/permissionsPolicy.js).
  app.use((req, res, next) => {
    res.setHeader("Permissions-Policy", permissionsPolicy.DEFAULT);
    next();
  });

  /* ============================================================
      Stripe's webhook — BEFORE the body parsers and CSRF: the signature is over the raw bytes, and Stripe sends no
      CSRF token. 400 on a bad signature (never act on a forgery), 500 when handling throws (Stripe retries; every
      handler is idempotent), 503 until Stripe is configured. Only xtoolio's own kinds are acted on (services/billing.js).
  ============================================================ */

  app.post("/stripe/webhook", express.raw({ type: "application/json", limit: "1mb" }), async (req, res) => {
    if (!config.stripe.secretKey || !config.stripe.webhookSecret) return res.status(503).send("Billing isn't configured.");
    let event;
    try {
      event = billing.constructEvent(req.body, req.headers["stripe-signature"]);
    } catch (err) {
      console.error(`[stripe] webhook signature check failed: ${err.message.split("\n")[0]}`);
      return res.status(400).send("Bad signature.");
    }
    try {
      await billing.handleEvent(event);
    } catch (err) {
      console.error(`[stripe] handling ${event.type} failed: ${err.message}`);
      return res.status(500).send("Handler error.");
    }
    res.json({ received: true });
  });

  /* ============================================================
      /mcp — an account's own agent reading its data (routes/mcp.js), and the OAuth endpoints apps sign in through
      (services/agentOAuth.js: /.well-known/…, /register, /authorize, /token, /revoke). Here, BEFORE the cookie, form,
      session and CSRF layers and the site's IP limiter: apps sign in by a token, not a cookie, and each endpoint has
      its own limits. The approve page a person sees is a signed-in page (routes/agents.js).
  ============================================================ */

  app.use(mcpRoutes());

  /* ============================================================
      Parsing + static
  ============================================================ */

  app.use(cookieParser());
  app.use(express.urlencoded({ extended: false, limit: "100kb" }));

  // VERSIONED ASSETS ARE IMMUTABLE: a URL carrying `?v=` (every /js and /css tag a view emits,
  // via {{assetV}}) changes on every deploy, so a year-long cache can never serve a stale file. Anything unversioned
  // keeps express.static's default revalidation (max-age=0 + ETag → 304). Production only: in development the
  // version is the commit, which doesn't change while you edit files.
  const STATIC_DIR = path.join(__dirname, "public");
  const staticRevalidate = express.static(STATIC_DIR);
  const staticImmutable = config.production ? express.static(STATIC_DIR, { maxAge: "1y", immutable: true }) : staticRevalidate;
  app.use((req, res, next) => (req.query && req.query.v ? staticImmutable(req, res, next) : staticRevalidate(req, res, next)));
  // THE LOOK stylesheet: the fonts (lib/fonts.js) and the accents (lib/accents.js), generated once at boot, one file so
  // a page's first paint waits on one request (it was /fonts.css until the accents joined it). Versioned
  // like any asset (?v=), so it gets the same immutable cache as app.css in production. HERE, beside the static files
  // and before the session: it blocks every page's first paint, and below the session it waited on a session load and
  // an account lookup (two database round trips, ~78 ms against app.css's 4 ms, measured) and a rolling
  // session's write, for a constant.
  const LOOK_CSS = fontsCss() + accentsCss();
  app.get("/look.css", (req, res) => {
    res.type("text/css");
    res.set("Cache-Control", req.query.v && config.production ? "public, max-age=31536000, immutable" : "no-cache");
    res.send(LOOK_CSS);
  });
  // THE MARK in the tab, one per accent (lib/mark.js, from the header's own partial), generated once, served the
  // same way: the layout links the account's accent (`/mark-<key>.svg`), so a new accent shows on the next page load.
  const TAB_ICONS = tabIcons();
  app.get(/^\/mark-([a-z]+)\.svg$/, (req, res, next) => {
    const svg = TAB_ICONS.get(req.params[0]);
    if (!svg) return next();
    res.type("image/svg+xml");
    res.set("Cache-Control", req.query.v && config.production ? "public, max-age=31536000, immutable" : "no-cache");
    res.send(svg);
  });
  // THE HOME SCREEN APP (the start page tells a phone it can add the site to its Home Screen): a web app
  // manifest, so a phone opens it from the Home Screen in a window of its own
  // (`standalone`) with THE MARK's full-bleed icons (scripts/make-mark.js); the layout links it, with iOS's own
  // apple-mobile-web-app-capable beside it. Its name is the deployment's (BRAND_NAME), generated once like /look.css.
  const MANIFEST = JSON.stringify({
    name: config.brandName,
    short_name: config.brandName,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f4f6f8", // the light --bg (app.css): the splash before the first paint
    theme_color: accentFor(DEFAULT_ACCENT).light.accent,
    icons: ["any", "maskable"].flatMap((purpose) => [192, 512].map((s) => ({ src: `/icon-${s}.png`, sizes: `${s}x${s}`, type: "image/png", purpose }))),
  });
  app.get("/manifest.webmanifest", (req, res) => {
    res.type("application/manifest+json");
    res.set("Cache-Control", "no-cache");
    res.send(MANIFEST);
  });
  // The circle's seats (services/circle.js circleCss), generated once, served the same way; linked only by pages that
  // draw a circle (`circlePage`).
  const CIRCLE_CSS = circle.circleCss();
  app.get("/circle.css", (req, res) => {
    res.type("text/css");
    res.set("Cache-Control", req.query.v && config.production ? "public, max-age=31536000, immutable" : "no-cache");
    res.send(CIRCLE_CSS);
  });

  /* ============================================================
      Sessions: stored in Mongo (app.js passes the store), rolling, only created when
      something is put in them (saveUninitialized: false), so bots and signed-out visits mint no session docs.
  ============================================================ */

  app.use(
    session({
      name: auth.SESSION_COOKIE,
      secret: config.sessionSecret,
      store: sessionStore,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: "lax", // lax, not strict: X's redirect back to /auth/x/callback is a top-level GET that needs it
        secure: "auto", // Secure whenever the connection is (behind nginx+TLS: always); local http still works
        maxAge: config.sessionDays * 24 * 3600 * 1000,
      },
    })
  );

  // The signed-in account: THE ACTIVE ONE (one lookup by _id per request, like passport's deserialize). One that's
  // gone (deleted, maybe from another browser) comes off the list and the next one on it takes over; none left is
  // signed out. With more than one signed in here (THE ACCOUNT SWITCHER, lib/sessionAccounts.js), `req.others`: the
  // rest, for the header's menu, in the order added (one indexed read, only for such a session).
  app.use(async (req, res, next) => {
    if (!req.session || !req.session.accountId) return next();
    while (req.session.accountId && !(req.account = await Account.findById(req.session.accountId, Account.REQUEST_FIELDS).lean())) sessionAccounts.forget(req.session, req.session.accountId);
    const others = sessionAccounts.listOf(req.session).filter((id) => req.account && id !== req.account._id);
    if (others.length) {
      // Who they are, and what their sidebar's counts come from (THE COUNT, routes/pages.js countOf).
      const found = new Map((await Account.find({ _id: { $in: others } }, "username name image features inboxOwed likesUnseen followsUnseen mediaSaved.at mediaSeenAt").lean()).map((a) => [a._id, a]));
      if (found.size < others.length) req.session.accounts = sessionAccounts.listOf(req.session).filter((id) => id === req.account._id || found.has(id));
      req.others = others.filter((id) => found.has(id)).map((id) => found.get(id));
    }
    next();
  });

  /* ============================================================
      Rate limiting — keyed on IP ALONE: never add a client-controlled component (cookie,
      session, header) to the key, or a client that drops cookies gets a fresh bucket per request. Signed-in
      traffic is trusted.
  ============================================================ */

  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      limit: 120,
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req) => !!req.account,
      keyGenerator: (req) => ipKeyGenerator(req.ip),
    })
  );
  // THE ACCOUNT LIMIT: signed in, a limit per ACCOUNT instead (its id is the server's own session lookup, never
  // anything the client sends), generous for a person (searching as you type, the Inbox's views fetched as the pointer
  // rests, presses), so one account's script can't tie up the web processes with page builds. Per process, like the
  // other limiters. Before it, signed-in traffic had no limit at all.
  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      limit: 300,
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req) => !req.account,
      keyGenerator: (req) => `account:${req.account._id}`,
      handler: refuseBusy,
    })
  );

  /* ============================================================
      CSRF — csrf-csrf, set up in lib/csrf.js: a signed double-submit token bound to the login session, in an
      httpOnly cookie (`__Host-` in production). Token from x-csrf-token or a _csrf field. After the session
      middleware (it reads the session's id) and the body parsers.
  ============================================================ */

  app.use(csrfProtection({ key: config.sessionSecret, production: config.production }).protect);

  // Locals: templating values ONLY, no DB lookups (per-page lookups in locals seed N+1 queries).
  app.use((req, res, next) => {
    res.locals.brandName = config.brandName;
    res.locals.siteDomain = config.siteDomain;
    // IN BETA (config.beta): the header's "Beta" tag, and the code offered nowhere yet: the front page says it comes
    // after the beta, with self-hosting (views/landing.hbs, the estimator's Self-hosted column).
    res.locals.beta = config.beta;
    const repo = config.beta ? "" : config.sourceRepoUrl;
    res.locals.sourceRepoUrl = repo;
    // The address as the front page's terminal line writes it, runnable by `git clone` ("https://github.com/xtoolio/xtoolio").
    res.locals.sourceRepoLabel = repo ? repo.replace(/\/+$/, "") : null;
    res.locals.madeBy = config.madeBy && config.madeIn ? { handle: config.madeBy, place: config.madeIn } : null; // the footer's credit
    res.locals.siteX = config.siteX || null; // the site's own X account (the footer, the waitlist page)
    res.locals.feedbackMax = feedbackRoutes.TEXT_MAX; // THE feedback box's limit (partials/feedback-modal.hbs maxlength)
    res.locals.feedbackShots = feedbackRoutes.SHOT_RULES; // its screenshots' rules (data-shots, public/js/feedback.js)
    res.locals.waitlistOn = !config.signup.anyone; // sign-up isn't open to anyone: the calls to action say "Join the waitlist" (partials/get-started.hbs)
    res.locals.csrfToken = req.csrfToken();
    res.locals.currentPath = req.originalUrl; // where a form returns you (path + query, e.g. ?sort=last)
    // Which of the sidebar's places this page is under: the Inbox (/), Your posts (/posts and each post's page: the Likes
    // module's place), Follows (/follows), Your people (/people and everyone's pages), Usage, Settings.
    res.locals.tab = req.path === "/" ? "inbox" : req.path === likes.listing.path || /^\/posts\/\d+$/.test(req.path) ? "likes" : req.path === follows.listing.path ? "follows" : req.path === listing.people.path || req.path.startsWith(`${listing.people.path}/`) ? "people" : req.path === "/usage" ? "usage" : req.path === "/settings" || req.path.startsWith("/settings/") ? "settings" : req.path === mediaLibrary.PAGE ? "media" : null;
    if (req.path === CIRCLE_PAGE) res.locals.tab = "circle"; // its own place, though its address is under People's
    if (req.path === "/admin") res.locals.tab = "admin";
    if (req.path === STORM_PAGE) res.locals.tab = "likestorm";
    res.locals.account = req.account || null;
    res.locals.admin = isAdmin(req.account); // the sidebar's Admin (routes/admin.js)
    // Which modules are on (paused ones too: their page says why), and THE sidebar built from them (navFor).
    res.locals.modules = req.account ? modulesOf(req.account) : null;
    res.locals.nav = req.account ? navFor(req.account, res.locals.modules, res.locals.tab) : null;
    // The signed-in person in the shape the avatar partial takes ({ username, profile: { name, image } }).
    res.locals.me = req.account ? { username: req.account.username, profile: { name: req.account.name, image: req.account.image } } : null;
    // THE ACCOUNT SWITCHER (the header's menu, partials/account-menu.hbs): the other accounts signed in on this browser,
    // in the avatar's shape, each with THE COUNT (its sidebar's counts added up, as this page's title says this one's),
    // and whether there's room to add one. `othersCount`: any of theirs, the menu button's dot.
    res.locals.otherAccounts = (req.others || []).map((a) => ({ id: a._id, username: a.username, profile: { name: a.name, image: a.image }, n: countOf(a) }));
    res.locals.othersCount = res.locals.otherAccounts.some((a) => a.n > 0);
    res.locals.canAddAccount = req.account ? sessionAccounts.listOf(req.session).length < sessionAccounts.MAX_ACCOUNTS : false;
    res.locals.theme = themeFor(req);
    res.locals.font = fontFor(req.account && req.account.font); // { key, href, ... } for <html data-font> + preload
    res.locals.accent = accentFor(req.account && req.account.accent); // { key, ... } for <html data-accent>; signed out: the default
    // The zone every date helper writes in (lib/hbs.js reads it off the render's root).
    res.locals.timeZone = zoneFor(req.account && req.account.timeZone) || DEFAULT_ZONE;
    // Out of balance, so syncing is paused (Sync now hides). Not before the first pull is chosen: that page asks for
    // the money itself.
    // Or HELD (THE PAUSE, services/pause.js: paused by you, or back with money after a long stop): the banner's Resume,
    // except on the question's own page, which says it already.
    const dry = billing.paused(req.account);
    const held = !!req.account && pause.held(req.account, dry);
    res.locals.paused = (dry || held) && modulesOn(req.account).length > 0;
    res.locals.heldBanner = held && modulesOn(req.account).length > 0 && req.path !== "/resume";
    // The billing banner: refill failed, paused, or low with refill off (services/autoRefill.js notice).
    res.locals.billingNotice = autoRefill.notice(req.account);
    res.locals.headerBalance = headerBalance(req.account);
    // X's write windows in use now (likes, follows, replies...), kept on the account: the header's countdown.
    res.locals.limits = req.account ? limitsFrom(req.account.writeLimits).map((l) => ({ ...l, resetIn: countdown(l.ends) })) : [];
    res.locals.limitsSpent = res.locals.limits.some((l) => !l.left); // its folded stopwatch turns red
    // "● Live" on the sync button: X's stream is up (in memory, services/livePush.js) and this account is subscribed.
    res.locals.live = isLiveFor(req.account);
    // What the redirect that led here left behind (?n=<key>, lib/notices.js): the layout's toast, on any page.
    // With ?u=<token>, a Done press's undo (models/InboxUndo.js): the toast carries an Undo button.
    res.locals.toast = noticeFor(req.query.n);
    if (res.locals.toast && /^[a-f0-9]{24}$/.test(String(req.query.u || ""))) res.locals.toast = { ...res.locals.toast, undo: req.query.u };
    next();
  });
  // THE AWAY BAR (services/away.js; the layout): the one lookup in the locals, and only while this account is paused
  // for being away, on a page load (not /live's stream or a script's fetch): Catch up's price is the resume read's own
  // (routes/pages.js resumeChoices, which reads only the database, never X).
  app.use(async (req, res, next) => {
    if (!res.locals.heldBanner || req.account.pause.why !== "away" || req.method !== "GET" || !req.accepts("html") || req.path === "/live") return next();
    try {
      const long = pause.asks(req.account);
      const options = long ? [] : await resumeChoices(req.account);
      res.locals.away = { for: pause.awayFor(req.account), long, since: options.find((o) => o.key === "since"), skip: options.find((o) => o.key === "now") };
    } catch (err) {
      console.error(`[away] the bar's prices: ${err.message}`);
    }
    next();
  });

  app.use((err, req, res, next) => {
    // A press from a page drawn for another account (THE ACCOUNT SWITCHER: switched in another tab; the token is bound
    // to the active account, lib/csrf.js) or simply too old: refused, never acted on. A press from script gets THE
    // toast's words (post-actions.js shows a refusal's `text`).
    if (err && err.code === "EBADCSRFTOKEN") {
      if ((req.get("accept") || "").includes("json") || req.get("x-csrf-token")) return res.status(403).json({ ok: false, ...noticeFor("page-stale") });
      return res.status(403).send("This page is out of date. Go back and reload it.");
    }
    next(err);
  });

  /* ============================================================
      Routes
  ============================================================ */

  app.get("/healthz", (req, res) => res.json({ ok: true }));

  // Terms and Privacy, public. Every number they state comes from config, so the pages can't drift from the code.
  const legal = {
    charges: config.billing.enabled, // the billing terms and Stripe appear only where the site charges
    entity: config.legalEntity,
    jurisdiction: config.legalJurisdiction,
    contactX: config.contactX,
    depositUsd: config.billing.depositUsd,
    stormDepositUsd: config.billing.stormDepositUsd, // LIKESTORM ONLY's first payment
    refillThresholdUsd: (config.billing.autoRefillThresholdCents / 100).toFixed(0),
    refillLimitUsd: autoRefill.DEFAULT_LIMIT, // THE MONTHLY LIMIT's default (services/autoRefill.js)
    sessionDays: config.sessionDays,
    markupPct: Math.round((config.billing.multiplier - 1) * 100),
    markupCapUsd: config.billing.markupCapUsd || null,
    markupAfterPct: config.billing.markupAfterCapPct,
    bulkPct: config.billing.bulkMarkupPct,
  };

  // A visitor's estimate from a real account costs the platform ~3 cents (services/estimator.js): at most 5 a day per
  // visitor (keyed on IP alone, like the main limiter), and a visitor past it still sees any handle already measured
  // today. The limiter only marks the request; the page renders either way. In front of EVERY page, not only "/": any
  // signed-out page reaches the same estimate through readyOrRender's landing, and only "/" was limited.
  const estimateLimiter = rateLimit({
    windowMs: 24 * 3600 * 1000,
    limit: 5,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: (req) => `estimate:${ipKeyGenerator(req.ip)}`,
    skip: (req) => !!req.account || !handleOf(req.query.handle),
    handler: (req, res, next) => {
      req.estimateSpent = true;
      next();
    },
  });
  app.use((req, res, next) => (req.method === "GET" ? estimateLimiter(req, res, next) : next()));
  app.get("/terms", (req, res) => res.render("terms", { legal }));
  app.get("/privacy", (req, res) => res.render("privacy", { legal }));
  app.use(auth.router);

  app.use(inboxRoutes());

  app.use(peopleRoutes());

  app.use(agentRoutes()); // connecting an agent: the approve page, tokens, disconnect (the door is routes/mcp.js)

  app.use(accountRoutes()); // deleting the account (services/deleteAccount.js)
  app.use(pauseRoutes()); // pausing, and how far back to read on resuming (services/pause.js)
  app.use(feedbackRoutes()); // sending feedback (the sidebar's Feedback)
  app.use(adminRoutes()); // the admins' page: feedback, the waitlist

  // A feed page (Likes, Follows) opened: every row up to now is seen (its tab's red count, services/unseenCount.js) →
  // when they were last seen (the rows newer than that are `fresh`). This page's own header shows 0 (res.locals.account
  // is req.account).
  // Opening a feed (Likes, Follows) sees everything in it. Its sidebar count is still drawn with the number you came for
  // (the nav was built from the account as it was), marked `clearing`: it holds for a moment, then fades out (CSS),
  // decided here, so the page never draws it and then drops it (the count you came for fades out, it never
  // flashes off and back on). The Inbox's count is never cleared by a
  // visit: it's the likes and replies you still owe, and only doing them moves it.
  const openFeed = async (req, res, tab) => {
    const before = await unseen.seen(req.account._id, tab);
    req.account[`${tab}Unseen`] = 0;
    clearing(res, tab);
    return before;
  };
  // A place's count, seen on its own page: drawn with the number you came for, fading (also the Media page's).
  const clearing = (res, tab) => {
    const item = res.locals.nav && res.locals.nav.items.find((i) => i.key === tab);
    if (item && item.badge && item.badge.n > 0) {
      item.badge.clearing = true;
      Object.assign(res.locals.nav, navSums(res.locals.nav.items)); // the title's count and the ☰'s dot, without it
    }
  };
  // New rows stream into a feed only where they belong at the top: the default view's first page (no search or filter,
  // newest first).
  const streamsInto = (L, list) => L.hrefFor(list, { page: 1 }) === L.path && list.page === 1;

  // YOUR POSTS (the Likes module's page; services/likes.js): every post of yours and each reply that drew something,
  // with its likes, reposts and replies, the latest activity first; a row opens the post here (/posts/:id). A live like
  // brings its row to the top of the default view (public/js/live.js, from /posts/card/:postId). Opening it marks every
  // like seen; the rows with a live like since the last visit say so (`fresh`). It used to be "Likes" at /likes
  // (only the posts someone liked, each a link to X): the old address comes here.
  app.get("/likes", (req, res) => res.redirect(301, likes.listing.path + (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "")));
  app.get(likes.listing.path, async (req, res) => {
    const state = await readyOrRender(req, res, "likes");
    if (!state) return;
    const seenBefore = await openFeed(req, res, "likes");
    const L = likes.listing;
    const rows = await postRowsFor(req.account, { seenBefore });
    const list = L.listRows(rows, L.parseQuery(req.query));
    // THE TABS: All / Posts / Replies, each with its count in the view's search.
    const tabs = [["all", "All"], ["post", "Posts"], ["reply", "Replies"]].map(([key, label]) => ({ key, label, n: L.listRows(rows, { ...list, kind: key, page: 1 }).matched, href: L.hrefFor(list, { kind: key, page: 1 }), on: list.kind === key }));
    res.render("likes", {
      wide: true, // a table of rows, the window's width
      state,
      path: L.path,
      tabs,
      list,
      pager: L.pager(list),
      sorts: [["newest", "Latest activity"], ["posted", "Newest post"], ["most", "Most liked"]].map(([key, label]) => ({ key, label, selected: key === list.sort })),
      keep: L.keep(list),
      reverseHref: L.sortHref(list, list.sort),
      streams: streamsInto(L, list),
      headSwitch: pageSwitch(req.account, "likes"),
    });
  });

  // Follows: who followed and unfollowed you, as X tells it (Live: follow.follow / follow.unfollow, the Follows, live extra),
  // newest first, arriving live like Likes. All / Followed / Unfollowed, a search, sorts. Starts when the subscription
  // did: X has no history of them to fetch.
  app.get(follows.listing.path, async (req, res) => {
    const state = await readyOrRender(req, res, "follows");
    if (!state) return;
    const seenBefore = await openFeed(req, res, "follows");
    const L = follows.listing;
    const rows = await followRowsFor(req.account, { seenBefore });
    const list = L.listRows(rows, L.parseQuery(req.query));
    res.render("follows", {
      state,
      wide: true, // a grid of person cards, as Your people
      list,
      head: followsHead({ current: list.show, hrefFor: (show) => L.hrefFor(list, { show, page: 1 }) }),
      pager: L.pager(list),
      sorts: [["newest", "Newest"], ["followers", "Most followers"]].map(([key, label]) => ({ key, label, selected: key === list.sort })),
      keep: L.keep(list),
      reverseHref: L.sortHref(list, list.sort),
      canFollow: active(req.account, "following"),
      funds: await fundsView(req.account),
      streams: streamsInto(L, list),
      headSwitch: pageSwitch(req.account, "follows"),
    });
  });

  // X's cost of one person in a list read (the accounts it follows: Not following back): a profile, or for the owner's
  // own list the Owned Read rate.
  const perFollower = (aid) => (isOwner(aid) ? PRICE.owned : PRICE.user);

  // THE FOLLOWS HEAD, the same on the feed and the reconciler's page (partials/follows-head.hbs): the feed's tabs, Recent
  // / Followed you / Unfollowed you (its `show`: EVENTS since the app started watching), UNCOUNTED (X has no
  // history of follows, so a count would be only what arrived since the subscription, never complete), and APART from
  // them the reconciler's button, Not following back (PEOPLE you follow now), uncounted too (its count was
  // only the default threshold's, under 1,000 followers, and read as fixed). It's its own thing, beside the three
  // ("All 87" beside it had read as 78 of everyone). `current`: the feed's tab in view, or "back".
  // After them, Who they tag (routes/tagged.js): finding people to follow from someone else's posts. `current` "tags".
  function followsHead({ current, hrefFor = null }) {
    const L = follows.listing;
    const tabs = [["all", "Recent"], ["follow", "Followed you"], ["unfollow", "Unfollowed you"]].map(([key, label]) => ({ key, label, href: hrefFor ? hrefFor(key) : L.hrefFor(L.parseQuery({}), { show: key, page: 1 }), on: current === key }));
    return { tabs, back: { href: following.listing.path, on: current === "back" }, tags: { href: tagged.listing.path, on: current === "tags" } };
  }
  app.use(taggedRoutes({ followsHead }));
  app.use(likestormRoutes());

  // Where the reading of the accounts this one follows stands (SyncState.following: services/following.js), or null.
  const followingWalk = async (aid) => ((await SyncState.findById(aid, "following").lean()) || {}).following || null;

  // The accounts this one follows that don't follow it back, from the stored pairs (services/following.js). `pages`:
  // also who has a People page (their name opens it; needs the account's posts, ~0.4 s: the tab's count skips it).
  async function followBackRowsFor(account, { pages = true } = {}) {
    const aid = account._id;
    const [mine, theirs] = await Promise.all([Follow.find({ followerId: aid, follows: true }, "followeeId").lean(), Follow.find({ followeeId: aid }, "followerId follows").lean()]);
    const followsYou = new Map(theirs.map((f) => [f.followerId, f.follows]));
    const ids = mine.map((f) => f.followeeId).filter((id) => followsYou.get(id) === false);
    if (!ids.length) return [];
    const [profiles, posts] = await Promise.all([profilesFor(ids), pages ? accountPosts(aid) : null]);
    const known = posts ? knownFor(account, posts.map((p) => people.exchangeWith(p, aid)).filter(Boolean).map((ex) => ex.personId)) : new Set();
    return following.notFollowingBack(ids, followsYou, { profiles, known });
  }

  // The reconciler's read, priced on the spot (pricedChoices), by where its walk stands (following.followingOptions):
  // the tiers before any read, THE REST after a partial one, nothing after a whole one unless the Follows module was
  // turned on since (`reread`: its events weren't subscribed meanwhile, so the pairs may be stale).
  async function followingChoices(account, walk) {
    if (walk === undefined) walk = await followingWalk(account._id);
    const since = account.features && account.features.follows && account.features.follows.since;
    const reread = !!(walk && walk.complete && walk.listedAt && since && new Date(since) > new Date(walk.listedAt));
    return pricedChoices(account, following.followingOptions(account.following, { perUser: perFollower(account._id), walk, reread }));
  }

  // THE FOLLOW RECONCILER's page (Follows → Not following back). Nothing is read from X here: the
  // read is its own button (POST below), run by the worker; while it runs the page counts up (public/js/live.js).
  app.get(following.listing.path, async (req, res) => {
    const state = await readyOrRender(req, res, "follows");
    if (!state) return;
    const B = following.listing;
    const query = { ...B.parseQuery(req.query), q: "" }; // no search box here: the threshold drives the list
    const walk = await followingWalk(req.account._id);
    const choices = await followingChoices(req.account, walk);
    const listed = walk && walk.listedAt ? walk : null;
    const reading = walk && walk.want ? { ...walk.want, text: (walk.want.readNow || 0).toLocaleString("en-US") } : null;
    const rows = listed ? await followBackRowsFor(req.account) : [];
    const list = B.listRows(rows, query);
    const underOf = (v) => `under ${Number(v).toLocaleString("en-US")} followers`;
    const unders = following.UNDER.map((v) => ({ value: v, label: v === "any" ? "Any number of followers" : `U${underOf(v).slice(1)}`, selected: v === list.under }));
    // Once a read is done, ONE button at most: THE REST, or the whole list again when it may be stale.
    const again = listed && !reading ? choices[choices.length - 1] || null : null;
    if (reading) res.locals.refreshNoScript = 5; // without script, the page reloads until the read is done
    res.render("follows-back", {
      state,
      wide: true,
      list,
      listed,
      reading,
      choices,
      again,
      underWords: list.under === "any" ? null : underOf(list.under),
      funds: await fundsView(req.account),
      head: followsHead({ current: "back" }),
      headSwitch: pageSwitch(req.account, "follows"),
      unders,
      pager: B.pager(list),
      sorts: [{ key: "followers", label: "Fewest followers", selected: true }], // one sort: no dropdown, the arrow reverses it
      keep: B.keep(list).filter((k) => k.name !== "under"), // the threshold travels in its own select
      reverseHref: B.sortHref(list, list.sort),
      canFollow: active(req.account, "following"),
      // Bulk unfollow (POST below): the cards' checkboxes, the red button and its question, priced for this account.
      picking: active(req.account, "following"),
      unfollowMax: UNFOLLOW_MAX,
      // How many X allows right now (its 15-minute window), said beside the button once some are used.
      unfollowLeft: await writesLeft(req.account._id, "unfollow").then((a) => (a.left < a.afterReset ? a.left : null)),
      unfollowEach: billing.priceFor(req.account, PRICE.unfollow),
    });
  });

  // Read the accounts you follow (a choice from followingChoices, recomputed here: only its key comes from the form):
  // RECORDED for the worker (services/followingReads.js), which reads it page by page at the usual markup (only
  // onboarding gets the 15% rate), never charged past its quote, capped at the choice. Refused when the
  // balance doesn't cover the quote; a press while one is being read records nothing (the filter: no `want` yet).
  app.post(`${following.listing.path}/read`, requireAccount, async (req, res) => {
    const aid = req.account._id;
    const back = following.listing.path;
    if (!active(req.account, "follows")) return res.redirect(303, back);
    const walk = await followingWalk(aid);
    if (walk && walk.want) return res.redirect(303, back);
    const choice = (await followingChoices(req.account, walk)).find((o) => o.key === req.body.key);
    if (!choice) return res.redirect(303, back);
    if (!choice.affordable) return res.redirect(303, withNotice(back, "bulk-short"));
    try {
      await SyncState.updateOne({ _id: aid, "following.want": { $exists: false } }, following.wantUpdate(choice), { upsert: true });
    } catch (err) {
      if (err.code !== 11000) throw err; // a second press, at once: the first one's want is there
    }
    res.redirect(303, back);
  });

  // BULK UNFOLLOW from the reconciler's page (it replaced one press each). Only
  // accounts on THIS account's not-following-back list (the form names ids, the route keeps only those: never a
  // mutual, never anyone else), at most what X allows NOW (extras.writesLeft "unfollow": X's own 15-minute window for
  // DELETE /users/:id/following; it used to send up to 50 and let X's refusal stop it) and
  // UNFOLLOW_MAX, one after another through THE write (extras.setFollow: each its own metered unit,
  // charged as a press is; each flips its pair, which moves the header's "following" by one, so open tabs count down as
  // it goes). X's limit or a refusal stops it there, with what's done kept; the header's countdown says when more come.
  // From public/js/post-actions.js (JSON): { ok, done: ids unfollowed, me, balance, text, kind, href }: the page
  // folds those cards out in place (a plain reload landed past the list's new end, on cards still
  // followed, and it read as "it didn't work"). Without script: back to the page with the toast.
  const UNFOLLOW_MAX = 50;
  app.post(`${following.listing.path}/unfollow`, requireAccount, async (req, res) => {
    const aid = req.account._id;
    const json = wantsJson(req);
    const back = safeBack(req.body.back, following.listing.path);
    const answer = (n, done = [], extra = {}) => {
      if (!json) return res.redirect(303, withNotice(back, n));
      const notice = noticeFor(n, done.length ? `${done.length.toLocaleString("en-US")} ${done.length === 1 ? "account" : "accounts"}` : null);
      return res.json({ ok: true, done, ...notice, href: withNotice(back, n), ...extra });
    };
    if (!active(req.account, "following")) return json ? res.status(400).json({ ok: false, ...noticeFor("x-failed") }) : res.redirect(303, back);
    const asked = [...new Set([].concat(req.body.ids || []).map(String).filter((id) => /^\d+$/.test(id)))];
    if (!asked.length) return answer("unfollow-none");
    const onList = new Set((await followBackRowsFor(req.account, { pages: false })).map((r) => r.id));
    const listed = asked.filter((id) => onList.has(id));
    if (!listed.length) return answer("unfollow-none"); // none of them on the list: nothing sent
    const allow = await writesLeft(aid, "unfollow");
    if (!allow.left) return answer("unfollow-wait");
    const ids = listed.slice(0, Math.min(allow.left, UNFOLLOW_MAX));
    const s = syncSettings(aid);
    const done = [];
    let n = ids.length < listed.length ? "unfollowed-some" : "unfollowed-many";
    // ONE ledger row for the press, named with whom (as the bulk like).
    const unfollowEach = async (meter) => {
      for (const [i, personId] of ids.entries()) {
        // THE CEILING for a bulk press: past the first unfollow, none once what's sent has reached what the balance covers.
        if (i && meter.atCeiling()) {
          n = "unfollowed-balance";
          break;
        }
        try {
          // "same": already not followed (a second tab, X's own echo): off the list all the same.
          if (["unfollowed", "same"].includes(await setFollow({ ...s, personId, on: false, meter }))) done.push(personId);
        } catch (err) {
          n = xFailure(err, `[unfollow] ${personId} for @${req.account.username} (bulk, ${done.length} done)`);
          if (n === "x-limit") n = "unfollow-limit";
          else if (n === "out-of-balance" && done.length) n = "unfollowed-balance";
          break;
        }
      }
      if (done.length) await meter.setLabel(bulkLabel("Unfollowed", await namesOf(done)));
    };
    try {
      await metered({ accountId: aid, kind: "follow", label: "Unfollowed", billing: s.billing }, unfollowEach);
    } catch (err) {
      n = xFailure(err, `[unfollow] for @${req.account.username} (bulk)`); // the gate refused it before X
    }
    if (!json) return answer(n);
    const me = await Account.findById(aid, "followers following countsV").lean();
    answer(n, done, { me: me && Account.meOf(me), balance: await balanceText(req.account) });
  });

  // One Follows card (partials/follow-card.hbs), for public/js/live.js to put at the top when a follow or unfollow arrives.
  // 204 when there's no such event of this account's.
  app.get(`${follows.listing.path}/row/:eventId`, requireAccount, async (req, res) => {
    const eventId = String(req.params.eventId);
    const [row] = /^[\w-]{1,64}$/.test(eventId) ? await followRowsFor(req.account, { eventId }) : [];
    if (!row) return res.status(204).end();
    res.locals.currentPath = follows.listing.path;
    res.render("follow-card", { layout: false, ...row, fresh: true, canFollow: active(req.account, "following") });
  });

  // One post's Your posts row (partials/like-card.hbs), for public/js/live.js to put at the top when a like arrives. 204
  // when it isn't one of yours (or isn't stored).
  app.get(`${likes.listing.path}/card/:postId`, requireAccount, async (req, res) => {
    const postId = String(req.params.postId);
    const [card] = /^\d+$/.test(postId) ? await postRowsFor(req.account, { postId }) : [];
    if (!card) return res.status(204).end();
    res.locals.currentPath = likes.listing.path;
    res.render("like-card", { layout: false, ...card, fresh: true });
  });

  // A feed page (Likes, Follows) is in view and a row just arrived on it (public/js/live.js): it's seen, so the tab's
  // count stays 0.
  app.post("/:tab/seen", requireAccount, async (req, res) => {
    if (!Object.hasOwn(unseen.TABS, req.params.tab)) return res.status(404).end();
    await unseen.seen(req.account._id, req.params.tab);
    res.status(204).end();
  });

  // A like on your post just arrived LIVE on another page in view (its like line redrawn under the post: public/js/
  // live.js): you saw it, so it isn't news on the Likes page (Like.viewedAt, services/likes.js NEWS).
  // Only that post's likes not already viewed; the Likes tab's count follows.
  app.post(`${likes.listing.path}/viewed`, requireAccount, async (req, res) => {
    const postId = String(req.body.postId || "");
    if (!/^\d+$/.test(postId)) return res.status(400).end();
    const aid = req.account._id;
    const r = await Like.updateMany({ accountId: aid, authorId: aid, postId, likerId: { $ne: aid }, ...likes.NEWS }, { $set: { viewedAt: new Date() } });
    if (r.modifiedCount) await unseen.refreshUnseen(aid, "likes");
    res.status(204).end();
  });

  // ONE POST OF YOURS (/posts/:id; a Your posts row opens it): its conversation THROUGH THE ENGINE (the same
  // finished post the Inbox draws when working on it; it replaced the post, its totals and a list of everyone who
  // liked, reposted or replied, each to follow): the Inbox's card, whole. Nobody else wrote in it: the post alone, its
  // likers' faces. Your own posts only; nothing is read from X.
  app.get(`${likes.listing.path}/:id`, async (req, res) => {
    const state = await readyOrRender(req, res, "likes");
    if (!state) return;
    const aid = req.account._id;
    const postId = String(req.params.id);
    const [post] = /^\d+$/.test(postId) ? await postsById(aid, [postId]) : [];
    if (!post || post.authorId !== aid) return res.redirect(303, likes.listing.path);
    const conv = post.conversationId || post._id;
    // THE PEOPLE RAIL (the Inbox's rail inside a post: we're in one post, so people only): everyone who wrote
    // in it, Everyone first; a name narrows the card to their replies (`?person=`, conversationCard), the
    // rest folded in place. Only with two or more of them (one name under Everyone would restate the card).
    const person = /^\d{1,20}$/.test(String(req.query.person || "")) ? String(req.query.person) : "";
    const engine = await conversationCard(req.account, conv, { person });
    const here = `${likes.listing.path}/${postId}`;
    const writers = engine ? railOfCard(engine.card) : null;
    const picked = engine ? engine.list.person : "";
    const rail = writers && writers.people.length > 1
      ? {
          // Its rows only PICK (rail-row.hbs): their ♥ and ✓ presses answer for the Inbox's views; here the card's own
          // ♥ Like N and Mark done (scoped to the person picked) and each reply's do the work.
          picksOnly: true,
          everyone: { key: "all", all: true, href: here, on: !picked, like: writers.like, reply: writers.reply },
          rows: writers.people.map((p) => ({ key: p.id, person: p.id, who: p, like: p.like, reply: p.reply, href: `${here}?person=${p.id}`, on: p.id === picked })),
        }
      : null;
    let alone = null;
    if (!engine) {
      // What it answers stays in view (a reply drawn alone gave no way to see what it answered). A reply to someone: your conversation with them, as their People page's
      // conversation draws it (their post, your reply under it). Else (a post of yours, or your own thread going on):
      // the stored posts it answers, up the chain, above it.
      const toId = post.inReplyToUserId && post.inReplyToUserId !== aid ? post.inReplyToUserId : null;
      if (toId) alone = (await loadPerson(aid, toId, conv, { canLike: active(req.account, "liking"), canRepost: active(req.account, "reposting"), mediaSaved: savedMediaOf(req.account) })).threads[0] || null;
      if (!alone) {
        // THE THREAD ABOVE, as an Inbox card draws it (inbox.threadAbove), shown whole: this page is about the post.
        const byId = new Map([[post._id, post]]);
        await loadThreadAbove(aid, byId, [post]);
        const chain = [...threadAbove(post, byId), post];
        alone = { id: conv, topic: await viewsOf(req.account, chain, { byId }), chat: [] };
      }
    }
    res.render("conversation", { state, wide: !!rail, rail, back: { href: likes.listing.path, label: "Your posts" }, ...conversationPage(req.account, { engine, alone, subject: postId }) });
  });

  // ── Live, the page side (docs/LIVE.md; services/livePush.js; public/js/live.js) ──
  // GET /live: Server-Sent Events for the signed-in account's open tab. Only its OWN rows (the hub keys by account),
  // each as `event: <type>` with what the page needs: the row's own data, the header balance as text, whether it's
  // live. `id:` is the row's id, so a reconnecting tab (EventSource sends Last-Event-ID) gets what it missed first.
  // A comment every 25 s keeps proxies from closing it (behind nginx: proxy_buffering off for /live). `?after=<id>`:
  // the same as Last-Event-ID, for a page back from the back/forward cache (public/js/live.js closes its stream when
  // you leave a page and reopens it there; a fresh EventSource sends no Last-Event-ID). The browser's own header wins.
  // The close handler is wired FIRST: a tab that leaves during the missed-rows lookup must still be let go (it was
  // wired after it, and such a stream stayed in the hub with its ping running).
  // `liveTabs`: every open one, so a restart can send each back to reconnect (app.closeLive, below).
  const liveTabs = new Set();
  // At most LIVE_TABS_MAX open streams per account per process (lib/inFlight.js): each is a socket held open, and a
  // script could open thousands. Far more tabs than a person keeps.
  const LIVE_TABS_MAX = 20;
  const liveSlots = inFlight(LIVE_TABS_MAX);
  app.get("/live", requireAccount, async (req, res) => {
    const account = req.account;
    const release = liveSlots.take(String(account._id));
    if (!release) return refuseBusy(req, res);
    let closed = false;
    let remove = () => {};
    let ping = null;
    // res, not req: the response's close is the connection going away (req's can mean only "the request was read").
    res.on("close", () => {
      closed = true;
      clearInterval(ping);
      remove();
      release();
      liveTabs.delete(res);
    });
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    liveTabs.add(res);
    const write = (type, data, id) => res.write(`${id ? `id: ${id}\n` : ""}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    let queue = Promise.resolve(); // in order, even when one needs a lookup (the balance)
    const send = (row) => {
      queue = queue
        .then(async () => {
          if (row.type === "status") return write("status", { live: !!row.data.live && isLiveFor(account), account: account._id });
          if (row.type === "balance") return write("balance", { text: await balanceText(account) }, row._id);
          return write(row.type, row.data || {}, row._id);
        })
        .catch((e) => console.error(`[live] sending to @${account.username}: ${e.message}`));
    };
    const last = req.get("last-event-id") || req.query.after;
    const resuming = /^[a-f0-9]{24}$/.test(last || "");
    // A tab's FIRST connect is told where its account's news stands (the status line carries the newest row's id), so
    // a reconnect after the page saw no news at all still asks for what came in between: a phone that sleeps the app
    // drops the stream, and on return (public/js/live.js `back`) the page reopens it from here.
    const newest = resuming ? null : await LiveEvent.findOne({ accountId: account._id }, { _id: 1 }).sort({ _id: -1 }).lean();
    if (closed) return;
    // `account`: whose stream this is. A tab drawn for another account (THE ACCOUNT SWITCHER: switched in another tab,
    // then this one reconnects, or comes back from the back/forward cache) reloads before anything else lands in it.
    write("status", { live: isLiveFor(account), account: account._id }, newest && newest._id);
    if (resuming) {
      for (const row of await LiveEvent.find({ accountId: account._id, _id: { $gt: String(last) } }).sort({ _id: 1 }).limit(100).lean()) send(row);
    }
    if (closed) return;
    remove = livePush.join(account._id, send); // its news, and the account is present (the mentions check)
    ping = setInterval(() => res.write(": ping\n\n"), 25000);
  });

  // One post's like line as the page draws it (partials/liked.hbs), for public/js/live.js to swap in when a like
  // arrives live: drawn with THIS account's likes only (likersByPost is per account) and the card's person (`person`,
  // whom the line names besides you). `back` is the page it'll sit on (the ↻ and the ♥ forms return there).
  app.get("/posts/:id/likes-line", requireAccount, async (req, res) => {
    const postId = String(req.params.id);
    // `person`: whom the line names besides you, one id or several (an Inbox card's writers), comma-separated.
    const named = String(req.query.person || "").split(",").filter((id) => /^\d+$/.test(id)).slice(0, 20);
    const aid = req.account._id;
    // As this account may see it (accountData.visibleTo): a private account's post it wasn't shown is a 404.
    const [post] = /^\d+$/.test(postId) ? await postsById(aid, [postId]) : [];
    if (!post) return res.status(404).end();
    const likers = await likersByPost(aid, [postId]);
    const shown = people.likeFaceIds(likers.get(postId) || [], aid);
    // `known`: each face opens their People page when they have one, as the page's own line did (liked.hbs who-av).
    const [profiles, known] = await Promise.all([profilesFor([aid, post.authorId, ...named, ...(likers.get(postId) || [])].filter(Boolean)), knownAmong(req.account, shown.filter((id) => id !== aid))]);
    const view = people.postView(post, { meId: aid, personId: named[0] || null, people: named.length > 1 ? named : null, profiles, likers, known, canLike: active(req.account, "liking") });
    res.locals.currentPath = safeBack(req.query.back, "/");
    res.render("likes-line", { layout: false, ...view });
  });

  // One post OF YOURS as the chat bubble a sent reply comes back as (views/reply-bubble.hbs, the reply route's own
  // render), for public/js/live.js to place under what it answers when you replied on X itself (a post's On X, or
  // just X's app): the post arrives live, and the Inbox shows it as if sent from here. Your own posts only.
  app.get("/posts/:id/bubble", requireAccount, async (req, res) => {
    const postId = String(req.params.id);
    const [post] = /^\d+$/.test(postId) ? await postsById(req.account._id, [postId]) : [];
    if (!post || post.authorId !== req.account._id) return res.status(404).end();
    const [view] = await viewsOf(req.account, [post]);
    res.locals.currentPath = safeBack(req.query.back, "/");
    res.render("reply-bubble", { layout: false, ...view, side: "me", runStart: true });
  });

  // A DRAFT your agent left on a message (models/Draft.js, services/agentTools.js draft_reply). GET: its line, THE
  // partial (views/draft-line.hbs), for public/js/post-actions.js to show when one arrives live (draft_reply only saves
  // one on a message that still owes a reply). POST discard: ✕ (in place, or back with a toast). Both look the draft up
  // by the signed-in account: never anyone else's.
  app.get("/drafts/:id", requireAccount, async (req, res) => {
    const postId = String(req.params.id);
    const d = /^\d+$/.test(postId) ? await Draft.findOne({ accountId: req.account._id, postId }, "text by at").lean() : null;
    if (!d) return res.status(404).end();
    res.locals.currentPath = safeBack(req.query.back, "/");
    res.render("draft-line", { layout: false, id: postId, draft: draftOf(postId, d) });
  });
  app.post("/drafts/:id/discard", requireAccount, async (req, res) => {
    const postId = String(req.params.id);
    if (/^\d+$/.test(postId)) await Draft.drop(req.account._id, postId);
    if (wantsJson(req)) return res.json({ ok: true });
    res.redirect(303, withNotice(backTo(req, postId), "draft-discarded"));
  });

  // The ♥ under someone else's post (a conversation, the Inbox; the Liking extra): like it on X (on=1) or unlike it
  // (on=0). The form says which way, so a double press can't toggle twice; one that matches what's recorded sends
  // nothing. From public/js/post-actions.js (JSON): { ok, liked, balance } or { ok: false, text, kind }, and the page
  // updates in place (no reload for a heart). Without script: back to the post, a failure as the toast.
  app.post("/posts/:id/like", requireAccount, async (req, res) => {
    const postId = String(req.params.id);
    const json = wantsJson(req);
    const on = req.body.on === "1";
    if (!/^\d+$/.test(postId) || !active(req.account, "liking")) return json ? res.status(400).json({ ok: false, ...noticeFor("x-failed") }) : res.redirect(303, backTo(req));
    try {
      // "same": it already was what was asked (a double press), so `on` is the truth; "missing": nothing to like;
      // "gone": deleted on X (extras.goneCheck marked it), so it owes nothing any more: the count moves.
      const r = await setLike({ ...syncSettings(req.account._id), postId, on });
      if (r === "gone") refreshOwedSafely(req.account._id);
      // `gone`: the page takes the post away (post-actions.js goneFromPage), as a reload no longer draws it.
      if (r === "missing" || r === "gone") return json ? res.status(404).json({ ok: false, gone: true, ...noticeFor("reply-gone") }) : res.redirect(303, withNotice(backTo(req, postId), "reply-gone"));
      // The Inbox's count of likes owed moves; not awaited (its push reaches the open tabs, services/inboxCount.js).
      refreshOwedSafely(req.account._id);
      // `likes`: X's like allowance after this press (the bulk ♥s' N). No recount: the page moved every number when
      // pressed (THE OWED TABLE), and this answer only confirms it.
      if (!json) return res.redirect(303, backTo(req, postId));
      const [likes, balance] = await Promise.all([likeAllowance(req.account, res.locals.timeZone), balanceText(req.account)]);
      return res.json({ ok: true, liked: on, likes, balance });
    } catch (err) {
      const n = xFailure(err, `[like] ${postId} for @${req.account.username}`);
      return json ? refusedJson(res, n, err) : res.redirect(303, withNotice(backTo(req, postId), n));
    }
  });

  // THE ↻ under someone else's post (a conversation, the Inbox; the Reposting add-on): repost it on X (on=1, after THE
  // click-again confirm: it goes out to everyone who follows you) or undo it (on=0, one click). The ♥'s rules: the form
  // says which way, a press matching what's recorded sends nothing. From public/js/post-actions.js (JSON): { ok,
  // reposted, balance } or { ok: false, text, kind }; without script, back to the post.
  app.post("/posts/:id/repost", requireAccount, async (req, res) => {
    const postId = String(req.params.id);
    const json = wantsJson(req);
    const on = req.body.on === "1";
    if (!/^\d+$/.test(postId) || !active(req.account, "reposting")) return json ? res.status(400).json({ ok: false, ...noticeFor("x-failed") }) : res.redirect(303, backTo(req));
    try {
      const r = await setRepost({ ...syncSettings(req.account._id), postId, on });
      if (r === "gone") refreshOwedSafely(req.account._id);
      if (r === "missing" || r === "gone") return json ? res.status(404).json({ ok: false, gone: true, ...noticeFor("reply-gone") }) : res.redirect(303, withNotice(backTo(req, postId), "reply-gone"));
      return json ? res.json({ ok: true, reposted: on, balance: await balanceText(req.account) }) : res.redirect(303, backTo(req, postId));
    } catch (err) {
      const n = xFailure(err, `[repost] ${postId} for @${req.account.username}`);
      return json ? refusedJson(res, n, err) : res.redirect(303, withNotice(backTo(req, postId), n));
    }
  });

  // The reply box (the Inbox, a conversation; the Replying extra): post the text on X as a reply to post :id. Without
  // script, back to the page with a toast; from public/js/post-actions.js, JSON with your new post as a chat bubble (the
  // pages' own partial, views/reply-bubble.hbs) and the header's balance.
  // A reply's pictures (lib/media.js): a multipart body, only from the reply box's script (the CSRF token comes in its
  // x-csrf-token header: the global check runs before this parses the body), held in MEMORY, never on disk, for as long
  // as it takes to pass them to X (X hosts them; xtoolio keeps nothing). Hard limits here, the exact rules after.
  const replyUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MEDIA_MAX_BYTES, files: MEDIA_LIMITS.photos, fields: 8, fieldSize: 64 * 1024, parts: 16 },
  }).array("media", MEDIA_LIMITS.photos);
  // The whole request, refused by its declared size BEFORE anything is held: the most a reply carries (four photos or
  // one video, MEDIA_MAX_BYTES) and room for its fields. Each file's own limit alone let four 20 MB parts be held at
  // once on a copy without nginx's 25 MB in front. A multipart body with no declared size is refused too.
  const MAX_REPLY_BYTES = Math.max(MEDIA_MAX_BYTES, MEDIA_LIMITS.photos * MEDIA_LIMITS.photoBytes) + 1024 * 1024;
  const receiveMedia = (req, res, next) => {
    const size = Number(req.headers["content-length"]);
    if (req.is("multipart/form-data") && !(size > 0 && size <= MAX_REPLY_BYTES)) {
      req.mediaRefused = "media-big";
      return next();
    }
    replyUpload(req, res, (err) => {
      if (err) req.mediaRefused = err.code === "LIMIT_FILE_SIZE" ? "media-big" : err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE" ? "media-many" : "x-failed";
      next();
    });
  };

  // Who may reply, decided BEFORE multer holds up to MAX_REPLY_BYTES of pictures in memory for someone who can't. (A multipart
  // body isn't parsed yet here, so there's no `back`: refused without script lands home.)
  const mayReply = (req, res, next) =>
    /^\d+$/.test(String(req.params.id)) && active(req.account, "replying") ? next() : wantsJson(req) ? res.status(400).json({ ok: false, ...noticeFor("x-failed") }) : res.redirect(303, req.body ? backTo(req) : "/");

  // Two replies at once per account, at most (lib/inFlight.js): each may hold MAX_REPLY_BYTES in memory until X has it.
  const oneUploadAtATime = inFlightMiddleware(2, refuseBusy);
  app.post("/posts/:id/reply", requireAccount, mayReply, oneUploadAtATime, receiveMedia, async (req, res) => {
    const postId = String(req.params.id);
    const json = wantsJson(req);
    const text = String((req.body && req.body.text) || "").trim();
    const say = (n, status = 400) => (json ? res.status(status).json({ ok: false, ...noticeFor(n) }) : res.redirect(303, withNotice(backTo(req, postId), n)));
    if (req.mediaRefused) return say(req.mediaRefused);
    // Picked from your media (the 📎 panel): fetched from X's own copies, your own posts' only, no more than the reply
    // has room for beside what was uploaded with it.
    const keys = [].concat((req.body && req.body.library) || []);
    if (keys.length && !active(req.account, "pictures")) return say("media-regrant");
    let picked;
    try {
      picked = await mediaLibrary.fetchPicked(req.account._id, keys, MEDIA_LIMITS.photos - (req.files || []).length);
    } catch (err) {
      console.error(`[reply] picked media for @${req.account.username}: ${err.message}`);
      return say(err.notice || "media-gone");
    }
    const pictures = checkAttachments([...(req.files || []), ...picked]);
    if (!pictures.ok) return say(pictures.notice);
    if (pictures.items.length && !active(req.account, "pictures")) return say("media-regrant");
    if (!text && !pictures.items.length) return say("reply-empty");
    if (text.length > REPLY_MAX) return say("reply-long");
    try {
      const post = await sendReply({ ...syncSettings(req.account._id), postId, text, media: pictures.items });
      refreshOwedSafely(req.account._id); // the Inbox's count of replies owed (not awaited; its push reaches the tabs)
      await Draft.drop(req.account._id, postId); // a draft your agent left on it is spent (models/Draft.js)
      if (!json) return res.redirect(303, withNotice(backTo(req, post._id), "replied"));
      const [view] = await viewsOf(req.account, [post]);
      res.render("reply-bubble", { layout: false, ...view, side: "me", runStart: true }, async (err, html) => {
        if (err) return res.status(500).json({ ok: false, ...noticeFor("x-failed") });
        res.json({ ok: true, id: post._id, html, balance: await balanceText(req.account) });
      });
    } catch (err) {
      if (err.code === "NO_POST") {
        refreshOwedSafely(req.account._id); // deleted on X since: it owes nothing now (extras.goneCheck)
        // `gone`: the page takes the post away with a red note (post-actions.js goneFromPage), its box with it.
        return json ? res.status(404).json({ ok: false, gone: true, ...noticeFor("reply-gone") }) : say("reply-gone");
      }
      const n = xFailure(err, `[reply] to ${postId} for @${req.account.username}`);
      return json ? refusedJson(res, n, err) : res.redirect(303, withNotice(backTo(req, postId), n));
    }
  });

  // YOUR MEDIA (services/mediaLibrary.js) for the reply box's 📎 panel (public/js/attach.js): the panel's grid, drawn by
  // the server's own partial (views/media-library.hbs), fetched once per page when the panel first opens.
  app.get("/media/library", requireAccount, async (req, res) => {
    if (!active(req.account, "pictures")) return res.status(404).end();
    res.render("media-library", { layout: false, items: await mediaLibrary.libraryFor(req.account._id) });
  });
  // Pin (on=1) or unpin a picture of yours: it stays at the top of the 📎 panel and in the Media page's Pinned tab.
  // Your own posts' only (mediaLibrary.pin), no X permission needed (it's just order). JSON from public/js/attach.js;
  // without script (the Media page's forms) back to the page. Repeat-safe.
  app.post("/media/pins", requireAccount, async (req, res) => {
    const ok = await mediaLibrary.pin(req.account._id, req.body.key, req.body.on === "1");
    if (wantsJson(req)) return res.status(ok ? 200 : 400).json({ ok: !!ok, pinned: req.body.on === "1" });
    res.redirect(303, safeBack(req.body.back, mediaLibrary.PAGE));
  });

  // SAVE someone else's photo or GIF to your media (on=1), or remove it (on=0): the "+ Save" on a picture in a post
  // (partials/media.hbs) and the Media page's ✕ (mediaLibrary.save: only a picture you were shown, in someone else's
  // post, that could go in a reply). No X permission needed, nothing read from X: a reference on the account. JSON from
  // public/js/post-actions.js (the button flips in place); without script, back with a toast. Repeat-safe.
  app.post("/media/saved", requireAccount, async (req, res) => {
    const on = req.body.on === "1";
    const ok = (isOn(req.account, "inbox") || isOn(req.account, "people")) && (await mediaLibrary.save(req.account._id, req.body.key, req.body.postId, on));
    const n = !ok ? "media-cant-save" : on ? "media-saved" : "media-unsaved";
    if (wantsJson(req)) return res.status(ok ? 200 : 400).json({ ok: !!ok, saved: on, ...noticeFor(n) });
    res.redirect(303, withNotice(safeBack(req.body.back, mediaLibrary.PAGE), n));
  });

  // REMOVE one of your own pictures from your media (on=1), or put it back (on=0): the Media page's ✕ on your own
  // (mediaLibrary.hide; a saved one's ✕ is /media/saved on=0). Your own posts' pictures only, no X permission needed,
  // nothing sent to X: the post stays there. JSON from public/js/post-actions.js (the tile goes at once, its toast has
  // Undo); without script, back with a toast. Repeat-safe.
  app.post("/media/hidden", requireAccount, async (req, res) => {
    const on = req.body.on === "1";
    const ok = await mediaLibrary.hide(req.account._id, req.body.key, on);
    const n = !ok ? "media-cant-remove" : on ? "media-removed" : "media-restored";
    if (wantsJson(req)) return res.status(ok ? 200 : 400).json({ ok: !!ok, hidden: on, ...noticeFor(n) });
    res.redirect(303, withNotice(safeBack(req.body.back, mediaLibrary.PAGE), n));
  });

  // THE MEDIA PAGE (views/media.hbs, services/mediaLibrary.js): every photo, GIF and video you've posted, and what you
  // saved from others. There whenever your own posts are read (the Inbox or People).
  app.get(mediaLibrary.PAGE, requireAccount, async (req, res) => {
    if (!isOn(req.account, "inbox") && !isOn(req.account, "people")) return res.redirect(303, "/");
    if (await mediaLibrary.seen(req.account)) clearing(res, "media"); // the sidebar's Media count: seen
    const L = mediaLibrary.listing;
    const rows = await mediaLibrary.mediaRows(req.account._id);
    const list = L.listRows(rows, { ...L.parseQuery(req.query), q: "", dir: "desc" }); // newest first, no search
    const n = (v) => L.listRows(rows, { ...list, show: v, page: 1 }).matched;
    const tabs = [["all", "All"], ["photo", "Photos"], ["gif", "GIFs"], ["video", "Videos"], ["pinned", "Pinned"], ["saved", "Saved"]]
      .map(([key, label]) => ({ key, label, n: n(key), href: L.hrefFor(list, { show: key, page: 1 }), on: list.show === key }))
      .filter((t) => t.n || t.on || t.key === "all");
    res.render("media", {
      state: await SyncState.findById(req.account._id, "lastRunAt").lean(), // the header's "● Live" / "Synced …" and ↻, as on every page
      wide: true, list, tabs, pager: L.pager(list),
    });
  });

  // The "how far back?" answer (People's, the first time it's on). Only a key from the options this account was shown
  // is accepted (the budget is recomputed here, never taken from the form), and only once. The worker starts the pull
  // within seconds (features.pullDue; runSync sizes it to the whole budget: runReadCap); People's page shows its
  // progress. It's the biggest unit an account ever runs, so its balance must cover the option's price first
  // (billing.affords), not just be above zero: the plain gate would let one press run it deep into the red.
  app.post("/history", requireAccount, async (req, res) => {
    const back = listing.people.path;
    if (!isOn(req.account, "people") || (req.account.history && req.account.history.budget)) return res.redirect(303, back);
    const choice = (await historyChoices(req.account)).find((o) => o.key === req.body.key);
    if (!choice || !choice.affordable) return res.redirect(303, withNotice(back, "bulk-short"));
    // The pull itself runs in the worker (services/scheduler.js), never here: it can take 20 minutes, and many
    // signups at once would run in the process serving pages.
    await reconcileLikes(req.account._id);
    await Account.updateOne({ _id: req.account._id, "history.budget": { $exists: false } }, { $set: { history: { budget: choice.budget, chosenAt: new Date() }, "live.due": true } });
    res.redirect(303, back);
  });

  // A first read with People RECONCILES your likes to its history before the Inbox opens (SyncState.likes.reconciled
  // false: features.firstReadGoing holds the pages, services/extras.js runLikes reads them back to the history's start).
  // Only when the look back still has somewhere to go: one already done would never mark it, and hold the Inbox forever.
  async function reconcileLikes(accountId) {
    const state = await SyncState.findById(accountId, "likes.backfillDone").lean();
    if (state && state.likes && state.likes.backfillDone) return;
    await SyncState.updateOne({ _id: accountId }, { $set: { "likes.reconciled": false } }, { upsert: true });
  }

  // THE FIRST READ's progress block alone (views/pull-progress.hbs, routes/pages.js pullView), for the progress page to
  // swap in when the worker says it moved (public/js/live.js); 204 once the first read is done, likes reconciled
  // included (features.firstReadGoing), so the page goes on.
  app.get("/pull/progress", requireAccount, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const state = (await SyncState.findById(req.account._id, PULL_STATE).lean()) || {};
    if (!firstReadGoing(req.account, state)) return res.status(204).end();
    res.render("pull-progress", { layout: false, ...(await pullView(req.account, state)) });
  });

  // GET STARTED (the start page, routes/pages.js startView): EVERY module on, and how far back to read, in
  // ONE write. Only while no module is on (afterwards, Settings changes them), only with every module granted (the
  // page links to X otherwise), a paying account with money in, and an option from this account's own list that its
  // balance covers (the budget is recomputed here, never taken from the form). The worker starts the first read within
  // seconds (features.pullDue).
  // THE START PAGE at its own address (routes/pages.js START_PAGE): home draws it too, but a LIKESTORM ONLY account's
  // home is the Likestorm page, and this is where its sidebar's faded modules lead. Started: home.
  app.get(START_PAGE, requireAccount, async (req, res) => {
    if (modulesOn(req.account).length) return res.redirect(303, "/");
    res.render("start", await startView(req));
  });

  app.post("/start", requireAccount, async (req, res) => {
    if (modulesOn(req.account).length) return res.redirect(303, "/");
    if (MODULES.some((k) => !granted(req.account, k))) return res.redirect(303, START_PAGE);
    if (billing.paused(req.account)) return res.redirect(303, withNotice(START_PAGE, "out-of-balance"));
    const choice = (await historyChoices(req.account)).find((o) => o.key === req.body.key);
    if (!choice || !choice.affordable) return res.redirect(303, withNotice(START_PAGE, "bulk-short"));
    const update = turnOn(MODULES);
    update.$set.history = { budget: choice.budget, chosenAt: new Date() };
    update.$set.inboxFrom = { want: inboxStart.FIRST_REPLIES }; // the Inbox opens with the newest 20 (services/inboxStart.js)
    await reconcileLikes(req.account._id); // before the modules: the worker may start the read the moment they're on
    await Account.updateOne({ _id: req.account._id }, update);
    res.redirect(303, "/");
  });

  // LIKESTORMS ONLY (the start page's way out, services/features.js FEATURES.likestorm): just the likestorm switch, no
  // module, no history read, nothing that syncs; money is asked for on the Likestorm page itself (its first top-up the
  // smaller STORM_DEPOSIT_USD), which is home from now on. Only before anything is on, with X's likes granted.
  app.post("/start/storm", requireAccount, async (req, res) => {
    if (modulesOn(req.account).length || stormOnly(req.account)) return res.redirect(303, "/");
    if (!granted(req.account, "likestorm")) return res.redirect(303, START_PAGE);
    await Account.updateOne({ _id: req.account._id }, turnOn("likestorm"));
    res.redirect(303, withNotice(STORM_PAGE, "storm-ready"));
  });

  // Theme (lib/theme.js). Signed in: the menu's Theme item cycles light → dark → auto on the account. Signed out: the
  // front page's sun / moon flips light ↔ dark. Either way the cookie follows (light / dark only; auto clears it), so
  // the front page matches after signing out. Back to the same page.
  app.post("/theme", async (req, res) => {
    const now = themeFor(req);
    const next = req.account ? theme.THEMES[(theme.THEMES.indexOf(now) + 1) % theme.THEMES.length] : now === "light" ? "dark" : "light";
    if (req.account) await Account.updateOne({ _id: req.account._id }, { $set: { theme: next } });
    if (next === "auto") res.clearCookie(theme.COOKIE, { path: "/" });
    else res.cookie(theme.COOKIE, next, { httpOnly: true, sameSite: "lax", secure: req.secure, path: "/", maxAge: theme.COOKIE_MAX_AGE_MS });
    res.redirect(303, safeBack(req.body.back, "/"));
  });

  // The sidebar folded to its icons or open (collapsed=1|0: the form says which way, so a double press can't toggle
  // twice), kept per account like the theme. public/js/nav.js folds it at once and sends this in the background (204);
  // without script, back to the same page.
  app.post("/nav", requireAccount, async (req, res) => {
    await Account.updateOne({ _id: req.account._id }, { $set: { navCollapsed: req.body.collapsed === "1" } });
    if (wantsJson(req)) return res.status(204).end();
    res.redirect(303, safeBack(req.body.back, "/"));
  });

  // Font: only a key from lib/fonts.js is accepted.
  app.post("/font", requireAccount, async (req, res) => {
    const ok = FONTS.some((f) => f.key === req.body.font);
    if (ok) await Account.updateOne({ _id: req.account._id }, { $set: { font: req.body.font } });
    res.redirect(303, ok ? "/settings?n=saved" : "/settings");
  });

  // Accent: only a key from lib/accents.js is accepted (Settings' swatches save on change; the page redraws in it).
  app.post("/accent", requireAccount, async (req, res) => {
    const ok = ACCENTS.some((a) => a.key === req.body.accent);
    if (ok) await Account.updateOne({ _id: req.account._id }, { $set: { accent: req.body.accent } });
    res.redirect(303, ok ? "/settings?n=saved" : "/settings");
  });

  // Time zone: only a zone lib/timezone.js knows is accepted (canonicalized there).
  app.post("/timezone", requireAccount, async (req, res) => {
    const tz = zoneFor(req.body.tz);
    if (tz) await Account.updateOne({ _id: req.account._id }, { $set: { timeZone: tz } });
    res.redirect(303, tz ? "/settings?n=tz" : "/settings");
  });

  // ── The Usage page (/usage, views/usage.hbs): the balance and this month in one line, THE CHART (services/spendChart.js:
  // money per day, week or month; today's, this week's and this month's figures sit above its bars, where the table's
  // day lines used to be), then every unit in one table, newest first, a page at a time: the next loads as the table's foot nears the
  // screen (public/js/usage.js → GET /usage/rows, drawn by the page's own partial), or by "Older" without script.
  // ONE shape for both readers:
  //   the owner (or anyone while billing is off): the usage ledger (services/usage.js usageSummary / usageRows). The
  //     owner's money is X's: X's balance, each run's cost at X's prices (every account's runs: one X balance), X's
  //     balance just after it (the clock's reading), the credit added on X, and each day's REAL spend (the chart). No
  //     billing (Admin → P&L has it). Anyone else: their own runs at X's prices, and no balance.
  //   an account that pays: its statement (services/billing.js statement / statementDays): what it was CHARGED, never
  //     X's cost, with its balance after each line.
  // Money is micro-dollars throughout (the `money` helper). What each run read: usage.describeReads.
  const micros = toMicros; // THE dollars → micro-dollars (services/balance.js)
  const USAGE_PAGE_ROWS = 30;

  // The first row of each day other than today says its day in the When cell ("Yesterday", or the short date); `prevAt`: the
  // time of the row above this page (the cursor's), so a page that continues a day doesn't repeat it.
  function markDays(rows, dayOf, prevAt) {
    const today = dayOf(new Date());
    const yesterday = dayOf(new Date(Date.now() - 24 * 3600 * 1000));
    let prev = prevAt ? dayOf(prevAt) : today;
    for (const r of rows) {
      const day = dayOf(r.at);
      if (day !== prev) Object.assign(r, { newDay: true, yesterday: day === yesterday });
      prev = day;
    }
    return rows;
  }

  // A page of the table: { rows, next, cols: { balance, atPrices } }. THREE VIEWS, one table:
  //   • a paying account: its STATEMENT, what each run was charged and its balance after;
  //   • the OWNER (hosted or self-hosted alike): THE X BALANCE RECONCILED, every run that spent it (every account's:
  //     they all spend the one X balance; another account's tagged "· @them") at X's raw price, and X's real balance
  //     after. NO BILLING in it at all (X's money and what accounts paid are never mixed in one view): what
  //     accounts were charged is Admin → P&L (routes/admin.js), never here;
  //   • anyone else (billing off): its own runs at X's prices.
  async function ledgerPage(account, timeZone, before) {
    const dayOf = dayIn(timeZone);
    const prevAt = cursorTime(before);
    if (paysHere(account)) {
      const s = await billing.statement(account._id, { before, limit: USAGE_PAGE_ROWS });
      const WHAT = { topup: "Top-up", "auto-refill": "Auto-refill", credit: "Credit", refund: "Refund" };
      const rows = s.rows.map((r) => ({
        at: r.at,
        what: r.kind === "run" ? r.label || "Sync" : ((r.kind === "credit" || r.kind === "refund") && r.label) || WHAT[r.kind],
        reads: r.reads, // null for money in
        micros: Math.abs(r.micros),
        credit: r.micros > 0,
        balanceAfter: r.balanceAfter,
        receiptUrl: r.receiptUrl,
      }));
      return { rows: markDays(rows, dayOf, prevAt), next: s.next, cols: { balance: true } };
    }

    const owner = isOwner(account._id);
    const data = await usageRows({ accountId: account._id, owner, before, limit: USAGE_PAGE_ROWS });
    const names = owner
      ? new Map((await Account.find({ _id: { $in: [...new Set(data.entries.map((e) => e.accountId).filter(Boolean))] } }, "username").lean()).map((a) => [a._id, a.username]))
      : new Map();
    const rows = data.entries
      .map((e) => ({
        at: e.startedAt,
        what: owner && e.accountId && e.accountId !== account._id ? `${e.label} · @${names.get(e.accountId) || e.accountId}` : e.label,
        reads: e.reads,
        running: e.running,
        // Open but not beating: its process died (the next unit's sweep closes it).
        failed: e.status === "failed" || (e.status === "open" && !e.running),
        error: e.status === "open" ? "Didn't finish (the app restarted or crashed)" : e.error,
        // At X's prices: exactly what X returned to this run, priced from X's list (not a guess, so no "~":
        // a charge is never called approximate). The owner's Balance beside it is X's real money.
        micros: micros(e.estUsd),
        balanceAfter: e.after ? micros(e.after.usd) : null,
        balanceAt: e.after ? e.after.at : null,
      }))
      .concat(data.credits.map((c) => ({ at: c.at, what: "Credit added on X", micros: micros(c.usd), credit: true, balanceAfter: micros(c.balanceUsd), balanceAt: c.at })))
      .sort((a, b) => new Date(b.at) - new Date(a.at));
    return { rows: markDays(rows, dayOf, prevAt), next: data.next, cols: { balance: owner, atPrices: !owner } };
  }

  async function usageView(account, timeZone, before) {
    const dayOf = dayIn(timeZone);
    const today = dayOf(new Date());
    const thisMonth = today.slice(0, 7);
    const monthName = new Date(`${thisMonth}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
    const since = chartSince(today);
    const ledger = await ledgerPage(account, timeZone, before);

    if (paysHere(account)) {
      const days = await billing.statementDays(account._id, { timeZone, since });
      return {
        ...ledger,
        balance: { label: "Balance", micros: account.balanceMicros || 0 },
        month: { micros: days.filter((d) => d.day.startsWith(thisMonth)).reduce((n, d) => n + d.charged, 0), name: monthName },
        topUp: true,
        chart: spendChart(days.map((d) => ({ day: d.day, micros: d.charged })), today),
        note: "What each sync was charged. One that found nothing new costs nothing and isn't listed.",
      };
    }

    const owner = isOwner(account._id);
    const s = await usageSummary({ accountId: account._id, owner, timeZone, since });
    // The owner's days are X's real spend where the clock was reading (else the sum at X's prices, marked "~": a day
    // before the clock ran, the one place a figure stands in for X's real one); anyone else's are at X's prices
    // throughout, said once in the note.
    const exact = (d) => owner && d.real !== null;
    const month = s.days.filter((d) => d.day.startsWith(thisMonth));
    const monthReal = owner && month.every(exact);
    return {
      ...ledger,
      balance: owner && s.balance ? { label: "Balance", micros: micros(s.balance.usd), at: s.balance.at } : null,
      // This month: X's real spend when every day of it has readings, else the estimate. Tracking began with the
      // ledger: say so while that's within the month, or the month reads as complete.
      month: {
        micros: micros(month.reduce((n, d) => n + (monthReal ? d.real : d.est), 0)),
        estimated: owner && !monthReal,
        name: monthName,
        since: s.since && dayOf(s.since).startsWith(thisMonth) && s.since > new Date(`${thisMonth}-01T00:00:00Z`) ? s.since : null,
        handover: s.handover,
      },
      chart: spendChart(s.days.map((d) => ({ day: d.day, micros: micros(exact(d) ? d.real : d.est), estimated: owner && !exact(d) })), today),
      note: owner ? "Every account's runs spend this one X balance. Each cost is X's price for what that run read or did; the chart and the balances are X's real figures, read once a minute. A run that cost nothing isn't listed." : "Each cost is at X's prices: what X returned to that run, priced from X's list. A run that cost nothing isn't listed.",
    };
  }

  app.get("/usage", requireAccount, async (req, res) => {
    res.render("usage", {
      state: await SyncState.findById(req.account._id, "lastRunAt").lean(),
      usage: await usageView(req.account, res.locals.timeZone, req.query.before),
    });
  });

  // The table's next page (public/js/usage.js, as its foot nears the screen): the rows, drawn by the page's own
  // partial (views/usage-rows.hbs), and the cursor after them (null at the end).
  app.get("/usage/rows", requireAccount, async (req, res) => {
    const view = await ledgerPage(req.account, res.locals.timeZone, req.query.before);
    res.render("usage-rows", { layout: false, ...view }, (err, html) => (err ? res.status(500).json({ ok: false }) : res.json({ ok: true, html, next: view.next })));
  });

  // RECEIPTS (Settings → Billing → Balance's "Receipts"): a page of its own, each payment newest first with Stripe's
  // own receipt (billing.receiptsFor). Only an account that pays here; anyone else back to Settings.
  app.get("/settings/receipts", requireAccount, async (req, res) => {
    if (!(await fundsView(req.account))) return res.redirect("/settings");
    res.render("receipts", { pageTitle: "Receipts", receipts: await billing.receiptsFor(req.account._id) });
  });

  // An account that signed in before every scope was asked for (or revoked one on X): its next sign-in asks for all.
  const regrant = (account) => Object.keys(FEATURES).some((k) => !granted(account, k));

  app.get("/settings", requireAccount, async (req, res) => {
    // An account that pays sees Billing (its balance, top-ups). What things cost is the Usage page.
    const funds = await fundsView(req.account);
    const refill = funds && funds.payable ? autoRefill.view(req.account) : null;
    if (refill) {
      refill.toggle = !refill.enabled && !refill.card
        ? { on: false, label: "Auto-refill", link: "/billing/card?enable=1&back=/settings%23billing" }
        : { on: refill.enabled, label: "Auto-refill", action: "/billing/autorefill", field: { name: "on", value: refill.enabled ? "0" : "1" } };
    }

    res.render("settings", {
      state: await SyncState.findById(req.account._id, "lastRunAt").lean(), // the header's "synced … ago", as on every page
      // What you use: THE module picker, priced by THE estimate (accountEstimate), its switches saving to this account
      // (`picker`: views/partials/module-picker.hbs). Prices where they mean something: billing on, or the app's owner.
      cost: await accountEstimate(req.account, req.query),
      priced: billing.enabled || isOwner(req.account._id),
      // Always called an estimate, the front page's own words, and it
      // links to what was really spent (`usage`).
      // `remeasure`: the Re-estimate button (POST /estimate, its form in views/settings.hbs).
      picker: { action: "/settings#estimate", title: "Cost estimation", saves: true, usage: "/usage", remeasure: true },
      regrant: regrant(req.account),
      fonts: FONTS.map((f) => ({ ...f, current: f.key === res.locals.font.key, isDefault: f.key === DEFAULT_FONT })),
      accents: ACCENTS.map((a) => ({ key: a.key, name: a.name, current: a.key === res.locals.accent.key, isDefault: a.key === DEFAULT_ACCENT })),
      // Unset: the dropdown offers this device's zone (public/js/timezone.js preselects it); "Use this" saves it.
      zone: { set: !!req.account.timeZone, options: ZONES.map((z) => ({ value: z, label: z.replace(/_/g, " "), current: z === res.locals.timeZone })) },
      funds,
      refill,
      // Stripe's receipt for each payment (Billing → Receipts, THE modal): top-ups and auto-refills.
      hasReceipts: !!funds && (await billing.receiptsFor(req.account._id, 1)).length > 0, // Balance's link to its page
      // Agents (routes/agents.js): while the Inbox or People is on (the data an agent reads), and ALWAYS while any
      // connection exists: a token or an approved app stays live with both off (its tools answer "off"), so its
      // Disconnect must stay reachable.
      agents: await (async () => {
        const list = await connectionsFor(req.account._id);
        return isOn(req.account, "inbox") || isOn(req.account, "people") || list.length ? { url: agentOAuth.RESOURCE, list } : null;
      })(),
      // THE INVITE LINK (services/invites.js): while sign-up is closed. null otherwise.
      invites: await invites.viewFor(req.account),
      // THE PAUSE's switch (routes/pause.js): on while reading runs; off since `pause.at` (by you, or the balance).
      syncing: modulesOn(req.account).length ? syncingSwitch(req.account) : null,
      keepLive: modulesOn(req.account).length ? keepLiveSwitch(req.account, "/settings") : null, // services/away.js
      // THE INBOX'S WINDOW (routes/inbox.js /inbox/within), the Inbox toolbar's choice as a switch: a phone's way to it.
      inboxDay: isOn(req.account, "inbox") ? { toggle: dayToggle(req.account.inboxWithin === "1d") } : null,
      deletable: !isOwner(req.account._id), // Delete account (routes/account.js); the owner pays X and is never deleted here
    });
  });

  // Settings' "Inbox: last 24 hours only": pressing it sets the window or clears it, back to Settings.
  const dayToggle = (on) => ({ on, label: "Inbox: last 24 hours only", action: "/inbox/within", field: { name: "within", value: on ? "" : "1d" }, back: "/settings" });

  // Settings' Syncing switch: on while nothing holds it; pressing it pauses (pause=1) or resumes (pause=0).
  const syncingSwitch = (account) => {
    const on = !(account.pause && account.pause.at);
    return { on, since: on ? null : account.pause.at, away: !on && account.pause.why === "away", toggle: { on, label: "Syncing", action: "/pause", field: { name: "pause", value: on ? "1" : "0" } } };
  };

  // Settings' Re-estimate (a measure is kept a week, and this refreshes it): this account's own handle measured now (services/estimator.js remeasure: at most once an hour; the
  // platform's ~3 cents, never the account's balance), back to the estimate with a toast.
  app.post("/estimate", requireAccount, async (req, res) => {
    let n = "estimate-updated";
    try {
      const r = await estimator.remeasure(req.account.username, { token: config.x.bearerToken });
      if (r.tooSoon) n = "estimate-recent";
      else if (r.error) n = "x-failed";
    } catch (err) {
      n = xFailure(err, `[estimate] re-estimating @${req.account.username}`);
    }
    res.redirect(303, withNotice("/settings#estimate", n));
  });

  // A module's switch (Settings, a module's off page): on=1 turns it on, anything else off. Every scope was granted at
  // sign-in (services/features.js), so this never leaves the site. Either way `live.due`: it can change what X pushes
  // (Likes → like events). People turned on lands on its own page, which asks how far back to read the first time. Off:
  // never the last module (decision 3: at least one; with none there's nothing to sync or show).
  app.post("/modules/:key", requireAccount, async (req, res) => {
    const key = req.params.key;
    // Back to the picker, not Settings' top; or to the module's own page, whose title row has its switch too.
    const back = safeBack(req.body.back, "/settings#estimate");
    if (!MODULES.includes(key)) return res.redirect(303, back);
    // Before Get started, the start page turns them ALL on, with the history and the Inbox's start (POST /start);
    // Settings draws them on and locked meanwhile (estimateView accountEstimate `beforeStart`). One turned on here would
    // skip the start page (a LIKESTORM ONLY account's too: it has no home there).
    if (!modulesOn(req.account).length) return res.redirect(303, START_PAGE);
    if (req.body.on === "1") {
      if (!isOn(req.account, key)) await Account.updateOne({ _id: req.account._id }, turnOn(key));
      return res.redirect(303, key === "people" && !(req.account.history && req.account.history.budget) ? listing.people.path : withNotice(back, "on"));
    }
    if (modulesOn(req.account).every((k) => k === key)) return res.redirect(303, withNotice(back, "last-module"));
    await Account.updateOne({ _id: req.account._id }, { $set: { [`features.${key}.on`]: false, "live.due": true } });
    res.redirect(303, withNotice(back, "off"));
  });

  // ── Money in (services/billing.js) ──

  // A top-up is a LINK, not a form: it ends on Stripe's Checkout, and form-action 'self' blocks a form whose redirect
  // leaves the site. A GET is fine here: it only opens a payment page, and no money moves until the person pays.
  // Only an amount this account may pick (billing.amountsFor: the deposit first) is accepted, never a number from
  // the browser as such; at most 10 Checkouts per account per 10 minutes.
  const topupLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => `topup:${req.account._id}` });
  app.get("/billing/topup", requireAccount, topupLimiter, async (req, res) => {
    const back = safeBack(req.query.back, "/settings");
    if (!config.billing.payable || isOwner(req.account._id)) return res.redirect(303, back);
    const usd = Number(req.query.amount);
    // The usual amounts, or the one top-up that covers a bulk choice on screen (pricedChoices): a "how far back?" choice
    // (the start page, before any module is on; or People on, its history not chosen), or the reconciler's read
    // (Follows on), or how far back to resume (paused: resumeChoices). Without the start page's case, its "Add $30 for
    // this" bounced back unpaid.
    const choosing = !modulesOn(req.account).length || (isOn(req.account, "people") && !(req.account.history && req.account.history.budget));
    const bulk = [
      ...(choosing ? await historyChoices(req.account) : []),
      ...(choosing ? [] : await furtherChoices(req.account, await SyncState.findById(req.account._id, FURTHER_STATE).lean())), // Your circle's "read further back"
      ...(await resumeChoices(req.account)),
      ...(active(req.account, "follows") ? [...(await followingChoices(req.account)), ...(await tagsChoices(req.account))] : []),
    ];
    // This account's amounts (fundsView: a LIKESTORM ONLY account's first one smaller) and the full app's (the start
    // page offers those to it too, for the rest of the app).
    const offered = [...(await fundsView(req.account)).amounts, ...billing.amountsFor(await billing.hasPaid(req.account._id)), ...bulk.map((o) => o.topup).filter(Boolean)];
    if (!offered.includes(usd)) return res.redirect(303, back);
    try {
      res.redirect(303, await billing.createTopUpSession(req.account, usd, { back }));
    } catch (err) {
      console.error(`[billing] checkout for @${req.account.username} failed: ${err.message}`);
      res.redirect(303, withNotice(back, "payfail"));
    }
  });

  // Back from Stripe. Settle the payment now (the person is waiting; the webhook is the belt, whichever lands first
  // credits). Only a session minted for THIS account settles here: a pasted id from another does nothing. A paused
  // account that chose its history resumes syncing right away rather than at the next pass.
  // A card for auto-refill: a setup-mode Checkout, so also a LINK (Settings' "Turn on" with no card yet: enable=1,
  // switched on once the card is saved; "Change card").
  app.get("/billing/card", requireAccount, topupLimiter, async (req, res) => {
    const back = safeBack(req.query.back, "/settings#billing");
    if (!config.billing.payable || isOwner(req.account._id)) return res.redirect(303, back);
    try {
      res.redirect(303, await billing.createCardSession(req.account, { enable: req.query.enable === "1", back }));
    } catch (err) {
      console.error(`[billing] card checkout for @${req.account.username} failed: ${err.message}`);
      res.redirect(303, withNotice(back, "payfail"));
    }
  });

  // Auto-refill on / off, its amount and THE MONTHLY LIMIT (Settings). Turning it on needs a saved card (without one,
  // Settings links to /billing/card?enable=1 instead: a form can't lead to Stripe). Only a top-up amount and one of the
  // limits (autoRefill.LIMITS) are accepted. Turned on, or a limit raised, the watcher looks right away: the balance may
  // already be under the line.
  app.post("/billing/autorefill", requireAccount, async (req, res) => {
    if (!config.billing.payable || isOwner(req.account._id)) return res.redirect(303, "/settings");
    const ar = req.account.autoRefill || {};
    const set = {};
    const usd = Number(req.body.amount);
    if (config.billing.topupAmountsUsd.includes(usd)) set["autoRefill.amountUsd"] = usd;
    const limit = req.body.limit === undefined ? null : Number(req.body.limit);
    if (autoRefill.LIMITS.includes(limit)) set["autoRefill.monthlyLimitUsd"] = limit;
    const on = req.body.on === "1" ? true : req.body.on === "0" ? false : null;
    if (on === true && ar.paymentMethodId) Object.assign(set, { "autoRefill.enabled": true, "autoRefill.disabledReason": "", "autoRefill.failCount": 0, "autoRefill.lastError": "" });
    if (on === false) set["autoRefill.enabled"] = false;
    if (Object.keys(set).length) await Account.updateOne({ _id: req.account._id }, { $set: set });
    if (set["autoRefill.enabled"] || (ar.enabled && "autoRefill.monthlyLimitUsd" in set)) autoRefill.watch(req.account._id).catch((e) => console.error(`[autoRefill] check after a change failed: ${e.message}`));
    const n = set["autoRefill.enabled"] === true ? "refill-on" : on === false ? "refill-off" : "saved";
    res.redirect(303, `/settings?n=${n}#billing`);
  });

  app.get("/billing/done", requireAccount, async (req, res) => {
    const back = safeBack(req.query.back, "/settings");
    if (req.query.cancelled) return res.redirect(303, withNotice(back, "cancelled"));
    let n = "pending";
    try {
      const session = await billing.sessionFor(req.query.session_id, req.account._id);
      if (session) n = await billing.settleReturn(session);
    } catch (err) {
      console.error(`[billing] settling on return failed (the webhook settles it): ${err.message}`);
    }
    // Back from a long stop (THE PAUSE, services/pause.js: it ran out more than a day ago): how far back to read what was
    // missed, first. Nothing reads until it's answered.
    if (n === "paid" && req.account.pause && req.account.pause.why === "balance" && pause.asks(req.account)) return res.redirect(303, withNotice("/resume", n));
    // A paused account resumes now. Only a regular sync runs here: a first pull still to finish is the worker's
    // (services/scheduler.js picks it up within seconds of the balance covering it).
    const state = await SyncState.findById(req.account._id, "lastRunAt").lean();
    if (n === "paid" && modulesOn(req.account).length && !pullDue(req.account, state)) {
      const username = req.account.username;
      runSync(syncSettings(req.account._id))
        .then((r) => console.log(summaryLine(r, `@${username} after top-up`)))
        .catch((e) => console.error(`sync @${username} after top-up failed: ${e.message}`));
    }
    res.redirect(303, withNotice(back, n));
  });

  // "Sync now": the same run the scheduler does (your own profile included, so the header's counts are X's), under
  // the same per-account lock (a press during a scheduled run is a no-op). Waits for the run so the page you land
  // back on shows it. Back to where you pressed it, same-origin.
  app.post("/sync", requireAccount, async (req, res) => {
    await runSync({ ...syncSettings(req.account._id), byHand: true });
    res.redirect(303, safeBack(req.body.back, "/"));
  });

  // A RESTART (app.js, lib/shutdown.js): every open tab's /live is told to come back in a second ("retry") and closed.
  // The browser reconnects by itself, to a copy of the app that's still up (pm2 reloads them one at a time), sending
  // the last event it saw (Last-Event-ID), so whatever arrived in between is replayed (GET /live): nothing is lost.
  app.closeLive = () => {
    for (const res of liveTabs) {
      try {
        res.write("retry: 1000\n\n");
        res.end();
      } catch {}
    }
    liveTabs.clear();
  };

  // THE LAST TWO HANDLERS: an address nothing answered (404), and a request that threw (500). Both draw THE error page
  // (views/error.hbs), never the error itself: Express's own handler prints the stack trace whenever NODE_ENV isn't
  // "production" (a plain `npm start`). A press that asked for JSON gets JSON.
  app.use((req, res) => {
    res.status(404);
    if (wantsJson(req)) return res.json({ ok: false });
    res.render("error", { pageTitle: "Not here", missing: true });
  });
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status >= 400 && err.status < 500 ? err.status : 500; // a bad request stays the client's
    if (status === 500) console.error(`[web] ${req.method} ${req.path}: ${err.stack || err.message}`);
    res.status(status);
    if (wantsJson(req)) return res.json({ ok: false });
    res.render("error", { pageTitle: "Something went wrong" }, (renderErr, html) => (renderErr ? res.type("text").send("Something went wrong.") : res.send(html)));
  });
  return app;
}

module.exports = { createApp };
