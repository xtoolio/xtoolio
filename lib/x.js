// The ONE door to the X API. Every read goes through here so the read cap
// can't be bypassed and every billed resource is recorded (a client needs a
// meter: services/usage.js). X bills a read per RETURNED resource, not per
// request (prices: lib/pricing.js), so the caps count resources. The one WRITE
// is a like / unlike (like.write, the Liking extra), billed per request.
// Sign-in (OAuth 2.0 + PKCE) lives here too: authorizeUrl, exchangeCode,
// refreshTokens, revokeToken. So does Live (X pushing events: activity,
// activityStream, eventContents; docs/LIVE.md).
//
// Every read is made with the signed-in account's OWN user token (Bearer), so
// X's per-user rate limits apply per account, not to the whole app.
//
// Deliberately no USER expansions: an expanded user may be billed as a user
// read on every page it appears. Profiles come from usersByIds instead, once
// per person, cached in the Person collection by sync. (Media is expanded:
// MEDIA_EXPANSION below.)
"use strict";

const crypto = require("crypto");
const { classOf, hasLink } = require("./pricing");
const { xHalted } = require("./shutdown");

const API = "https://api.x.com/2";
const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const TOKEN_URL = `${API}/oauth2/token`;
const REVOKE_URL = `${API}/oauth2/revoke`;
// Read-only, plus offline.access for a refresh token (so the scheduler can sync without the person present).
// These are what EVERY sign-in asks for. An opt-in extra (services/features.js) adds its own scope only when
// someone turns it on (incremental consent): a person who never uses Likes never grants like.read, and only one
// who turns Liking on grants the one write, like.write (the app's permission in X's console is Read and Write for it).
const SCOPES = ["tweet.read", "users.read", "offline.access"];

const POST_FIELDS = [
  "created_at",
  "conversation_id",
  "in_reply_to_user_id",
  "referenced_tweets",
  "author_id",
  "entities",
  "public_metrics",
  // A post over 280 characters: without this, `text` is all X returns, cut at 280 (models/Post.js wholeText).
  "note_tweet",
  "attachments", // its media keys, for the media expansion below
  // Where X's own app starts showing a reply: past the @names X put in front, so an @name TYPED there stays
  // (services/text.js; stored in `raw`). Without it the text shows from after every leading @name.
  "display_text_range",
].join(",");

// A post's photos / video / GIF, through expansions=attachments.media_keys (MEDIA_EXPANSION). The ONE expansion
// we use: X's price list bills posts and users per resource returned and has no media row (docs.x.com pricing),
// while an expanded USER would bill as a user read, so user expansions stay off. No `variants`:
// video plays on X (the preview image is all we show), and they'd bloat every stored post.
const MEDIA_EXPANSION = { expansions: "attachments.media_keys", "media.fields": "type,url,preview_image_url,width,height,alt_text,duration_ms" };

// X sends media once per response (includes.media); each post gets its own list as `media`, in X's shape, so a
// post (and its stored raw copy) stands alone. Models/Post.js fromApi reads it.
function withMedia(body) {
  const byKey = new Map(((body.includes && body.includes.media) || []).map((m) => [m.media_key, m]));
  return (body.data || []).map((p) => {
    const keys = p.attachments && p.attachments.media_keys;
    return keys ? { ...p, media: keys.map((k) => byKey.get(k)).filter(Boolean) } : p;
  });
}

const USER_FIELDS = [
  "name",
  "username",
  "profile_image_url",
  "description",
  "location",
  "url",
  "created_at",
  "public_metrics",
  "verified",
  "verified_type",
  "protected",
  // What the t.co links in a bio and the profile website really are (Person.bioUrls / website).
  "entities",
  // Whether this person follows the reading account and it follows them ("followed_by", "following"; left out when
  // neither): models/Follow.js record. Verified with GET /2/users?ids=, no extra cost (a same-day re-read
  // of two profiles cost $0.00 with it). NOT stored on the shared Person (Person.fromApi drops it).
  "connection_status",
].join(",");

class ReadCapReached extends Error {}

// Requests kept back in every rate-limit window, so a Sync now press or the next scheduled run in the same window can
// still make its first request (and learn the window) instead of being refused outright.
const RATE_RESERVE = 2;
// A WRITE keeps none: what it's for is a read's next request learning the window, and a write you press is
// the request itself. With 2 kept, "select all 50" unfollowed 48 and the bulk like said "Like 48". At 0 left a write is
// still refused before X refuses it. THE rule for both, lib/writeLimits.js and services/extras.js writesLeft use it.
const reserveFor = (method) => (method === "GET" ? RATE_RESERVE : 0);

