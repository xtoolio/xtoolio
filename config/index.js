// config/index.js — the ONE place the environment is read.
// Validated eagerly at boot so a missing setting fails fast with a clear message instead of a confusing crash
// deep inside a request or a sync run. Nothing else reads process.env.
"use strict";

require("dotenv").config({ quiet: true });

function mustEnv(name) {
  const v = (process.env[name] || "").trim();
  if (!v) throw new Error(`${name} is not set (see .env.example)`);
  return v;
}

function optEnv(name, fallback = "") {
  const v = (process.env[name] || "").trim();
  return v || fallback;
}

const port = Number(optEnv("PORT", "3100"));

// Who may create an account. Every new account starts paid X syncing, so sign-up is closed by default:
// a comma list of X user ids (digits: an id never changes hands), or "*" for anyone. An existing account can always
// sign in.
const allowed = optEnv("ALLOWED_USERNAMES", "")
  .split(",")
  .map((s) => s.trim().replace(/^@/, "").toLowerCase())
  .filter(Boolean);
const isId = (s) => /^\d{1,20}$/.test(s);
// ALLOWED_USERNAMES lets in X user ids (and "*", anyone). A HANDLE there is IGNORED: a handle changes hands on X, so
// whoever renamed their own account to an allowlisted handle that hadn't signed up yet would get in (the admin list's
// rule; here it's a warning, not a refusal to boot, so a deployment whose list still holds handles keeps running and
// those people go on the waitlist, to be let in by id or by Admin → Waitlist).
const allowedHandles = allowed.filter((s) => s !== "*" && !isId(s));
if (allowedHandles.length) console.warn(`[config] ALLOWED_USERNAMES: ${allowedHandles.length} handle(s) ignored (X user ids only; a handle can be taken by anyone who renames to it)`);

// ADMIN_IDS: X user ids only (a handle there would quietly make nobody an admin, so it refuses to boot).
function adminsFrom() {
  const ids = optEnv("ADMIN_IDS", "").split(",").map((s) => s.trim()).filter(Boolean);
  const bad = ids.filter((s) => !isId(s));
  if (bad.length) throw new Error(`ADMIN_IDS takes X user ids (digits), not ${bad.join(", ")} (see .env.example)`);
  return new Set(ids);
}