// The endpoint a path belongs to, as X's rate-limit table names it ("/2/users/:id/tweets"): ids become ":id".
const endpointOf = (path) => path.replace(/\/\d+(?=\/|$)/g, "/:id");
// The rate-limit window a request spends: X counts each METHOD on an endpoint apart (reading the accounts you follow,
// GET /users/:id/following, 300 / 15 min; following someone, POST on the same path, 50), so a write's window is keyed
// with its method. Reads keep the bare endpoint. Both used to be the bare path, and a following-list read
// wrote its window over the follow button's.
const windowKey = (method, path) => (method === "GET" ? endpointOf(path) : `${method} ${endpointOf(path)}`);

// Where a client keeps what X said about each endpoint's window: the meter's `windows` store when it has one
// (services/ratelimits.js: per ACCOUNT, in the database, so restarts and the web + worker processes share it), else
// this process's memory keyed by a hash of the token (sign-in, before the account is known; tests). Either way a
// sync, its Likes client, a Sync now press and a Follows refresh spend one account's windows together.
const memoryWindows = new Map();
function memoryStore(tokenKey) {
  return {
    async get(endpoint) {
      return memoryWindows.get(`${tokenKey} ${endpoint}`) || null;
    },
    async set(endpoint, win) {
      const now = Date.now();
      for (const [k, w] of memoryWindows) if (w.reset <= now) memoryWindows.delete(k);
      memoryWindows.set(`${tokenKey} ${endpoint}`, win);
    },
  };
}

// X's rate-limit headers on any response → { remaining, reset (ms epoch) }, or null when absent.
function rateWindow(headers) {
  const remaining = headers.get("x-rate-limit-remaining");
  const reset = headers.get("x-rate-limit-reset");
  if (remaining === null || remaining === undefined || !reset) return null;
  return { remaining: Number(remaining), reset: Number(reset) * 1000 };
}

// The clean stop when an endpoint's window is nearly used: shaped like X's own 429 (status 429 + the reset time), so
// every caller that already stops cleanly on a 429 (services/sync.js stopReason, the extras) handles it unchanged.
function rateLimitNear(endpoint, reset) {
  const err = new Error(`X's rate limit for ${endpoint} is nearly used; it resets at ${new Date(reset).toISOString().slice(11, 16)} UTC`);
  err.status = 429;
  err.rateLimitReset = new Date(reset);
  err.paced = true; // stopped before asking, not refused by X
  return err;
}

const RETRY_WAITS_MS = [2000, 5000, 10000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Lookups by id answer 200 with per-id errors for what X won't return.
function missingFrom(body, resourceType) {
  return (body.errors || [])
    .filter((e) => e.resource_type === resourceType && e.value)
    .map((e) => ({ id: e.value, title: e.title, detail: e.detail, type: e.type }));
}
// THE rule for "this post is gone for EVERYONE": X said it doesn't exist. Anything else X won't serve ("Authorization
// Error": a protected author this token doesn't follow) is about the ASKING account, and the post is shared: stored as
// gone, it vanished for the followers who can see it (found by an outside read of the code). Every production
// placeholder so far was "Not Found Error".
const notFound = (m) => !!m && (m.title === "Not Found Error" || /\/resource-not-found$/.test(String(m.type || "")));

// ── Sign-in: OAuth 2.0 authorization code + PKCE (confidential client) ──

// A PKCE pair: the verifier stays in our session; X gets only its SHA-256.
function pkcePair() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// `scopes`: SCOPES plus any extras' scopes (the caller composes them; a new authorization replaces the old
// grant, so it must ask for everything the account still needs, not just the new one).
function authorizeUrl({ clientId, redirectUri, state, challenge, scopes = SCOPES }) {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

// POST to X's token endpoints with the app's own credentials (HTTP Basic, as a confidential client).
async function oauthPost(url, app, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams(params).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`X OAuth ${res.status}: ${body.error_description || body.error || JSON.stringify(body).slice(0, 200)}`);
    err.status = res.status;
    err.oauthError = body.error;
    throw err;
  }
  return body;
}

// → { accessToken, refreshToken, expiresAt, scope }
function tokensFrom(body) {
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: new Date(Date.now() + Number(body.expires_in || 7200) * 1000),
    scope: body.scope,
  };
}

async function exchangeCode(app, { code, redirectUri, verifier }) {
  return tokensFrom(await oauthPost(TOKEN_URL, app, { grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier, client_id: app.clientId }));
}

// X rotates refresh tokens: the old one stops working once this returns, so the caller must save BOTH new tokens.
async function refreshTokens(app, refreshToken) {
  return tokensFrom(await oauthPost(TOKEN_URL, app, { grant_type: "refresh_token", refresh_token: refreshToken, client_id: app.clientId }));
}

// `hint`: "access_token" (a refused sign-up's fresh token) or "refresh_token" (deleting an account: the refresh token is
// the grant itself, so nothing can mint a new access token after it).
async function revokeToken(app, token, hint = "access_token") {
  await oauthPost(REVOKE_URL, app, { token, token_type_hint: hint, client_id: app.clientId });
}

// ── Reads ──

// `token` is the account's user access token. Per-run ceilings: readCap = timeline posts, contextCap = posts read
// by id for threads, userCap = profiles. usage.posts is their sum.
//
// `meter` (services/usage.js metered → meterFor) is REQUIRED: every read records what X returned into the unit's
// ledger row before returning it — record(what, priceClass, resourceType, ids) — so nothing X bills can be read
// unrecorded, including by a one-off script. `ownerId` = the app owner's X id, given ONLY to a client on the
// owner's own token (services/accounts.js syncSettings): its own timeline / mentions / likes / follower lists are Owned
// Reads (lib/pricing.js classOf). Another account reading them pays the post price.
function createClient({ token, meter, ownerId = null, readCap, contextCap = 0, userCap, retryWaitsMs = RETRY_WAITS_MS }) {
  if (!token) throw new Error("createClient needs the account's access token");
  if (!meter || typeof meter.record !== "function") throw new Error("createClient needs a meter (services/usage.js metered): every X read is recorded");
  const usage = { posts: 0, timelinePosts: 0, contextPosts: 0, users: 0, requests: 0 };
  const idsOf = (list) => list.map((r) => r.id);
  // The account's rate-limit windows (memoryStore keys by a hash, so the token itself is never a map key).
  const windows = meter.windows || memoryStore(crypto.createHash("sha256").update(token).digest("hex").slice(0, 16));

  // Reads are GETs (safe to repeat) and a failed one returns nothing billable, so X's own hiccups — a 5xx, a
  // dropped connection — are retried after RETRY_WAITS_MS. The first real pull died on a single 503 thousands
  // of posts in. What still fails is thrown with `transient: true` for the sync to stop cleanly on (progress saved).
  //
  // RATE LIMITS are paced by X's own headers, not guessed: every response says how many requests are left in this
  // endpoint's 15-minute window, and a request is never sent once that's down to RATE_RESERVE (rateLimitNear: a
  // clean stop like a 429, before one happens). X's limits are per user token, so this is one account's budget.
  //
  // A WRITE (a like) is never retried: X bills it per request, and one that failed on our side may have landed.
  // `json`: a JSON body; `form`: a FormData body (a media upload's bytes), its multipart boundary set by fetch.
  async function request(method, path, { params, json, form } = {}) {
    // The worker is handing over to its successor (lib/shutdown.js haltX): stop here, before asking, the way an X
    // hiccup stops a run (transient: progress saved, lock released, the successor picks it up next pass).
    if (xHalted()) throw Object.assign(new Error("stopping for a restart; the next worker picks this up"), { transient: true });
    // THE CEILING (services/usage.js meterFor): once this unit's cost has reached what the balance covers (or the quote
    // it ran under), no more reads: a clean stop like a count cap, progress saved, and the charge is capped there
    // (services/balance.js capped), so a run never takes an account below zero. A write isn't stopped here (a single
    // press, which the gate let start); a BULK press checks the ceiling itself before each write after its first
    // (routes/inbox.js like-all, routes/pages.js followMany, web.js the bulk unfollow).
    if (method === "GET" && meter.atCeiling && meter.atCeiling()) throw Object.assign(new ReadCapReached("what your balance covers is read; add money to read more"), { ceiling: true });
    const endpoint = windowKey(method, path);
    const known = await windows.get(endpoint);
    if (known && known.remaining <= reserveFor(method) && known.reset > Date.now()) throw rateLimitNear(endpoint, known.reset);
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const retries = method === "GET" ? retryWaitsMs : [];
    const init = { method, headers: { Authorization: `Bearer ${token}` } };
    if (json) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(json);
    } else if (form) {
      init.body = form;
    }
    for (let attempt = 0; ; attempt++) {
      usage.requests++;
      let res;
      try {
        res = await fetch(url, init);
      } catch (cause) {
        const err = new Error(`X API unreachable on ${path}: ${cause.message}`);
        err.transient = true;
        if (attempt < retries.length) {
          await sleep(retries[attempt]);
          continue;
        }
        throw err;
      }
      const win = rateWindow(res.headers);
      if (win) await windows.set(endpoint, win);
      const body = await res.json().catch(() => ({}));
      if (res.ok) return body;
      if (res.status >= 500 && attempt < retries.length) {
        await sleep(retries[attempt]);
        continue;
      }
      const detail = body.detail || body.title || JSON.stringify(body).slice(0, 300);
      const reset = res.headers.get("x-rate-limit-reset");
      const err = new Error(`X API ${res.status} on ${path}: ${detail}`);
      err.status = res.status;
      err.detail = detail; // X's own words, for a write it refused ("…duplicate content", "…too long")
      if (body.type) err.problem = String(body.type).split("/").pop(); // X's reason as a key ("dm-recipient-not-accepting")
      err.transient = res.status >= 500;
      if (reset) err.rateLimitReset = new Date(Number(reset) * 1000);
      throw err;
    }
  }
  const get = (path, params) => request("GET", path, { params });

  // Timeline reads and context reads have separate ceilings: context (the posts a thread hangs on) is the cost
  // of SHOWING the posts already chosen, so it must not compete with history for one budget. When it did, a
  // resumed pull sized to its last few hundred posts left the threads of the thousands before them unfetched.
  function remainingPosts() {
    return readCap - usage.timelinePosts;
  }

  function remainingContext() {
    return contextCap - usage.contextPosts;
  }

  function remainingUsers() {
    return userCap - usage.users;
  }

  function spendUsers(n) {
    if (n > remainingUsers()) throw new ReadCapReached(`user cap of ${userCap} reached`);
  }

  // Who this token belongs to (sign-in). → { id, username, name, profile_image_url, public_metrics: { tweet_count, ... } }
  async function me() {
    spendUsers(1);
    const body = await get("/users/me", { "user.fields": "public_metrics,profile_image_url" });
    usage.users++;
    if (body.data) await meter.record("me", "user", "user", [body.data.id]);
    return body.data;
  }

  // Profiles for up to 100 user ids in one request. The caller sizes the
  // batch to remainingUsers(); asking for more than the cap allows throws.
  // Returns { users, missing }: `missing` is X's per-id error (suspended,
  // deleted) as { id, title, detail }, which X returns alongside a 200.
  // `what` names the read on the ledger: "profiles" (people), "self" (the account's own profile, read on its own
  // so the Runs table can say so).
  async function usersByIds(ids, { what = "profiles" } = {}) {
    if (!ids.length) return { users: [], missing: [] };
    if (ids.length > 100) throw new Error("usersByIds takes at most 100 ids");
    spendUsers(ids.length);
    const body = await get("/users", { ids: ids.join(","), "user.fields": USER_FIELDS });
    const users = body.data || [];
    usage.users += users.length;
    await meter.record(what, "user", "user", idsOf(users));
    return { users, missing: missingFrom(body, "user") };
  }

  // Up to 100 posts by id (thread context), counted against the context cap.
  // The caller sizes the batch to remainingContext(); more than that throws.
  // Returns { posts, missing }: `missing` is X's per-id error (deleted,
  // protected) as { id, title, detail }, returned alongside a 200.
  async function postsByIds(ids) {
    if (!ids.length) return { posts: [], missing: [] };
    if (ids.length > 100) throw new Error("postsByIds takes at most 100 ids");
    if (ids.length > remainingContext()) throw new ReadCapReached(`context cap of ${contextCap} posts reached`);
    const body = await get("/tweets", { ids: ids.join(","), "tweet.fields": POST_FIELDS, ...MEDIA_EXPANSION });
    const posts = withMedia(body);
    usage.contextPosts += posts.length;
    usage.posts += posts.length;
    await meter.record("context", "post", "post", idsOf(posts));
    return { posts, missing: missingFrom(body, "tweet") };
  }

  // One page of a post timeline. `kind` is "tweets" (their own posts,
  // replies included) or "mentions". Returns { posts, nextToken } and never
  // asks for more than the cap allows. `maxResults` lets the caller ask for
  // less (its share of the cap); X's page size is 5..100. `exclude` ("replies,retweets": X's own filter on "tweets",
  // which then reaches back only ~800 posts) and `what` (its name on the ledger) are for reading SOMEONE ELSE'S posts
  // (services/tagged.js: who an account tags).
  async function timelinePage(userId, kind, { sinceId, untilId, paginationToken, maxResults, exclude, what } = {}) {
    const room = remainingPosts();
    if (room < 5) throw new ReadCapReached(`read cap of ${readCap} posts reached`);
    const body = await get(`/users/${userId}/${kind}`, {
      max_results: Math.max(5, Math.min(100, room, maxResults || 100)),
      "tweet.fields": POST_FIELDS,
      ...MEDIA_EXPANSION,
      since_id: sinceId,
      until_id: untilId,
      pagination_token: paginationToken,
      exclude,
    });
    const posts = withMedia(body);
    usage.timelinePosts += posts.length;
    usage.posts += posts.length;
    await meter.record(what || (kind === "tweets" ? "timeline" : "mentions"), classOf("post", { endpoint: kind, userId, ownerId }), "post", idsOf(posts));
    return { posts, nextToken: body.meta && body.meta.next_token };
  }

  // Posts quoting `postId` (GET /2/tweets/:id/quote_tweets), one page, newest first (X's page is 10..100). Counted
  // against readCap. Each carries `quoted_author_id` = `authorId` (the quoted post's author, which the caller knows),
  // so it's stored as someone talking to them. Quotes don't tag you, so no feed carries them: this and Live's
  // post.quote.create are the only ways in. → posts
  async function quotesOf(postId, authorId, { maxResults = 100 } = {}) {
    const room = remainingPosts();
    if (room < 10) throw new ReadCapReached(`read cap of ${readCap} posts reached`);
    const body = await get(`/tweets/${postId}/quote_tweets`, { max_results: Math.max(10, Math.min(100, room, maxResults)), "tweet.fields": POST_FIELDS, ...MEDIA_EXPANSION });
    const returned = withMedia(body);
    usage.timelinePosts += returned.length;
    usage.posts += returned.length;
    await meter.record("quotes", "post", "post", idsOf(returned)); // X bills everything it returned
    // Only someone else's real quote: X's list also holds reposts of a quote ("RT @you: …") and the author quoting
    // themselves, neither of which is someone talking to them (an early backfill stored both).
    return returned.filter((p) => p.author_id !== authorId && !(p.referenced_tweets || []).some((r) => r.type === "retweeted")).map((p) => ({ ...p, quoted_author_id: authorId }));
  }

  // ── Extras (services/features.js). Each runs on its own client (its own caps), recording into the same meter. ──

  // One page of the posts this user liked, newest LIKE first (not newest post). Needs like.read. Counted against
  // readCap. X's page is 10..100; `maxResults` asks for less (the new-likes check starts small). → { posts, nextToken }
  async function likedPage(userId, { paginationToken, maxResults = 100 } = {}) {
    const room = remainingPosts();
    if (room < 10) throw new ReadCapReached(`likes cap of ${readCap} posts reached`);
    const body = await get(`/users/${userId}/liked_tweets`, {
      max_results: Math.max(10, Math.min(100, room, maxResults)),
      "tweet.fields": "author_id,created_at",
      pagination_token: paginationToken,
    });
    const posts = body.data || [];
    usage.timelinePosts += posts.length;
    usage.posts += posts.length;
    await meter.record("likes", classOf("post", { endpoint: "liked_tweets", userId, ownerId }), "post", idsOf(posts));
    return { posts, nextToken: body.meta && body.meta.next_token };
  }

  // Who liked one post (X returns at most 100 likers per post, ever, and — since likes went private — only for
  // the signed-in account's OWN posts; someone else's post comes back empty). Counted against userCap.
  async function likingUsers(postId) {
    const room = remainingUsers();
    if (room < 1) throw new ReadCapReached(`user cap of ${userCap} reached`);
    // Their whole profiles (USER_FIELDS): X bills each returned user the same either way, and the Likes page names
    // and pictures them (it used to keep ids only: 217 of 649 likers showed as "?").
    const body = await get(`/tweets/${postId}/liking_users`, { max_results: Math.min(100, room), "user.fields": USER_FIELDS });
    const users = body.data || [];
    usage.users += users.length;
    await meter.record("likers", "user", "user", idsOf(users));
    return users; // X user objects, as usersByIds returns them
  }

  // One account by its @handle (GET /2/users/by/username/:username): the front page's cost estimate, before anyone
  // signs in. A profile like any other ($0.01, deduped per UTC day). → the X user, or null when X has no such account.
  async function userByUsername(username) {
    spendUsers(1);
    const body = await get(`/users/by/username/${encodeURIComponent(username)}`, { "user.fields": "created_at,public_metrics,profile_image_url,name,username" });
    if (!body.data) return null;
    usage.users++;
    await meter.record("lookup", "user", "user", [body.data.id]);
    return body.data;
  }

  // How many posts matched a search, per day, over the last `days` WHOLE UTC days (ending at today's midnight, so every
  // bucket is a whole day; up to 31, one page of day buckets), from the full archive: GET /2/tweets/counts/all, which
  // pay-per-use serves (a spike). counts/recent covers only 7 days, 6 of them whole: used before.
  // No posts come back, only counts, so it's billed per request: X's "Counts: All", $0.010 (lib/pricing.js PRICE.counts;
  // counts/recent is $0.005). The estimate's real month:
  // `from:handle` (their posts) and `@handle -from:handle` (posts to them; `to:` returned nothing). Matches what the
  // sync stores within a few a day. → [{ start, n }]
  async function postCounts(query, days) {
    const end = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
    const start = new Date(end.getTime() - Math.min(31, days) * 86400000);
    const body = await get("/tweets/counts/all", { query, granularity: "day", start_time: start.toISOString(), end_time: end.toISOString() });
    await meter.recordAction("counted", "counts");
    return (body.data || []).map((d) => ({ start: d.start, n: d.tweet_count }));
  }

  // One page of who this user follows (GET /2/users/:id/following; needs follows.read; Not following back): profiles
  // with it (USER_FIELDS), counted against userCap, X's page 1..1000, the owner's own list an Owned Read. (Its twin for
  // FOLLOWERS went with the follower check; X lists followers newest first, checked.)
  // → { users, nextToken }
  async function followingPage(userId, { paginationToken, maxResults = 1000 } = {}) {
    const room = remainingUsers();
    if (room < 1) throw new ReadCapReached(`user cap of ${userCap} reached`);
    const body = await get(`/users/${userId}/following`, { max_results: Math.max(1, Math.min(1000, room, maxResults)), "user.fields": USER_FIELDS, pagination_token: paginationToken });
    const users = body.data || [];
    usage.users += users.length;
    await meter.record("follows", classOf("user", { endpoint: "following", userId, ownerId }), "user", idsOf(users));
    return { users, nextToken: body.meta && body.meta.next_token };
  }

  // ── The one write: like or unlike a post as this user (needs like.write; the Liking extra). Billed per request,
  // recorded once it succeeds. X allows 50 of each per 15 minutes and 1,000 a day per user. → whether it's now liked.
  async function setLike(userId, postId, on) {
    const body = on
      ? await request("POST", `/users/${userId}/likes`, { json: { tweet_id: String(postId) } })
      : await request("DELETE", `/users/${userId}/likes/${postId}`);
    await meter.recordAction(on ? "liked" : "unliked", on ? "like" : "unlike");
    return !!(body.data && body.data.liked);
  }

  // Repost (on) or undo a repost of `postId` as `userId` (needs tweet.write; the Reposting add-on). docs.x.com
  // "Repost a Post" / "Delete a Repost": POST /2/users/:id/retweets { tweet_id } → { retweeted },
  // DELETE /2/users/:id/retweets/:source_tweet_id. A write: never retried. → whether it's reposted now.
  async function setRepost(userId, postId, on) {
    const body = on
      ? await request("POST", `/users/${userId}/retweets`, { json: { tweet_id: String(postId) } })
      : await request("DELETE", `/users/${userId}/retweets/${postId}`);
    await meter.recordAction(on ? "reposted" : "unreposted", on ? "repost" : "unrepost");
    return !!(body.data && body.data.retweeted);
  }

  // A picture for a post: upload one file (lib/media.js checkAttachments' item: { buffer, mime, category }) as this user
  // (needs media.write; the Pictures add-on), through X's chunked flow for every kind (one path: initialize, append in
  // pieces of at most 4 MB, finalize, then wait while X says it's processing, as a GIF can be). docs.x.com media.
  // X's price list has no row for uploading (INFERRED free: the ledger's real cost settles it), so
  // nothing is recorded for it; the post that carries it is. Never retried (a write). → the media id.
  const MEDIA_CHUNK = 4 * 1024 * 1024;
  const MEDIA_WAIT_MS = 60 * 1000;
  async function uploadMedia({ buffer, mime, category }) {
    const init = await request("POST", "/media/upload/initialize", { json: { media_type: mime, total_bytes: buffer.length, media_category: category } });
    const id = init.data && init.data.id;
    if (!id) throw Object.assign(new Error(`X API: no media id from initialize: ${JSON.stringify(init).slice(0, 200)}`), { status: 502 });
    for (let i = 0, at = 0; at < buffer.length; i++, at += MEDIA_CHUNK) {
      const form = new FormData();
      form.set("segment_index", String(i));
      form.set("media", new Blob([buffer.subarray(at, at + MEDIA_CHUNK)], { type: mime }));
      await request("POST", `/media/upload/${id}/append`, { form });
    }
    let info = ((await request("POST", `/media/upload/${id}/finalize`)).data || {}).processing_info;
    const until = Date.now() + MEDIA_WAIT_MS;
    while (info && (info.state === "pending" || info.state === "in_progress")) {
      if (Date.now() > until) throw Object.assign(new Error("X API: the picture was still processing after a minute"), { status: 504, detail: "the picture took too long to process" });
      await sleep(Math.max(1, Number(info.check_after_secs) || 1) * 1000);
      info = ((await request("GET", "/media/upload", { params: { command: "STATUS", media_id: id } })).data || {}).processing_info;
    }
    if (info && info.state === "failed") throw Object.assign(new Error(`X API: processing the picture failed: ${JSON.stringify(info.error || info).slice(0, 200)}`), { status: 422, detail: (info.error && info.error.message) || "X couldn't process that picture" });
    // BILLED (a cost audit): X's console counts one "PostCreate" per reply with pictures (17 = 17 on the day checked),
    // which was recorded as nothing. Recorded per uploaded picture at "Post: Create" ($0.015), the price-list row of that
    // name (INFERRED: per picture vs per reply unconfirmed; every reply checked carried one).
    await meter.recordAction("uploaded", "mediaUpload");
    return String(id);
  }

  // The second write: post `text` as this user, replying to `postId` (needs tweet.write; the Replying extra), with the
  // pictures `mediaIds` (uploadMedia) if any. Billed per request ("Post: Create", or "(with URL)" when the text carries
  // a link: lib/pricing.js hasLink), recorded once it succeeds. X allows 100 posts per 15 minutes per user. → { id, text }
  // of the new post.
  async function reply(postId, text, mediaIds = []) {
    const json = { reply: { in_reply_to_tweet_id: String(postId) } };
    if (text) json.text = text; // X: "required unless media is provided"
    if (mediaIds.length) json.media = { media_ids: mediaIds };
    const body = await request("POST", "/tweets", { json });
    if (!body.data || !body.data.id) throw Object.assign(new Error(`X API: no post in the reply's answer: ${JSON.stringify(body).slice(0, 200)}`), { status: 502 });
    await meter.recordAction("replied", hasLink(text) ? "replyLink" : "reply");
    return body.data;
  }

  // The third write: follow or unfollow `targetId` as this user (needs follows.write; the Following extra). Billed per
  // request, recorded once it succeeds. X allows 50 follows per 15 minutes and 400 a day per user; the bulk presses
  // (a thread's "Follow N", the reconciler's unfollow) stay inside that (services/extras.js writesLeft). → { following, pending } (pending: a protected account that must
  // approve).
  async function setFollow(userId, targetId, on) {
    const body = on
      ? await request("POST", `/users/${userId}/following`, { json: { target_user_id: String(targetId) } })
      : await request("DELETE", `/users/${userId}/following/${targetId}`);
    await meter.recordAction(on ? "followed" : "unfollowed", on ? "follow" : "unfollow");
    const d = body.data || {};
    return { following: !!d.following, pending: !!d.pending_follow };
  }

  // A direct message from this user to `participantId` (needs dm.write: ONLY the waitlist's sender, the site's own X
  // account, services/waitlistDms.js; no customer is ever asked for it). POST /2/dm_conversations/with/:id/messages
  // { text } → 201 { dm_conversation_id, dm_event_id } (a spike, docs/WAITLIST-DMS.md). Someone who doesn't
  // take DMs from the sender is a 403 with X's reason on `err.problem` ("dm-recipient-not-accepting"); a refusal is not
  // recorded (unverified whether X bills one). X: 99 per 15 minutes (its headers; the docs say 15) and 1,440 a day.
  // Never retried here (a write); X refuses a repeat as "dm-duplicate". → { eventId, conversationId }
  async function sendDm(participantId, text) {
    const body = await request("POST", `/dm_conversations/with/${participantId}/messages`, { json: { text } });
    const d = body.data || {};
    if (!d.dm_event_id) throw Object.assign(new Error(`X API: no message in the DM's answer: ${JSON.stringify(body).slice(0, 200)}`), { status: 502 });
    await meter.recordAction("messaged", "dm");
    return { eventId: String(d.dm_event_id), conversationId: String(d.dm_conversation_id || "") };
  }

  return { me, usersByIds, userByUsername, postCounts, postsByIds, timelinePage, quotesOf, likedPage, likingUsers, followingPage, setLike, setRepost, setFollow, reply, uploadMedia, sendDm, usage, remainingPosts, remainingContext, remainingUsers };
}