const config = {
  // Brand lives here ONLY: nothing user-visible hardcodes it (views say {{brandName}}; verify-security greps for it).
  // A self-hosted copy sets its own.
  brandName: optEnv("BRAND_NAME", "xtoolio"),
  // The public address, as people say it (the footer). Unset: APP_ORIGIN's host, so a self-hosted copy names its own
  // address, never the hosted site's.
  siteDomain: optEnv("SITE_DOMAIN", ""),
  // Where the public code lives (the front page's "The code is public" and the footer's Code link). Unset: neither
  // shows, so nothing links to a repo before it's public.
  sourceRepoUrl: optEnv("SOURCE_REPO_URL", ""),
  // IN BETA: a "Beta" tag beside the name in the header, and the code and self-hosting said to come after it (the
  // front page; the code's links stay hidden whatever SOURCE_REPO_URL says). Off unless BETA=true.
  beta: optEnv("BETA", "false") === "true",
  // The footer's credit, "Made with 🫶 in <place> by @<handle>". In .env, never in the code: the
  // code is public, and a self-hosted copy credits nobody unless it sets its own. Unset (either): no credit.
  madeBy: optEnv("FOOTER_MADE_BY", "").replace(/^@/, ""),
  madeIn: optEnv("FOOTER_MADE_IN", ""),

  port,
  // 127.0.0.1 until the deploy step (nginx + TLS + a real APP_ORIGIN registered as X's callback).
  host: optEnv("HOST", "127.0.0.1"),
  // How many proxies in front of the app to believe about the visitor's address (Express's "trust proxy": req.ip and
  // req.secure come from X-Forwarded-*, and every per-address rate limit keys on req.ip). 1 = one nginx in front
  // (docs/DEPLOY.md), the default; 2 = a CDN in front of nginx; 0 = nothing in front (serving the internet directly):
  // then a visitor's own X-Forwarded-For header must NOT be believed, or it walks past every rate limit.
  trustProxy: Number(optEnv("TRUST_PROXY", "1")),
  // The one address the app answers on: the X callback is built from it, and a request on any other hostname
  // (localhost vs 127.0.0.1) is redirected here first, so the session cookie and the callback always match.
  appOrigin: optEnv("APP_ORIGIN", `http://127.0.0.1:${port}`).replace(/\/+$/, ""),

  sessionSecret: mustEnv("SESSION_SECRET"),
  sessionDays: 30, // the cookie's life AND the session store's TTL (web.js, app.js)
  // 32 bytes, base64: seals each account's X tokens at rest (lib/crypto.js).
  tokenKey: mustEnv("TOKEN_KEY"),
  signup: { anyone: allowed.includes("*"), ids: new Set(allowed.filter(isId)) },
  // THE INVITE LINKS (services/invites.js): how many people can sign up through each account's link, skipping the
  // waitlist. 0: no links. Meaningless while sign-up is open to anyone.
  invites: { perAccount: Number(optEnv("INVITES_PER_ACCOUNT", "5")) },
  // THE ADMINS: X USER IDS (comma list) who see the Admin page (routes/admin.js: the feedback people sent, the
  // waitlist, the DM sender). In .env, never in the code (it's public). Unset: nobody. By id, never handle: a handle
  // changes hands on X, so whoever renamed their own account to a freed admin handle would be an admin.
  admins: adminsFrom(),
  // Production mode (NODE_ENV=production, set by ecosystem.config.js): year-long caching of versioned assets and the
  // __Host- CSRF cookie (web.js). Read here, like every other setting.
  production: process.env.NODE_ENV === "production",
  // Process role (set per-app in ecosystem.config.js). "web" serves HTTP; "worker" runs ONLY the sync scheduler
  // (no listener, so the two never collide on the port). A plain `npm start` is one web process that also
  // schedules, because SCHEDULER_ENABLED defaults on.
  procRole: optEnv("PROC_ROLE", "web"),
  schedulerEnabled: optEnv("SCHEDULER_ENABLED", "true") === "true",
  // How long a stopping process may take to finish cleanly (lib/shutdown.js) before it exits anyway. pm2's kill_timeout
  // (ecosystem.config.js) sits above it, so pm2 never kills one mid-handover.
  shutdownMs: Number(optEnv("SHUTDOWN_MS", "25000")),

  mongoUri: mustEnv("MONGO_URI"),
  // A developer's machine only: READ-ONLY access to the deployment's database, for checking it (a developer's own scripts that
  // open their own connection with it). Nothing in the app uses it; MONGO_URI there points at a test database.
  liveReadUri: optEnv("MONGO_LIVE_READ_URI", "") || null,
  // Pool size PER PROCESS, set explicitly (the driver default is 100) so web + worker stay well inside Atlas's
  // connection cap.
  mongoMaxPoolSize: Number(optEnv("MONGO_MAX_POOL_SIZE", "10")),

  // The X app's OAuth 2.0 credentials (developer console → the app → Keys & Tokens → OAuth 2.0).
  x: {
    clientId: mustEnv("X_CLIENT_ID"),
    clientSecret: mustEnv("X_CLIENT_SECRET"),
    // The X user id of the developer account that owns this app (it pays the bill). Its own reads are Owned Reads
    // ($0.001: lib/pricing.js), and its token reads X's real credit balance around every run (services/usage.js),
    // which only it may see on /usage. Unset: estimates only, no balance.
    ownerId: optEnv("X_APP_OWNER_ID", "") || null,
    // The app's own Bearer token (console → Keys and tokens → Bearer Token): the ONLY credential X's activity stream
    // takes (services/live.js; docs/LIVE.md). Unset: no live events, sync alone. A client-credentials token minted
    // from the OAuth 2.0 id/secret is refused by the stream ("Unknown" authentication), so it must be this one.
    bearerToken: optEnv("X_BEARER_TOKEN", "") || null,
    // THE LIVE DAY CAP (services/live.js): X's cost, in dollars, of the live events one account may be delivered in a
    // UTC day. Past it the account's subscriptions go until the day turns (the sync carries on), so nobody can run up
    // someone's bill by following and unfollowing them all day (X bills each event, and the account pays it). 0 = none.
    liveDayMaxUsd: Number(optEnv("LIVE_DAY_MAX_USD", "5")),
  },

  sync: {
    // Hard ceilings per run (X bills per returned post / user). The scheduled run and "Sync now" use these;
    // `npm run sync -- --cap N` overrides the post cap for a one-off big pull.
    readCap: Number(optEnv("SYNC_READ_CAP", "100")),
    // Thread context (posts read by id to show what a reply answers) has its own ceiling, so it never competes
    // with history for one budget. Naturally bounded (only chains of stored posts), capped anyway.
    contextCap: Number(optEnv("SYNC_CONTEXT_CAP", "2000")),
    userCap: Number(optEnv("SYNC_USER_CAP", "1000")),
    // How often the scheduler syncs. A run only reads what's new, so most runs read a handful of posts.
    everyMinutes: Number(optEnv("SYNC_EVERY_MINUTES", "15")),
    // How many accounts the worker syncs at once (services/scheduler.js: passes and first reads share them). X's rate
    // limits are per user, so more at once is safe for X; the bound is the worker's own memory and the database. 5 on
    // a laptop; raise it on the droplet for a launch, when sign-ups arrive together (docs/DEPLOY.md).
    slots: Number(optEnv("SYNC_SLOTS", "5")),
  },

  // Opt-in extras (services/features.js), each with its own hard ceiling per run.
  extras: {
    // Likes: your liked posts read per sync (new ones + the look back through older ones), and likers read on
    // your replies.
    likesCap: Number(optEnv("LIKES_CAP", "1000")),
    likersUserCap: Number(optEnv("LIKERS_CAP", "300")),
  },

  // Prepaid billing (docs/BILLING.md; the rules: services/balance.js, wired by services/billing.js). Every unit of X
  // work an account runs is charged to its balance at X's cost × the multiplier. With billing OFF the charges are
  // still written (a shadow bill: what each account would have paid), but nothing is gated and nothing asks for money.
  billing: {
    enabled: optEnv("METERED_BILLING_ENABLED", "false") === "true",
    // The platform markup on X's cost: 50 → ×1.5. One account can have a lower one, never higher (Account.marginMultiplier,
    // set with scripts/margin.js: a discount, down to X's cost).
    multiplier: 1 + Number(optEnv("MARGIN_MARKUP_PCT", "50")) / 100,
    // The markup at the full rate stops at this much for one account in a calendar month (UTC), in dollars; past it the
    // rate drops to MARKUP_AFTER_CAP_PCT until the month turns (a flat cap at $50 couldn't cover card
    // processing on a big top-up, ~3% of it, so a small rate continues past it; it was 10%, raised to 15%). 0 = no
    // threshold (the full rate on everything).
    markupCapUsd: Number(optEnv("MARKUP_CAP_USD", "50")),
    markupAfterCapPct: Number(optEnv("MARKUP_AFTER_CAP_PCT", "15")),
    // THE BULK RATE: the markup on reading an account's history (onboarding), a one-off bulk read the account starts
    // itself, priced before it runs. Its own rate, outside the month's threshold count (services/balance.js). Was
    // HISTORY_MARKUP_PCT. 15%, the same as the rate past the threshold: the lowest markup anywhere.
    bulkMarkupPct: Number(optEnv("BULK_MARKUP_PCT", "15")),
    // A unit starts only while the balance is above this. The unit that crosses it finishes (one unit of overshoot).
    floorCents: Number(optEnv("METERED_FLOOR_CENTS", "0")),
    // Whole dollars. An account's first top-up is at least the deposit; after that, any of the top-up amounts. The
    // top-up link only ever mints a Checkout for an amount from these, never a number from the browser.
    depositUsd: Number(optEnv("DEPOSIT_USD", "20")),
    // LIKESTORM ONLY's first top-up (services/features.js): smaller, since nothing syncs and it pays per storm alone.
    stormDepositUsd: Number(optEnv("STORM_DEPOSIT_USD", "10")),
    // THE INVITE CREDIT: what an admin's Invite (Admin → Waitlist, by @handle) puts on the person's balance when they
    // first sign in (services/waitlist.js). 0: none.
    inviteCreditUsd: Number(optEnv("INVITE_CREDIT_USD", "0")),
    topupAmountsUsd: optEnv("TOPUP_AMOUNTS_USD", "10,25,50,100").split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0),
    // Auto-refill (opt-in, per account): at or under this balance, charge the saved card the account's chosen amount
    // (one of the top-up amounts; this one until it picks).
    autoRefillThresholdCents: Number(optEnv("AUTO_REFILL_THRESHOLD_CENTS", "500")),
    autoRefillUsd: Number(optEnv("AUTO_REFILL_USD", "25")),
  },

  // Stripe: this site's own Stripe account (docs/BILLING.md). No secret key: nothing can be paid (top-up links don't show; the webhook answers 503). The webhook secret is the
  // endpoint's (dashboard → Webhooks, or `stripe listen` locally).
  stripe: {
    secretKey: optEnv("STRIPE_SECRET_KEY", ""),
    webhookSecret: optEnv("STRIPE_WEBHOOK_SECRET", ""),
  },
  // Who runs the site (Stripe's invoices, /terms, /privacy), under which law, and where people write to: the
  // operator's facts, so they live in .env, never here. Unset: the entity is the brand name, the Terms leave out the
  // governing-law clause, and the legal pages say to reach us through X.
  legalEntity: optEnv("LEGAL_ENTITY", ""),
  legalJurisdiction: optEnv("LEGAL_JURISDICTION", ""),
  // Who people reach about their account (refunds, questions; deleting is self-serve in Settings): an X handle, without
  // the @ (contact is a DM on X, not email). Terms and Privacy say "send a DM to @handle on X"
  // (partials/contact.hbs); unset, "reach us on X". It replaced CONTACT_EMAIL.
  contactX: optEnv("CONTACT_X", "").replace(/^@/, ""),
  // The SITE's own X account, without the @: the footer links it, and
  // the waitlist page says to follow it, and connected on the Admin page it DMs the people let in. Unset: none of those.
  siteX: optEnv("SITE_X", "").replace(/^@/, ""),
};
config.legalEntity = config.legalEntity || config.brandName;
config.siteDomain = config.siteDomain || new URL(config.appOrigin).host;
if (!(Number.isInteger(config.trustProxy) && config.trustProxy >= 0 && config.trustProxy <= 5)) throw new Error("TRUST_PROXY must be how many proxies sit in front of the app: 0 to 5 (1 = nginx)");
// It lands in an href on every page: an https address or nothing.
if (config.sourceRepoUrl && !/^https:\/\/[^\s"<>]+$/.test(config.sourceRepoUrl)) throw new Error("SOURCE_REPO_URL must be an https:// address");
for (const [key, v] of [["CONTACT_X", config.contactX], ["SITE_X", config.siteX]]) {
  if (v && !/^[A-Za-z0-9_]{1,15}$/.test(v)) throw new Error(`${key} must be an X handle (letters, digits, _; up to 15)`);
}
// Money can be taken only where billing is on AND Stripe is configured.
config.billing.payable = config.billing.enabled && !!config.stripe.secretKey;

// Never sell below X's cost, and never let a typo (500 for 50) charge five times it.
if (!(config.billing.multiplier >= 1 && config.billing.multiplier <= 3)) throw new Error("MARGIN_MARKUP_PCT must be between 0 and 200");
if (!(config.billing.markupCapUsd >= 0)) throw new Error("MARKUP_CAP_USD must be a number of dollars, 0 for no cap");
if (!(config.billing.bulkMarkupPct >= 0 && config.billing.bulkMarkupPct <= 200)) throw new Error("BULK_MARKUP_PCT must be between 0 and 200");
if (!(config.billing.markupAfterCapPct >= 0 && config.billing.markupAfterCapPct <= (config.billing.multiplier - 1) * 100)) throw new Error("MARKUP_AFTER_CAP_PCT must be between 0 and MARGIN_MARKUP_PCT");
if (!Number.isFinite(config.billing.floorCents)) throw new Error("METERED_FLOOR_CENTS must be a number");
if (!(Number.isInteger(config.sync.slots) && config.sync.slots >= 1 && config.sync.slots <= 100)) throw new Error("SYNC_SLOTS must be a whole number from 1 to 100");
if (!config.billing.topupAmountsUsd.length || !(config.billing.depositUsd > 0)) throw new Error("TOPUP_AMOUNTS_USD needs whole dollar amounts and DEPOSIT_USD a positive one");
if (!(Number.isInteger(config.billing.stormDepositUsd) && config.billing.stormDepositUsd > 0)) throw new Error("STORM_DEPOSIT_USD needs a positive whole dollar amount");
if (!config.billing.topupAmountsUsd.includes(config.billing.autoRefillUsd)) throw new Error("AUTO_REFILL_USD must be one of TOPUP_AMOUNTS_USD");
if (!(config.billing.inviteCreditUsd >= 0 && config.billing.inviteCreditUsd <= 500 && Math.round(config.billing.inviteCreditUsd * 100) === config.billing.inviteCreditUsd * 100)) throw new Error("INVITE_CREDIT_USD must be dollars and cents, 0 to 500");

module.exports = config;