// X's prepaid credit balance in USD (GET /2/usage/credits, with the app owner's user token: services/accounts.js
// readOwnerBalance). Not a billed read (it returns no resources), so it needs no meter.
// → { usd: prepaid + free (unclamped, may go negative: the number spend is measured on), total: X's clamped figure }
async function creditBalance(token) {
  const res = await fetch(`${API}/usage/credits`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.data) {
    const err = new Error(`X API ${res.status} on /usage/credits: ${body.detail || body.title || JSON.stringify(body).slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const d = body.data;
  return { usd: Number(d.prepaid_balance || 0) + Number(d.free_balance || 0), total: Number(d.total_balance || 0) };
}

// ── Live: X's Activity API (docs/LIVE.md; services/live.js runs it) ──
// Subscriptions are per account, made with THAT account's user token: X delivers private events (replies, mentions,
// likes) only for users who authorized the app, and the token's scope must match the event (like.read for like.*,
// tweet.read for post.*, follows.read for follow.*). Creating, listing and deleting them bills nothing (a spike,
// exact balance readings), so they need no meter. The EVENTS are billed: services/live.js records each on
// the account's live unit as it arrives.
async function activityCall(method, path, token, json) {
  const init = { method, headers: { Authorization: `Bearer ${token}` } };
  if (json) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(json);
  }
  const res = await fetch(API + path, init);
  const body = await res.json().catch(() => ({}));
  if (res.ok) return body;
  const detail = body.detail || body.title || JSON.stringify(body).slice(0, 300);
  throw Object.assign(new Error(`X API ${res.status} on ${path}: ${detail}`), { status: res.status, detail });
}
// X answers a create with the subscription nested as data.subscription (the docs' quickstart shows it flat; both read).
const subOf = (s) => (s && s.subscription) || s;
const activity = {
  // This user's subscriptions (the app's, for them). → [{ subscription_id, event_type, filter, tag }]
  async list(token, userId) {
    const body = await activityCall("GET", `/activity/subscriptions?user_id=${encodeURIComponent(userId)}&max_results=1000`, token);
    return (body.data || []).map(subOf);
  },
  // One event type for one user (no expiry: services/live.js keeps the set right). `direction`: X's filter for directional
  // events ("inbound" | "outbound"; none = both). → { subscription_id, event_type, filter }
  async subscribe(token, { eventType, userId, tag, direction = null }) {
    const filter = { user_id: String(userId), ...(direction && { direction }) };
    const sub = subOf((await activityCall("POST", "/activity/subscriptions", token, { event_type: eventType, filter, tag })).data);
    return { filter, ...sub };
  },
  // Takes the user's token or the app's Bearer token (an account that can't sign in any more is cleaned up with the latter).
  async unsubscribe(token, subscriptionId) {
    await activityCall("DELETE", `/activity/subscriptions/${encodeURIComponent(subscriptionId)}`, token);
  },
};

// THE stream: one connection for the whole app, every subscribed account's events on it. Only the app's Bearer token
// opens it. Yields each event's `data` ({ event_uuid, event_type, filter: { user_id }, payload, includes }); returns when
// X closes it or `signal` aborts. `onOpen()` is called once X has accepted the connection. A refusal throws with
// `status`, and `provisioning: true` for X's 503 "ProvisioningSubscription" (a subscription changed in the last ~2
// minutes: try again shortly). No backfill_minutes: pay-per-use is "not authorized" for it, so what's sent while nobody
// is connected is gone (sync catches it up).
async function* activityStream(bearer, { signal, onOpen } = {}) {
  const res = await fetch(`${API}/activity/stream`, { headers: { Authorization: `Bearer ${bearer}` }, signal });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = body.detail || body.title || JSON.stringify(body).slice(0, 300);
    throw Object.assign(new Error(`X activity stream ${res.status}: ${detail}`), { status: res.status, detail, provisioning: body.connection_issue === "ProvisioningSubscription" });
  }
  if (onOpen) onOpen();
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue; // a keep-alive
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        console.error(`[x] activity stream: an unreadable line (${line.slice(0, 120)})`);
        continue;
      }
      if (parsed.data) yield parsed.data;
    }
  }
}

// What an event brought, in the shapes the stores take: the posts (a post event's own post first, then every post in
// includes: what it replies to or quotes, or the liked post), each with its media the way a read's posts get it
// (withMedia), and the users (full profiles of everyone in it). → { posts, users }
function eventContents(data) {
  const p = data.payload || {};
  const own = p.id && p.author_id ? [p] : []; // a post event's payload IS a post; a like's isn't
  const all = [...own, ...((data.includes && data.includes.tweets) || []).filter((t) => t.id !== p.id)];
  // A post that quotes one of the others carries that post's author (Post.quotedAuthorId: a quote of yours is someone
  // talking to you).
  const authorOf = new Map(all.map((t) => [t.id, t.author_id]));
  const withQuoted = all.map((t) => {
    const q = (t.referenced_tweets || []).find((r) => r.type === "quoted");
    return q && authorOf.get(q.id) ? { ...t, quoted_author_id: authorOf.get(q.id) } : t;
  });
  // A follow event carries its two people under payload.source / payload.target (not includes.users).
  const pair = [p.source, p.target].map((u) => u && u.data).filter((u) => u && u.id);
  return { posts: withMedia({ data: withQuoted, includes: data.includes }), users: [...((data.includes && data.includes.users) || []), ...pair] };
}

module.exports = { createClient, creditBalance, ReadCapReached, notFound, endpointOf, windowKey, RATE_RESERVE, reserveFor, SCOPES, pkcePair, authorizeUrl, exchangeCode, refreshTokens, revokeToken, activity, activityStream, eventContents };
