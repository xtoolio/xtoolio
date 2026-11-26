// No network, no database: the security stack and sign-in are actually on (web.js on an in-memory session
// store), the sealing of X tokens holds, and nothing in the views or public JS would need the CSP loosened.
//   npm run verify
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { execFileSync } = require("child_process");

// config insists on these. Placeholders only: nothing here talks to Mongo or X. The two that the assertions
// depend on are set outright (not just defaulted) so a local .env can't change what's being checked.
for (const [k, v] of Object.entries({
  MONGO_URI: "mongodb://127.0.0.1:1/unused",
  X_CLIENT_ID: "verify-client",
  X_CLIENT_SECRET: "verify-secret",
  SESSION_SECRET: "verify-session-secret",
  TOKEN_KEY: crypto.randomBytes(32).toString("base64"),
})) process.env[k] = process.env[k] || v;
process.env.APP_ORIGIN = "http://127.0.0.1:3100";
process.env.ALLOWED_USERNAMES = "Invited_One";
process.env.ADMIN_IDS = "424242"; // the admin is an X user ID (a username changes hands on X)
// The front page checks assume a site that doesn't charge and links no repo (a self-hosted copy), whatever the local
// .env says (a preview once set both, and these checks read that instead).
process.env.METERED_BILLING_ENABLED = "false";
process.env.SOURCE_REPO_URL = "";
// Stripe configured (placeholders, never called: the webhook checks run on signatures made here).
process.env.STRIPE_SECRET_KEY = "sk_test_verify";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_verify";

const session = require("express-session");
const { createApp } = require("../web");
const { createSealer } = require("../lib/crypto");
const { pkcePair, SCOPES } = require("../lib/x");
const { maySignIn, isAdmin } = require("../services/accounts");

// THE ADMIN is decided by X user id, never the handle: an account that renamed itself on X to the admin's (freed) handle
// and signed in again is NOT an admin; the admin's own account is, under any handle.
assert.strictEqual(isAdmin({ _id: "424242", username: "renamed_since" }), true, "the admin's id is an admin under any handle");
assert.strictEqual(isAdmin({ _id: "777", username: "424242" }), false, "a handle that looks like the id isn't");
for (const handle of ["admin_handle", "Admin_Handle"]) assert.strictEqual(isAdmin({ _id: "999", username: handle }), false, `another id is never an admin, whatever its handle (${handle})`);
assert.strictEqual(isAdmin(null), false, "signed out isn't");
assert.throws(() => {
  const saved = process.env.ADMIN_IDS;
  process.env.ADMIN_IDS = "424242,@someone";
  try {
    delete require.cache[require.resolve("../config")];
    require("../config");
  } finally {
    process.env.ADMIN_IDS = saved;
    delete require.cache[require.resolve("../config")];
    require("../config");
  }
}, /ADMIN_IDS takes X user ids/, "a handle in ADMIN_IDS refuses to boot (it would quietly make nobody an admin)");
const { FEATURES, SCOPES_ALL, granted, active } = require("../services/features");
const { FONTS, DEFAULT_FONT, fontFor } = require("../lib/fonts");

const root = path.join(__dirname, "..");
const filesUnder = (dir, ext) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? filesUnder(p, ext) : p.endsWith(ext) ? [p] : [];
  });
// The web app's source: web.js and the routes it mounts (routes/*.js). Every check below that reads "the routes" reads
// all of them, so a route moved out of web.js can't slip past one.
const WEB_SOURCES = [path.join(root, "web.js"), ...filesUnder(path.join(root, "routes"), ".js")];
const webSource = (except = []) => WEB_SOURCES.filter((f) => !except.includes(path.relative(root, f).replace(/\\/g, "/"))).map((f) => fs.readFileSync(f, "utf8")).join("\n");

// ── every live event type the code sends is one the model accepts (LiveEvent.note swallows a refused one) ──
{
  const accepted = require("../models/LiveEvent").schema.path("type").enumValues;
  const sources = [...WEB_SOURCES, ...filesUnder(path.join(root, "services"), ".js"), ...filesUnder(path.join(root, "models"), ".js")];
  const sent = new Set();
  for (const f of sources) for (const m of fs.readFileSync(f, "utf8").matchAll(/LiveEvent\.note\([^,]+,\s*"([a-z-]+)"/g)) sent.add(m[1]);
  assert.ok(sent.size >= 6, `found the note calls (${[...sent].join(", ")})`);
  assert.deepStrictEqual([...sent].filter((t) => !accepted.includes(t)), [], "every LiveEvent.note type is in the model's enum");
}

// ── deleting an account reaches every model keyed by one (services/deleteAccount.js CASCADE) ──
// A model with an `accountId` field that the delete doesn't require would keep that account's rows forever. (Models
// keyed by `_id` = the account, as SyncState, Presence and RateWindow are, can't be found this way: they're named in
// the cascade by hand, and scripts/verify-delete.js seeds every one.)
{
  const del = fs.readFileSync(path.join(root, "services", "deleteAccount.js"), "utf8");
  const missed = filesUnder(path.join(root, "models"), ".js")
    .filter((f) => /^\s*accountId:\s*(\{|String)/m.test(fs.readFileSync(f, "utf8")))
    .map((f) => path.basename(f, ".js"))
    .filter((name) => !del.includes(`require("../models/${name}")`));
  assert.ok(filesUnder(path.join(root, "models"), ".js").length > 20, "found the models");
  assert.deepStrictEqual(missed, [], `models with an accountId that deleting an account doesn't cover (add them to CASCADE in services/deleteAccount.js and seed them in scripts/verify-delete.js): ${missed.join(", ")}`);
}

// ── nothing private in the repo (it's public) ──
// THE PUBLISHED TEXT FILES: tracked AND new ones not yet added (anything .gitignore doesn't exclude: verify runs before
// a commit, and a new file must be checked before it's committed, not after), less a file scripts/release.js replaces
// with release/<path> (CLAUDE.md, the private notebook; release/<path> itself is checked like any other).
const published = (() => {
  let tracked = [];
  try {
    tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
  } catch (_) {} // not a git checkout: nothing is tracked to publish
  return [...new Set(tracked)].filter((rel) => {
    if (/\.(woff2?|png|jpe?g|gif|ico|ttf|lock)$|package-lock\.json$/.test(rel)) return false;
    if (!fs.existsSync(path.join(root, rel))) return false; // deleted in the working tree, not yet committed
    return rel.startsWith("release/") || !fs.existsSync(path.join(root, "release", rel));
  });
})();
// PRIVATE_WORDS in the operator's own .env (comma-separated; never committed, so this file names none of them): the
// operator's other products, real people's names, ids. Any published file containing one fails. Unset: skipped.
{
  const envFile = path.join(root, ".env");
  const line = fs.existsSync(envFile) ? (fs.readFileSync(envFile, "utf8").match(/^PRIVATE_WORDS=(.*)$/m) || [])[1] : "";
  const words = (line || "").split(",").map((w) => w.trim()).filter(Boolean);
  const leaks = [];
  const { notOurs } = require("../lib/secretScan");
  for (const rel of words.length ? published : []) {
    if (notOurs(rel)) continue; // a public dataset's own words (lib/secretScan.js NOT_OURS)
    const text = fs.readFileSync(path.join(root, rel), "utf8").toLowerCase();
    for (const w of words) if (text.includes(w.toLowerCase())) leaks.push(`${rel}: "${w}"`);
  }
  assert.deepStrictEqual(leaks, [], `private words in tracked files (PRIVATE_WORDS in .env):\n  ${leaks.join("\n  ")}`);
}
// NO SECRETS in what's published (lib/secretScan.js: the .env's own secret values exactly, then known secret formats).
// The rule itself first, on samples built here so this file holds none of them.
{
  const { envSecrets, secretsIn } = require("../lib/secretScan");
  const fake = (prefix, n) => prefix + "a1B2".repeat(n).slice(0, n);
  const exact = envSecrets(`SESSION_SECRET=${fake("", 40)}\nMONGO_URI=mongodb+srv://u:${fake("pw", 12)}@c.example/x\nPORT=3100\n`);
  assert.deepStrictEqual(exact.map((e) => e.name), ["SESSION_SECRET", "MONGO_URI", "MONGO_URI's password"], "envSecrets: secret-named settings and a database password");
  assert.deepStrictEqual(secretsIn(`x ${fake("", 40)} y`, exact), ["the value of SESSION_SECRET from .env"], "an exact .env value is found by its name");
  assert.ok(secretsIn(`password=${fake("pw", 12)}`, exact).includes("the value of MONGO_URI's password from .env"), "a database password alone is found");
  for (const [what, sample] of [
    ["a Stripe live key", fake("sk_" + "live_", 24)],
    ["an agent token", fake("xt" + "o_", 43)],
    ["a database address with a password in it", "mongodb+srv://me:" + fake("p", 12) + "@cluster.example/db"],
    ["a private key block", "-----BEGIN " + "RSA PRIVATE KEY-----"],
  ]) assert.ok(secretsIn(sample).includes(what), `secretsIn finds ${what}`);
  for (const ok of ["mongodb+srv://USER:PASS@CLUSTER/xtoolio", "sk_" + "test_verify_only", "whsec_" + "verify"]) assert.deepStrictEqual(secretsIn(ok), [], `a placeholder isn't a secret: ${ok}`);

  const envFile = path.join(root, ".env");
  const mine = fs.existsSync(envFile) ? envSecrets(fs.readFileSync(envFile, "utf8")) : [];
  const found = [];
  for (const rel of published) {
    const hits = secretsIn(fs.readFileSync(path.join(root, rel), "utf8"), mine);
    if (hits.length) found.push(`${rel}: ${hits.join(", ")}`);
  }
  assert.deepStrictEqual(found, [], `a secret in a published file (move it to .env; if it was ever pushed, change the secret itself):\n  ${found.join("\n  ")}`);
}
// NO BUILD TIMELINE in what's published: a comment or doc states a decision and its reason, never when it was made or
// how fast things changed. Dates live in the private notebook and commit messages. Allowed: the test scripts' fixture
// dates (the tests run on them) and the legal pages' effective dates. (The patterns are written so this file doesn't
// match them itself.)
{
  const DATED = [
    [/\b20\d\d-[01]\d-[0-3]\d\b/, (rel) => /^scripts\/verify-[\w-]+\.js$/.test(rel)],
    [/\b(Jan(uary)?|Feb(ruary)?|Mar(ch)?|Apr(il)?|June?|July?|Aug(ust)?|Sep(t(ember)?)?|Oct(ober)?|Nov(ember)?|Dec(ember)?)\.? [0-3]?\d(, 20\d\d)?\b/, (rel) => /^scripts\/verify-[\w-]+\.js$|^views\/(terms|privacy)\.hbs$/.test(rel)],
    [/\b(the same (evening|night|morning|afternoon)|for an\s+hour|an\s+hour (later|after)|later\s+that (night|evening)|that (night|evening)|the evening'?s)\b/i, () => false],
  ];
  const dated = [];
  for (const rel of published) {
    const lines = fs.readFileSync(path.join(root, rel), "utf8").split(/\r?\n/);
    for (const [re, allowed] of DATED) {
      if (allowed(rel)) continue;
      const i = lines.findIndex((l) => re.test(l));
      if (i >= 0) dated.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 100)}`);
    }
  }
  assert.deepStrictEqual(dated, [], `a date or pace word in a published file (state the decision and its reason, never when; the date belongs in the private notebook):\n  ${dated.join("\n  ")}`);
}
// NO POINTER INTO THE PRIVATE NOTEBOOK: the public CLAUDE.md is release/CLAUDE.md, the short guide, so a published file
// citing a CLAUDE.md section ("CLAUDE.md "Run"") points at text that isn't there. Point at the code or a doc instead.
// Allowed: the files that name CLAUDE.md as a file (the README, the release script, this check, the live probe's list).
{
  const NAMES_IT = /^(README\.md|release\/CLAUDE\.md|scripts\/(release|verify-security|probe-live)\.js)$/;
  const cites = published.filter((rel) => !NAMES_IT.test(rel) && fs.readFileSync(path.join(root, rel), "utf8").includes("CLAUDE.md"));
  assert.deepStrictEqual(cites, [], `a published file cites CLAUDE.md, which the public copy replaces with the short guide (point at the code or a doc):\n  ${cites.join("\n  ")}`);
}

// ── views: nothing the strict CSP would block ──
// script-src/style-src 'self' with no 'unsafe-inline' blocks inline <script>, style="", and on*= handlers.
// They'd fail silently in the browser, so catch them here.
for (const file of filesUnder(path.join(root, "views"), ".hbs")) {
  const src = fs.readFileSync(file, "utf8");
  const rel = path.relative(root, file);
  assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>/i.test(src), `${rel}: inline <script> (CSP blocks it; move it to public/js)`);
  assert.ok(!/\sstyle\s*=/i.test(src), `${rel}: inline style= (CSP blocks it; use a class in app.css)`);
  assert.ok(!/\son[a-z]+\s*=/i.test(src), `${rel}: inline on*= handler (CSP blocks it; listen from public/js)`);
  // THE tooltip is data-tip (app.css), never an element's title: the browser's own waits a second and looks like
  // nothing else here (every tooltip is THE tooltip). A partial's `title=` hash argument ({{#> modal title=…}}) isn't an element's, so tags only.
  const tagged = src.replace(/\{\{!--[\s\S]*?--\}\}/g, "").match(/<[a-z][a-z0-9-]*\b[^>]*[\s}]title=/gi); // `}}title=`: after a Handlebars block inside the tag
  assert.ok(!tagged, `${rel}: a title= tooltip (use data-tip, THE tooltip): ${tagged && tagged[0].slice(0, 80)}`);
  for (const m of src.matchAll(/(?:src|href)="(\/(?:js|[^"/]+\.css)[^"]*)"/g)) {
    assert.ok(m[1].includes("?v={{assetV}}"), `${rel}: ${m[1]} has no ?v={{assetV}} (it would never cache-bust)`);
  }
  // No form inside a <p> (directly or through a partial that renders one): the browser closes the paragraph before it
  // and the rest of the line drops below (the person page's ↻ once did).
  for (const para of src.replace(/\{\{!--[\s\S]*?--\}\}/g, "").matchAll(/<p\b[^>]*>((?:(?!<\/p>)[\s\S])*?)<\/p>/gi)) {
    assert.ok(!/<form|\{\{> ?(refresh-profile|switch)\b/.test(para[1]), `${rel}: a form inside a <p> (use a div)`);
  }
  // Every form that POSTs carries the CSRF token.
  for (const form of src.matchAll(/<form[^>]*method="post"[\s\S]*?<\/form>/gi)) {
    assert.ok(form[0].includes('name="_csrf"'), `${rel}: a POST form without the _csrf field`);
  }
  // /auth/x redirects to x.com, and form-action 'self' applies to a form's redirects too: a form there is blocked
  // in the browser (both sign-in and Follows' "Turn on" once were). It must be a link.
  assert.ok(!/<form[^>]*action="\/auth\//i.test(src), `${rel}: a form leading to /auth/x (CSP form-action blocks the hop to x.com; use a link)`);
  // The product's name comes from config (brandName), never typed into a page: a self-hosted copy names itself.
  assert.ok(!/xtool/i.test(src.replace(/\{\{!--[\s\S]*?--\}\}/g, "")), `${rel}: the site's name typed into a page (use {{brandName}})`);
}
for (const file of [...filesUnder(path.join(root, "public", "js"), ".js"), path.join(root, "lib", "notices.js")]) {
  const code = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, ""); // comments aside
  const said = (code.match(/"[^"\n]*"|'[^'\n]*'|`[^`\n]*`/g) || []).filter((s) => /[Xx]tool(?!s[A-Z])/.test(s)); // window.xtoolioToast & co. are names, not words
  assert.deepStrictEqual(said, [], `${path.relative(root, file)}: the site's name in a string a person can read (it's config's brandName)`);
}
// The page's scripts set THE tooltip too (data-tip), never an element's title (document.title is the tab's).
for (const file of filesUnder(path.join(root, "public", "js"), ".js")) {
  const src = fs.readFileSync(file, "utf8");
  assert.ok(!/(?<!document)\.title\s*=|setAttribute\(\s*["']title["']/.test(src), `${path.relative(root, file)}: sets a title= tooltip (use data-tip, THE tooltip)`);
}
// ...and no route a form posts to may redirect there either (routes/auth.js's own GET /auth/x is reached by link).
assert.ok(!/redirect\([^)]*\/auth\/x/.test(webSource(["routes/auth.js"])), "web.js / routes: a route redirects to /auth/x (a form POSTing to it would be blocked by form-action; link to /auth/x instead)");
// The same for the routes that lead to Stripe (a top-up, the auto-refill card): links only, never a redirect target.
for (const door of ["topup", "card"]) {
  for (const file of filesUnder(path.join(root, "views"), ".hbs")) assert.ok(!new RegExp(`<form[^>]*action="/billing/${door}`, "i").test(fs.readFileSync(file, "utf8")), `${path.relative(root, file)}: a form leading to /billing/${door} (form-action blocks the hop to Stripe; use a link)`);
  assert.ok(!new RegExp(`redirect\\([^)]*/billing/${door}`).test(webSource()), `web.js / routes: a route redirects to /billing/${door} (a form posting there would be blocked on the way to Stripe)`);
}
// The signed-in account is loaded ONCE per request with a fixed list of fields (web.js, Account.findById(id, "…")): a
// field read as req.account.<field> that isn't in it is silently undefined. Once `circle` wasn't, so turning
// your circle's public page on saved it, said so in the toast, and the page still drew the switch off with no link.
{
  const web = webSource();
  const listed = new Set(require("../models/Account").REQUEST_FIELDS.split(" ").map((f) => f.split(".")[0]));
  assert.ok(listed.size > 1, "Account.REQUEST_FIELDS: the per-request account projection was found");
  // Both doors load it (a browser's session in web.js, an agent's token in routes/mcp.js), never a list of their own.
  assert.ok(/Account\.findById\(req\.session\.accountId, Account\.REQUEST_FIELDS\)/.test(web), "web.js loads the session's account with Account.REQUEST_FIELDS");
  const read = new Set([...web.matchAll(/req\.account\.([A-Za-z_]+)/g)].map((m) => m[1]));
  const missing = [...read].filter((f) => f !== "_id" && !listed.has(f));
  assert.deepStrictEqual(missing, [], `web.js: req.account.${missing.join(", req.account.")} read but not in the per-request account projection`);
}

// ── every ?n= a route redirects with is a notice that exists (a typo would show nothing, silently) ──
{
  const { NOTICES } = require("../lib/notices");
  const keys = new Set();
  for (const file of WEB_SOURCES) {
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/[?&]n=([a-z]+(?:-[a-z]+)*)(?![-<a-z])/g)) keys.add(m[1]); // a whole key, not "signin-<outcome>" in a comment
    for (const m of src.matchAll(/withNotice\(.*?,\s*"([a-z-]+)"\)/g)) keys.add(m[1]);
    // A notice named straight to a helper: say("…") (the reply route), noticeFor("…") (a JSON answer).
    for (const m of src.matchAll(/\b(?:say|noticeFor)\("([a-z-]+)"/g)) keys.add(m[1]);
    for (const m of src.matchAll(/\?n=\$\{([^}]+)\}/g)) for (const s of m[1].matchAll(/"([a-z-]+)"/g)) keys.add(s[1]);
    // A key picked into a variable first: `let n = "…"` / `n = cond ? "…" : "…"`.
    for (const m of src.matchAll(/\b(?:let |const )?n = ([^;\n]+)/g)) for (const s of m[1].matchAll(/"([a-z-]+)"/g)) if (!/^(OUT_OF_BALANCE|NEEDS_REAUTH)$/.test(s[1])) keys.add(s[1]);
    // xFailure's answers (web.js: why a button that asks X didn't work).
    const xf = src.indexOf("const xFailure = ");
    if (xf >= 0) for (const m of src.slice(xf, src.indexOf("};", xf)).matchAll(/return "([a-z-]+)"/g)) keys.add(m[1]);
  }
  assert.ok(keys.size >= 15, `found the redirects' notice keys (${keys.size})`);
  for (const k of keys) assert.ok(NOTICES[k], `?n=${k} is redirected to but isn't in lib/notices.js`);
}

// ── the one door to X: nothing reads the API except lib/x.js, whose clients need a meter (services/usage.js), so no
// billed read can go unrecorded. (Gitignored scratch isn't scanned.)
for (const file of [...["lib", "services", "routes", "scripts", "models"].flatMap((d) => filesUnder(path.join(root, d), ".js")), path.join(root, "web.js"), path.join(root, "app.js")]) {
  if (file === path.join(root, "lib", "x.js") || file === __filename) continue; // the door itself; this check
  assert.ok(!fs.readFileSync(file, "utf8").includes("api.x.com"), `${path.relative(root, file)}: talks to api.x.com directly (go through lib/x.js, metered)`);
}

// ── private accounts: posts drawn for an account load through ONE rule (services/accountData.js visibleTo) ──
// The pages, the agent's door and the routes never read the shared post store directly: a direct Post.find there would
// draw a private account's post for someone X never showed it to (verify-private checks the rule itself).
for (const file of [...filesUnder(path.join(root, "routes"), ".js"), path.join(root, "web.js"), ...["conversations.js", "agentTools.js"].map((f) => path.join(root, "services", f))]) {
  assert.ok(!/\bPost\.(find|findOne|findById|aggregate)\(/.test(fs.readFileSync(file, "utf8")), `${path.relative(root, file)}: reads posts directly (load them through services/accountData.js: postsById, accountPosts, postsInConversations)`);
}

// ── public JS parses (a parse error in the browser fails silently) ──
for (const file of filesUnder(path.join(root, "public"), ".js")) execFileSync(process.execPath, ["--check", file]);

// ── sealed tokens ──
const sealer = createSealer(process.env.TOKEN_KEY);
const sealed = sealer.seal("access-token-value");
assert.ok(!JSON.stringify(sealed).includes("access-token-value"), "sealed form doesn't contain the token");
assert.strictEqual(sealer.open(sealed), "access-token-value");
assert.notStrictEqual(sealer.seal("same").data, sealer.seal("same").data, "fresh IV every time");
const tampered = { ...sealed, data: Buffer.from(Buffer.from(sealed.data, "base64").map((b, i) => (i === 0 ? b ^ 1 : b))).toString("base64") };
assert.throws(() => sealer.open(tampered), "a tampered token fails GCM's check instead of decrypting to garbage");
assert.throws(() => createSealer(crypto.randomBytes(16).toString("base64")), /32 bytes/, "a wrong-size key is refused at boot");

// ── PKCE + the allowlist ──
const { verifier, challenge } = pkcePair();
assert.strictEqual(challenge, crypto.createHash("sha256").update(verifier).digest("base64url"), "S256 challenge");
assert.ok(maySignIn(false, "invited_one"), "allowlisted (case-insensitive) may create an account");
assert.ok(!maySignIn(false, "stranger"), "anyone else may not");
assert.ok(maySignIn(true, "stranger"), "an existing account can always sign back in");
assert.deepStrictEqual(SCOPES, ["tweet.read", "users.read", "offline.access"], "every sign-in: read-only base scopes (widen deliberately, not by accident)");
// EVERY sign-in asks for the same full set (services/features.js SCOPES_ALL; no half state): the base, the
// modules' reads, and the only writes, liking, following, replying and a reply's pictures: nothing else that writes or touches DMs.
assert.deepStrictEqual([...SCOPES_ALL].sort(), [...SCOPES, "like.read", "follows.read", "like.write", "tweet.write", "follows.write", "media.write"].sort(), "every sign-in: the base, the modules' reads and the four writes");
assert.deepStrictEqual(SCOPES_ALL.filter((s) => !s.endsWith(".read") && s !== "offline.access").sort(), ["follows.write", "like.write", "media.write", "tweet.write"], "no write but like.write, follows.write, tweet.write and media.write");
// FEEDBACK is checked as input on the server (routes/feedback.js cleanText), whatever the browser sent: a field sent
// twice (an array) or nothing is refused, control characters and bidi overrides are dropped, too long is refused (never
// cut short), line endings normalised, blank runs capped; the box's maxlength is the same limit.
{
  const { cleanText, TEXT_MAX } = require("../routes/feedback");
  assert.deepStrictEqual(cleanText(["a", "b"]), { refuse: "feedback-empty" }, "feedback: a field sent twice is refused");
  assert.deepStrictEqual(cleanText(undefined), { refuse: "feedback-empty" }, "feedback: no text is refused");
  assert.deepStrictEqual(cleanText(" \r\n\t \u0000 "), { refuse: "feedback-empty" }, "feedback: only blanks and control characters is refused");
  assert.deepStrictEqual(cleanText("a\u0000b\u001b[2Jc‮d\r\ne"), { text: "ab[2Jcd\ne" }, "feedback: control characters and bidi overrides dropped, \\r\\n → \\n");
  assert.deepStrictEqual(cleanText("a\n\n\n\n\n\nb"), { text: "a\n\n\nb" }, "feedback: blank runs capped");
  assert.deepStrictEqual(cleanText("x".repeat(TEXT_MAX)), { text: "x".repeat(TEXT_MAX) }, "feedback: exactly the limit is kept whole");
  assert.deepStrictEqual(cleanText("x".repeat(TEXT_MAX + 1)), { refuse: "feedback-long" }, "feedback: one past the limit is refused, not cut");
  assert.ok(cleanText("<script>alert(1)</script>").text === "<script>alert(1)</script>", "feedback: markup is kept as typed (escaped where it's shown)");
  assert.strictEqual(TEXT_MAX, require("../models/Feedback").TEXT_MAX, "feedback: the route's limit is the model's");
  // Its SCREENSHOTS: typed by their own bytes (an SVG, which can carry script, or anything named .png isn't an image
  // here), at most SHOTS_MAX, each at most SHOT_BYTES; the notices say the model's numbers.
  const { checkShots } = require("../routes/feedback");
  const { SHOTS_MAX, SHOT_BYTES } = require("../models/FeedbackShot");
  const png = (n = 64) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n)]);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  assert.deepStrictEqual(checkShots([{ buffer: png() }]).shots.map((s) => s.mime), ["image/png"], "feedback shots: a PNG by its bytes is kept");
  assert.deepStrictEqual(checkShots([{ buffer: svg, originalname: "shot.png", mimetype: "image/png" }]), { refuse: "feedback-shot-type" }, "feedback shots: an SVG named .png is refused");
  assert.deepStrictEqual(checkShots(Array.from({ length: SHOTS_MAX + 1 }, () => ({ buffer: png() }))), { refuse: "feedback-shot-many" }, "feedback shots: one past the limit is refused");
  assert.deepStrictEqual(checkShots([{ buffer: png(SHOT_BYTES) }]), { refuse: "feedback-shot-big" }, "feedback shots: past the size is refused");
  assert.deepStrictEqual(checkShots(undefined), { shots: [] }, "feedback shots: none is fine");
  const { noticeFor } = require("../lib/notices");
  assert.ok(noticeFor("feedback-shot-many").text.includes(String(SHOTS_MAX)) && noticeFor("feedback-shot-big").text.includes(`${SHOT_BYTES / 1024 / 1024} MB`), "feedback shots: the notices say the model's limits");
}
// DMs: ONE grant ever holds dm.write, the site's own account's (SITE_X: the waitlist's DM sender, services/waitlistDms.js),
// asked by features.SCOPES_SITE = a customer's scopes + dm.write and nothing else; never a customer's sign-in or a
// waitlister's join. SCOPES_SITE is named only where it's defined and in the callback that sends the site's account
// (accounts.isSiteAccount) back for it; anywhere else "dm.write" may only be READ off a grant (hasScope / grantHas).
{
  const { SCOPES_JOIN, SCOPES_SITE } = require("../services/features");
  assert.deepStrictEqual(SCOPES_SITE, [...SCOPES_ALL, "dm.write"], "the site's account asks for a customer's scopes and dm.write, nothing else");
  assert.ok(![...SCOPES_ALL, ...SCOPES_JOIN].some((s) => s.startsWith("dm.")), "no customer sign-in and no waitlist join asks for a DM scope");
  const { isSiteAccount, hasScope } = require("../services/accounts");
  const { siteX } = require("../config");
  assert.ok(isSiteAccount({ username: String(siteX || "").toUpperCase() }) === !!siteX && !isSiteAccount({ username: "someone" }) && !isSiteAccount(null), "isSiteAccount: SITE_X in any case, nobody else");
  assert.ok(hasScope("tweet.read dm.write", "dm.write") && !hasScope("tweet.read dm.writer", "dm.write") && !hasScope(undefined, "dm.write"), "hasScope: whole scopes only");
  for (const file of [...["lib", "services", "routes"].flatMap((d) => filesUnder(path.join(root, d), ".js")), path.join(root, "web.js")]) {
    const rel = path.relative(root, file).replace(/\\/g, "/");
    const src = fs.readFileSync(file, "utf8");
    if (rel !== "services/features.js") assert.ok(!/["']dm\.(write|read)["']/.test(src.replace(/\b(hasScope|grantHas)\([^()]*["']dm\.write["']\)/g, "")), `${rel}: asks X for a DM scope (only features.SCOPES_SITE may)`);
    if (!["services/features.js", "routes/auth.js"].includes(rel)) assert.ok(!/\bSCOPES_SITE\b/.test(src.replace(/\/\/.*$/gm, "")), `${rel}: uses SCOPES_SITE (only the sign-in callback, for the site's account)`);
  }
}
// Pictures is its own add-on: without media.write (an account from before it) text replies still work.
const noMedia = inboxOnlyOf(SCOPES_ALL.filter((s) => s !== "media.write"));
assert.ok(active(noMedia, "replying") && !active(noMedia, "pictures"), "no media.write: replies yes, pictures no");
assert.ok(active(inboxOnlyOf(SCOPES_ALL), "pictures"), "every scope: pictures with the Inbox");
function inboxOnlyOf(scopes) {
  return { tokens: { scope: scopes.join(" ") }, features: { inbox: { on: true } } };
}
assert.deepStrictEqual(SCOPES_ALL, [...new Set([...SCOPES, ...Object.values(FEATURES).flatMap((f) => f.scopes)])], "every feature's scope is in it");
// An add-on has no switch: it's active inside a module that shows it (services/features.js `needs`), when granted.
const all = { tokens: { scope: SCOPES_ALL.join(" ") } };
const inboxOnly = { ...all, features: { inbox: { on: true } } };
assert.ok(active(inboxOnly, "liking") && active(inboxOnly, "replying") && active(inboxOnly, "liveReplies"), "the Inbox brings the ♥, the reply box and live replies (no Likes module needed: decision 1)");
assert.ok(!active(inboxOnly, "following"), "but not the Follow button (Follows or People draw it)");
assert.ok(!active({ ...all, features: { likes: { on: true } } }, "liking"), "the Likes module alone draws no ♥");
assert.ok(!active({ ...inboxOnly, tokens: { scope: "tweet.read users.read like.write" } }, "liking"), "not without like.read (an account from before every scope was asked for)");
assert.ok(active({ ...all, features: { follows: { on: true } } }, "following") && !active({ ...all, features: { follows: { on: true } } }, "liveReplies"), "Follows brings the Follow button, not live replies");
assert.ok(!active({ ...all, features: { liking: { on: true } } }, "liking"), "an old add-on flag alone turns nothing on");
assert.ok(granted({ tokens: { scope: "tweet.read like.read" } }, "likes") && !granted({ tokens: { scope: "tweet.read" } }, "likes"));

// ── the real app ──
const rawGet = (port, pathname, headers) =>
  new Promise((resolve, reject) => http.get({ host: "127.0.0.1", port, path: pathname, headers }, (res) => resolve(res.resume() && res)).on("error", reject));

(async () => {
  const app = createApp({ sessionStore: new session.MemoryStore() });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const res = await fetch(`${base}/healthz`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get("x-powered-by"), null, "no X-Powered-By");

    const csp = res.headers.get("content-security-policy") || "";
    const directive = (name) => (csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) || "").split(/\s+/).slice(1);
    assert.deepStrictEqual(directive("script-src"), ["'self'"], "scripts: first-party only");
    assert.deepStrictEqual(directive("style-src"), ["'self'"], "styles: first-party only");
    assert.deepStrictEqual(directive("img-src"), ["'self'", "data:", "https://pbs.twimg.com"], "images: us + X's avatar CDN, nothing broader");
    assert.deepStrictEqual(directive("media-src"), ["https://video.twimg.com"], "media: X's GIF videos only (partials/media-pic.hbs), nothing broader");
    assert.deepStrictEqual(directive("form-action"), ["'self'"]);
    assert.ok(!csp.includes("unsafe-inline") && !csp.includes("unsafe-eval"), "no unsafe-* anywhere");

    const pp = res.headers.get("permissions-policy") || "";
    for (const f of ["camera", "microphone", "geolocation", "payment"]) assert.ok(pp.includes(`${f}=()`), `Permissions-Policy turns off ${f}`);
    assert.ok(res.headers.get("ratelimit-policy"), "rate limit headers present for signed-out traffic");
    assert.ok(!res.headers.getSetCookie().some((c) => c.startsWith("xt.sid=")), "a signed-out request creates no session");

    // Signed out: the landing page; everything else sends you there.
    const home = await fetch(`${base}/`);
    assert.strictEqual(home.status, 200);
    const homeHtml = await home.text();
    assert.ok(/<a class="signin" href="(\/auth\/x" data-browser-tz|\/waitlist")>/.test(homeHtml), "signed-out home: the call to action is a link (to sign-in, timezone.js adds ?tz=; or, sign-up closed, to the waitlist page)");
    // Billing is off here, as on a self-hosted copy: no markup, no estimator, no "Fund your account" (untrue where
    // nobody is charged).
    assert.ok(!/plus \d+%|<h2 class="section">Prices<\/h2>|Fund your account|What a month typically costs|What it costs you|class="waterfall"/.test(homeHtml), "billing off: the front page shows no pricing");
    // No SOURCE_REPO_URL here: nothing links to a repo that may not be public yet.
    assert.ok(!homeHtml.includes("The code is public") && !/>Code<\/a>/.test(homeHtml), "no SOURCE_REPO_URL: no code section, no footer Code link");
    // The hero is THE TOUR (services/demo.js): each use case a label for its own radio, each radio a page drawn by the
    // real partials on invented data, all of them inside one inert block (nothing in them can be pressed).
    const tourAt = homeHtml.indexOf('<div class="tour-slides" inert>');
    const tour = tourAt >= 0 ? homeHtml.slice(tourAt, homeHtml.indexOf("<footer", tourAt)) : "";
    const tourKeys = [...homeHtml.matchAll(/<input type="radio" class="tour-pick" name="tour" id="tour-(\w+)"/g)].map((m) => m[1]);
    const labelled = [...homeHtml.matchAll(/<label for="tour-(\w+)">/g)].map((m) => m[1]);
    const slides = [...tour.matchAll(/data-slide="(\w+)"/g)].map((m) => m[1]);
    const caseKeys = require("../services/demo").TOUR_CASES.map((c) => c.key);
    assert.ok(tourKeys.join() === caseKeys.join() && labelled.join() === tourKeys.join() && slides.join() === tourKeys.join(), `signed-out home: every use case labelling its radio and its page (${tourKeys} / ${labelled} / ${slides})`);
    assert.ok((tour.match(/data-inbox-card/g) || []).length === 4 && tour.includes("Maya Okafor") && tour.includes("data-thread-follow") && !tour.includes('class="msg-draft"') && (tour.match(/class="pcard /g) || []).length === 16 && tour.includes("Tagged 6×") && tour.includes('class="circle-board g-classic cz-3"'), "signed-out home: the tour's pages are the real partials (4 Inbox cards: two on the Inbox, the thread on its two screens; no agent drafts: MCP isn't pictured; the thread line, 16 people rows: Follows, Not following back, Who they tag, Your people; the circle), inert");
    // Light by default (lib/theme.js); the front page's button flips it to dark, remembered in a cookie that holds only
    // light / dark (a forged value renders the default), and the button then offers the way back.
    assert.ok(homeHtml.includes('data-theme="light"') && /aria-label="Switch to dark mode"/.test(homeHtml), "signed out: light by default, the button offers dark");
    // Sign-up closed here (ALLOWED_USERNAMES above): the header's quiet "Sign in" and THE call to action, "Join the
    // waitlist" (services/waitlist.js), both LINKS to /auth/x; the hero's button says the same.
    assert.ok(/<header class="top">[\s\S]*<a class="top-signin" href="\/auth\/x" data-browser-tz>Sign in<\/a><a class="signin signin-sm" href="\/waitlist">Join the waitlist<\/a>[\s\S]*<\/header>/.test(homeHtml), "signed out, sign-up closed: Sign in (the full sign-in) and Join the waitlist (the waitlist page) in the header, links");
    assert.ok(/<a class="signin" href="\/waitlist">Join the waitlist<\/a>/.test(homeHtml) && !/>Get started<\/a>/.test(homeHtml), "signed out, sign-up closed: the hero's call to action is Join the waitlist, to the page that explains it");
    // THE WAITLIST PAGE explains it before anyone joins, then its own Join with X asks X only who you are (?join=1).
    const wl = await fetch(`${base}/waitlist`, { redirect: "manual" });
    const wlHtml = await wl.text();
    assert.ok(wl.status === 200 && wlHtml.includes("<h1>Join the waitlist</h1>") && wlHtml.includes('class="waitlist-steps"') && /<a class="signin" href="\/auth\/x\?join=1" data-browser-tz>Join the waitlist with X<\/a>/.test(wlHtml), "the waitlist page: how it works, then Join the waitlist with X (?join=1)");
    assert.ok(/<header class="top">[\s\S]*href="\/#agent"[\s\S]*<\/header>/.test(homeHtml) && homeHtml.includes('id="agent"'), "the header's agent goes to Bring your own agent");
    const csrfCookie = home.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("xt.csrf=")) || "";
    const csrfField = (homeHtml.match(/name="_csrf" value="([^"]+)"/) || [])[1];
    const flip = await fetch(`${base}/theme`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: csrfCookie }, body: `_csrf=${encodeURIComponent(csrfField)}&back=/terms` });
    const themeCookie = (flip.headers.getSetCookie().find((c) => c.startsWith("xt.theme=")) || "").split(";")[0];
    assert.deepStrictEqual([flip.status, flip.headers.get("location"), themeCookie], [303, "/terms", "xt.theme=dark"], "signed out, the button sets dark and goes back");
    const dim = await (await fetch(`${base}/`, { headers: { cookie: themeCookie } })).text();
    assert.ok(dim.includes('data-theme="dark"') && /aria-label="Switch to light mode"/.test(dim), "the cookie's theme renders, and the button offers light");
    assert.ok((await (await fetch(`${base}/`, { headers: { cookie: "xt.theme=auto" } })).text()).includes('data-theme="light"'), "a cookie value it may not hold renders the default");
    const person = await fetch(`${base}/people/123`, { redirect: "manual" });
    assert.deepStrictEqual([person.status, person.headers.get("location")], [302, "/"], "a person page needs sign-in");

    // Live (docs/LIVE.md): the SSE stream and the like line need sign-in; the hub hands a row ONLY to its own
    // account's tabs. Seeded for account A alone, so a hub that delivered to everyone (or to nobody) fails here.
    for (const p of ["/live", "/posts/1/likes-line"]) {
      const r = await fetch(`${base}${p}`, { redirect: "manual" });
      assert.deepStrictEqual([r.status, r.headers.get("location")], [302, "/"], `${p} needs sign-in`);
    }
    const { createHub } = require("../services/livePush");
    const hub = createHub();
    const got = { a: [], b: [], a2: [] };
    hub.add("111", (row) => got.a.push(row.type));
    const removeA2 = hub.add("111", (row) => got.a2.push(row.type));
    hub.add("222", (row) => got.b.push(row.type));
    hub.publish({ accountId: "111", type: "like", data: { postId: "9" } });
    removeA2();
    hub.publish({ accountId: "111", type: "inbox", data: {} });
    assert.deepStrictEqual(got, { a: ["like", "inbox"], b: [], a2: ["like"] }, "a row reaches its own account's open tabs, never another account's; a closed tab gets nothing more");
    hub.broadcast({ type: "status", data: { live: true } });
    assert.deepStrictEqual([got.a.length, got.b.length], [3, 1], "whether X's stream is up goes to everyone");

    // A POST without the CSRF token is refused before any route runs (lib/csrf.js: csrf-csrf, session-bound).
    const post = await fetch(`${base}/sync`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "back=/" });
    assert.strictEqual(post.status, 403, "POST /sync without a CSRF token is refused");
    // A real token only works with the cookie it was made for: not alone, not with another browser's cookie, not with
    // a cookie an attacker made up, not altered. (The theme flip above is the accepted case.)
    const otherBrowser = await fetch(`${base}/terms`);
    const otherCookie = otherBrowser.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("xt.csrf=")) || "";
    const tryTheme = (cookie, token) => fetch(`${base}/theme`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: `_csrf=${encodeURIComponent(token)}&back=/` }).then((r) => r.status);
    assert.ok(otherCookie && otherCookie !== csrfCookie, "each browser gets its own CSRF token");
    assert.deepStrictEqual(
      [await tryTheme(null, csrfField), await tryTheme(otherCookie, csrfField), await tryTheme("xt.csrf=" + "a".repeat(64) + "." + "b".repeat(64), "a".repeat(64) + "." + "b".repeat(64)), await tryTheme(csrfCookie, csrfField + "x")],
      [403, 403, 403, 403],
      "a token without its cookie, with another browser's cookie, a made-up pair, or altered: refused"
    );

    // COOKIE TOSSING: the token is bound to the login session. An attacker gets a valid pair from their own visit
    // (signed out, or signed in as themselves) and plants it in a victim's browser: the victim's session refuses it.
    // Checked on the module itself (a signed-in request here would need the database for its account lookup).
    {
      const { csrfProtection } = require("../lib/csrf");
      const csrf = csrfProtection({ key: "verify-key" });
      const reqFor = (sessionID, accountId) => ({ method: "POST", headers: {}, cookies: {}, body: {}, sessionID, session: accountId ? { accountId } : {} });
      const mint = (req) => {
        const res = { cookie: (name, value) => (req.cookies[name] = value) };
        return csrf.generateCsrfToken(req, res);
      };
      const victimWith = (pair) => ({ ...reqFor("victim-session", "victim"), cookies: { [csrf.cookieName]: pair }, body: { _csrf: pair } });
      const attackerSignedIn = reqFor("attacker-session", "attacker");
      const attackerSignedOut = reqFor("anon-1", null);
      const own = reqFor("victim-session", "victim");
      const ownToken = mint(own);
      assert.deepStrictEqual(
        [csrf.validateRequest({ ...own, body: { _csrf: ownToken } }), csrf.validateRequest(victimWith(mint(attackerSignedIn))), csrf.validateRequest(victimWith(mint(attackerSignedOut)))],
        [true, false, false],
        "a token works in its own session; one minted in the attacker's session, or signed out, is refused in the victim's"
      );
      assert.deepStrictEqual([csrf.sessionOf(attackerSignedOut), csrf.sessionOf(own)], ["", "victim-session:victim"], "signed out binds to nothing; signed in, to the login session and its active account");
      // THE ACCOUNT SWITCHER (lib/sessionAccounts.js): the SAME browser session, switched to another account in another
      // tab. A page still drawn for the first account presses with its token: refused, never acted on as the second.
      const switched = { ...reqFor("victim-session", "victim-second"), cookies: { [csrf.cookieName]: ownToken }, body: { _csrf: ownToken } };
      assert.strictEqual(csrf.validateRequest(switched), false, "a page drawn for one account can't press as another the browser switched to");
      // THE COUNT (routes/pages.js navSums / countOf): the window title's "(N)" and each other account's number in the
      // switcher are the sidebar's counts added up: the Inbox, Posts (Likes), Follows and Media; a module that's off
      // counts nothing; one fading on its own page (`clearing`, seen) is out of it.
      const { countOf, navFor, navSums, modulesOf } = require("../routes/pages");
      const on = { on: true, since: new Date(0) };
      const busy = { _id: "1", features: { inbox: on, likes: on, follows: on }, inboxOwed: 5, likesUnseen: 2, followsUnseen: 1, mediaSeenAt: new Date(1000), mediaSaved: [{ at: new Date(2000) }, { at: new Date(500) }] };
      assert.strictEqual(countOf(busy), 9, "THE COUNT: inbox 5 + posts 2 + follows 1 + media 1");
      assert.strictEqual(countOf({ ...busy, features: { inbox: on } }), 6, "a module that's off counts nothing (its stored count stays out)");
      const nav = navFor(busy, modulesOf(busy), "likes");
      nav.items.find((i) => i.key === "likes").badge.clearing = true;
      assert.deepStrictEqual(navSums(nav.items), { total: 7, dot: true }, "the count fading on its own page is seen: out of the title");
      assert.strictEqual(csrfProtection({ key: "k", production: true }).cookieName.startsWith("__Host-"), true, "production's cookie is __Host- (no subdomain can set it)");
    }

    // Stripe's webhook is mounted BEFORE CSRF and the body parsers: a forged signature is a 400 (not CSRF's 403), and
    // a real signature over the exact bytes verifies (the raw body reached it untouched). Another app's event (a plain
    // "topup" kind) is acknowledged and ignored.
    const hook = (body, sig) => fetch(`${base}/stripe/webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": sig }, body });
    const event = JSON.stringify({ id: "evt_verify", type: "invoice.paid", data: { object: { id: "in_verify", metadata: { kind: "topup" } } } });
    assert.strictEqual((await hook(event, "t=1,v1=forged")).status, 400, "a forged webhook signature is refused, before CSRF");
    const signed = require("stripe").webhooks.generateTestHeaderString({ payload: event, secret: process.env.STRIPE_WEBHOOK_SECRET });
    const ok = await hook(event, signed);
    assert.deepStrictEqual([ok.status, await ok.json()], [200, { received: true }], "a signed event verifies over the raw body; a foreign kind is ignored");

    // /mcp (routes/mcp.js) is mounted BEFORE CSRF and the cookie session: an agent's POST with no token is a 401 asking
    // for one (not CSRF's 403), a token of the wrong shape is refused before the database is asked (none here), the
    // answers are JSON-RPC, and there are no CORS headers (a web page elsewhere can't read it). The token → account
    // path itself needs the database, so it isn't checked here.
    const rpc = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
    const mcp = (headers = {}, method = "POST") => fetch(`${base}/mcp`, { method, headers: { "content-type": "application/json", accept: "application/json, text/event-stream", origin: "https://evil.example", ...headers }, ...(method === "POST" && { body: JSON.stringify(rpc) }) });
    const bare = await mcp();
    assert.strictEqual(bare.status, 401, "/mcp with no token is a 401, before CSRF");
    assert.match(bare.headers.get("www-authenticate") || "", /^Bearer /, "/mcp's 401 says a bearer token is what it takes");
    assert.strictEqual((await bare.json()).jsonrpc, "2.0", "/mcp answers JSON-RPC");
    assert.ok(!bare.headers.get("access-control-allow-origin"), "/mcp sends no CORS headers");
    for (const token of ["nope", "xto_short", `xto_${"a".repeat(43)}!`]) assert.strictEqual((await mcp({ authorization: `Bearer ${token}` })).status, 401, `/mcp refuses a token of the wrong shape (${token.slice(0, 12)})`);
    assert.strictEqual((await mcp({ cookie: home.headers.get("set-cookie") || "" })).status, 401, "/mcp ignores cookies: a browser session isn't a token");
    assert.strictEqual((await mcp({}, "GET")).status, 405, "/mcp has no stream to open (stateless)");
    // SIGN-IN FOR AGENT APPS (services/agentOAuth.js, the SDK's endpoints): a 401 points at the protected-resource
    // document, which names /mcp and its authorization server, whose metadata offers registration and PKCE (S256 only).
    // The approve page is a signed-in form like any other: no CSRF token, no answer.
    assert.match(bare.headers.get("www-authenticate") || "", /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource\/mcp"/, "/mcp's 401 points at its protected-resource document");
    const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.ok(/\/mcp$/.test(prm.resource) && prm.authorization_servers.length === 1, "the protected-resource document names /mcp and one authorization server");
    const asMeta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    assert.deepStrictEqual([asMeta.code_challenge_methods_supported, asMeta.grant_types_supported, !!asMeta.registration_endpoint], [["S256"], ["authorization_code", "refresh_token"], true], "the authorization server: PKCE S256, codes and refresh, registration");
    assert.strictEqual((await fetch(`${base}/oauth/approve`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "r=x&answer=approve", redirect: "manual" })).status, 403, "Approve without a CSRF token is refused");
    assert.ok((await (await fetch(`${base}/oauth/approve?r=not-a-request`)).text()).includes("This link has expired"), "an unknown approve link says it's expired");
    // WHERE AN APP MAY SEND PEOPLE BACK (agentOAuth placeOf): https, http on this computer, a listed app's own scheme.
    // A scheme that hands the address to a web page (intent://, x-safari-https://) let an app named "Claude" receive
    // the code on any site while the page said only "intent://": refused at registration, before anything is stored.
    {
      const { placeOf } = require("../services/agentOAuth");
      const cases = {
        "https://claude.ai/api/mcp/auth_callback": "claude.ai",
        "https://claude.ai.evil.example/cb": "claude.ai.evil.example", // shown whole: the lookalike is visible
        "http://127.0.0.1:53682/callback": "an app on this computer",
        "http://localhost:3000/cb": "an app on this computer",
        "cursor://anysphere.cursor-mcp/oauth/callback": "cursor://",
        "http://evil.example/cb": "",
        "intent://evil.example/cb#Intent;scheme=https;end": "",
        "x-safari-https://evil.example/cb": "",
        "claude.ai://cb": "",
        "googlechromes://evil.example/cb": "",
        "not a url": "",
      };
      for (const [uri, place] of Object.entries(cases)) assert.strictEqual(placeOf(uri), place, `placeOf(${uri})`);
      for (const uri of ["intent://evil.example/cb#Intent;scheme=https;end", "x-safari-https://evil.example/cb", "http://evil.example/cb"]) {
        const reg = await fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [uri] }) });
        const body = await reg.json();
        assert.deepStrictEqual([reg.status, body.error], [400, "invalid_client_metadata"], `registering ${uri} is refused`);
      }
    }
    {
      const { BACK } = require("../routes/auth");
      const ok = "/oauth/approve?r=" + "a".repeat(32);
      assert.deepStrictEqual([ok, "//evil.example", "https://evil.example", `${ok}&x=1`, "/settings"].map((b) => BACK.test(b)), [true, false, false, false, false], "sign-in lands back only on an approve page (no open redirect)");
    }
    {
      // Admin → P&L's status word, by THE app's own rules (the out-of-money case depends on billing being on: not here).
      const { statusOf } = require("../routes/admin");
      const on = { features: { inbox: { on: true } } };
      const day = 864e5;
      assert.deepStrictEqual(
        [{ ...on, needsReauth: true }, { ...on, pause: { at: new Date(), why: "you" } }, { features: {} }, on, { ...on, pause: { at: new Date(Date.now() - 2 * day), why: "balance" }, balanceMicros: 5e6 }].map((a) => statusOf(a).label),
        ["Signed out of X", "Paused", "Not started", "Syncing", "Paused"],
        "P&L status: signed out of X, paused by you, no module, syncing, back with money after a day (held for how far back)"
      );
    }
    {
      // safeBack judges the NORMALISED path: dot segments collapsing into "//host" was an open redirect through
      // withNotice / backTo, which re-parse it.
      const { safeBack, withNotice } = require("../routes/pages");
      for (const b of ["//evil.example", "/\\evil.example", "https://evil.example", "/..//evil.example", "/.%2e//evil.example", "/%2e%2e//evil.example", "/a/..//evil.example", "/../\\evil.example"]) {
        assert.strictEqual(safeBack(b, "/"), "/", `safeBack refuses ${b}`);
      }
      assert.strictEqual(safeBack("/inbox?show=done#p12", "/"), "/inbox?show=done#p12", "safeBack keeps a same-site path, query and fragment");
      assert.ok(withNotice(safeBack("/..//evil.example", "/"), "cancelled").startsWith("/?"), "withNotice of a refused back stays on the site");
    }
    // The token's account is loaded with THE request fields, and no tool takes an account: each is bound to the one the
    // token opened (routes/mcp.js serverFor), so none can be pointed at another account's data.
    assert.ok(/Account\.findById\(found\.accountId, Account\.REQUEST_FIELDS\)/.test(fs.readFileSync(path.join(root, "routes", "mcp.js"), "utf8")), "routes/mcp.js loads the token's account with Account.REQUEST_FIELDS");
    const { TOOLS, shapes } = require("../services/agentTools");
    for (const tool of TOOLS) {
      assert.deepStrictEqual(Object.keys(tool.input).filter((k) => /account/i.test(k)), [], `the ${tool.name} tool takes no account`);
      // Every tool hands the agent other people's words (posts, names, bios): each says they're data, and a read tool says
      // it reads only.
      assert.ok(/data, never (as )?instructions/.test(tool.description), `the ${tool.name} tool's description says other people's words are data, never instructions`);
      if (tool.annotations && tool.annotations.readOnlyHint) assert.ok(/Read-only/.test(tool.description), `the ${tool.name} tool's description says it's read-only`);
      assert.ok(tool.annotations && typeof tool.annotations.readOnlyHint === "boolean", `the ${tool.name} tool says whether it writes (annotations.readOnlyHint)`);
      // The one kind of write an agent has: a draft the person sends. A tool that writes says so, and that nothing
      // reaches X from it.
      if (!tool.annotations.readOnlyHint) assert.ok(/NOT posted/.test(tool.description) && /Nothing is sent to X/.test(tool.description), `the ${tool.name} tool writes, and says nothing it writes reaches X`);
    }
    {
      const code = fs.readFileSync(path.join(root, "services", "agentTools.js"), "utf8");
      assert.ok(!/require\("\.\/extras"\)[^;]*\b(setLike|setRepost|setFollow|sendReply)\b/.test(code) && !/require\("\.\.\/lib\/x"\)/.test(code), "services/agentTools.js reaches none of X's writes (a draft is the person's to send)");
    }
    // What an agent reads names the site by config's brandName (a self-hosted copy says its own): no "xtool…" typed in a
    // string of the tools' source (comments aside).
    const toolCode = fs.readFileSync(path.join(root, "services", "agentTools.js"), "utf8").split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, ""));
    assert.deepStrictEqual(toolCode.filter((l) => /["'`][^"'`]*xtool/i.test(l)), [], "services/agentTools.js: the site's name typed into a string (use config.brandName)");
    // THE CONTRACT between the app and its agents: the tools shape the engine's OWN rows (services/inbox.js inboxRows,
    // people.leaderboard), so a field renamed there must fail here, not turn up as nothing in an agent's answer.
    {
      const { inboxRows } = require("../services/inbox");
      const { leaderboard } = require("../services/people");
      const ME = "1";
      const THEM = "2";
      const at = (d) => new Date(`2026-11-${d}T12:00:00Z`);
      const box = [
        { _id: "100", authorId: ME, conversationId: "100", text: "my post", createdAt: at(10), stream: "own" },
        { _id: "101", authorId: THEM, conversationId: "100", inReplyToUserId: ME, referenced: [{ type: "replied_to", id: "100" }], text: "@me a reply to it", mentions: [{ id: ME, username: "me", start: 0, end: 3 }], createdAt: at(11), stream: "mention" },
        { _id: "102", authorId: THEM, conversationId: "102", text: "hey @me", mentions: [{ id: ME, username: "me", start: 4, end: 7 }], createdAt: at(12), stream: "mention" },
      ];
      const profiles = new Map([[THEM, { _id: THEM, username: "them", name: "Them Person", followers: 12 }]]);
      const rows = inboxRows(box, ME, { byId: new Map(box.map((p) => [p._id, p])), profiles, likesKnown: false });
      const card = shapes.cardOf(rows.find((r) => r.conversationId === "100"));
      assert.strictEqual(card.conversation, "100", "contract: a card's conversation id");
      assert.strictEqual(card.status, "waiting", "contract: its status");
      assert.deepStrictEqual([card.about.by, card.about.text], ["you", "my post"], "contract: what it's about, and that it's yours");
      assert.deepStrictEqual(card.owed, [{ person: { id: THEM, name: "Them Person", handle: "@them" }, like: 0, reply: 1 }], "contract: who's owed what (likes unknown: replies only)");
      assert.strictEqual(card.waiting.length, 1, "contract: their message still waiting");
      const w = card.waiting[0];
      assert.deepStrictEqual([w.id, w.from.handle, w.text, w.replying_to, w.owes], ["101", "@them", "a reply to it", "100", { like: false, reply: true }], "contract: a waiting message's who, words (the @-prefix stripped), parent and what it owes");
      assert.ok(w.at && w.on_x === "https://x.com/them/status/101", "contract: when, and where it opens on X");
      assert.strictEqual(shapes.message(rows[0].order.find((v) => v.fromMe) || { ...rows[0].order[0], fromMe: true }).from, "you", "contract: your own post is from you");
      const tagged = shapes.cardOf(rows.find((r) => r.conversationId === "102"));
      assert.ok(tagged.note, "contract: a card that only tags you says why it's here");
      const [person] = leaderboard(box, ME, profiles);
      const facts = shapes.personFacts(person, { likes: { you: false, them: false }, follows: false });
      assert.deepStrictEqual([facts.id, facts.name, facts.handle, facts.they_replied, facts.followers], [THEM, "Them Person", "@them", 2, 12], "contract: a person's facts (a reply and a mention: both them to you)");
      assert.ok(!("you_liked_theirs" in facts) && !("follows_you" in facts), "contract: likes and follows are left out where they aren't read");
      // A draft rides on the message it answers, only while that message owes a reply (services/inbox.js draftOf).
      const drafts = new Map([["101", { text: "on it, & more", by: "Claude" }], ["100", { text: "never drawn: it's yours" }]]);
      const drafted = inboxRows(box, ME, { byId: new Map(box.map((p) => [p._id, p])), profiles, likesKnown: false, drafts });
      const dw = shapes.cardOf(drafted.find((r) => r.conversationId === "100")).waiting[0];
      assert.deepStrictEqual([dw.draft.text, dw.draft.by], ["on it, & more", "Claude"], "contract: a waiting message carries its draft");
      const dv = drafted.find((r) => r.conversationId === "100").order.find((v) => v.id === "101").draft;
      assert.strictEqual(dv.onX, "https://x.com/intent/post?in_reply_to=101&text=on%20it%2C%20%26%20more", "a draft's On X link carries its words, encoded");
      assert.ok(!drafted.find((r) => r.conversationId === "100").topic[0].draft, "contract: your own post (the seed) never carries a draft");
      const handled = inboxRows(box, ME, { byId: new Map(box.map((p) => [p._id, p])), profiles, likesKnown: false, drafts, marks: new Map([["100", "101"]]) });
      assert.ok(!handled.find((r) => r.conversationId === "100").order.find((v) => v.id === "101").draft, "contract: a message marked done draws no draft");
      // Your posts as the agent reads them (services/likes.js postRows, `quiet`: replies that drew nothing too).
      const { postRows } = require("../services/likes");
      const mine = [{ _id: "200", authorId: ME, conversationId: "150", inReplyToUserId: THEM, referenced: [{ type: "replied_to", id: "150" }], text: "@them sure thing", mentions: [{ id: THEM, username: "them", start: 0, end: 5 }], createdAt: at(13), stream: "own" }];
      assert.strictEqual(postRows(mine, { meId: ME, profiles }).length, 0, "Your posts' page lists no reply that drew nothing");
      const [row] = postRows(mine, { meId: ME, profiles, quiet: true });
      const yp = shapes.yourPost(row, new Map([["150", { author: { id: THEM, username: "them", profile: profiles.get(THEM) }, segments: [{ text: "can you send it?" }], media: [] }]]), false);
      assert.deepStrictEqual([yp.id, yp.kind, yp.text, yp.replying_to.person.handle, yp.replying_to.text, yp.replies], ["200", "reply", "sure thing", "@them", "can you send it?", 0], "contract: a reply of yours, and what it answered");
      assert.ok(!("likes" in yp), "contract: likes on your posts are left out where they aren't read");
    }
    // Terms and Privacy are public, and state the billing rules with config's own numbers (policy follows code).
    const terms = await fetch(`${base}/terms`);
    const termsHtml = await terms.text();
    const cfg = require("../config");
    assert.strictEqual(terms.status, 200, "Terms render signed out");
    // Billing is off here (a copy that doesn't charge): §4 says so in one line, and neither page names Stripe.
    const privacyRes = await fetch(`${base}/privacy`);
    const privacyHtml = await privacyRes.text();
    assert.strictEqual(privacyRes.status, 200, "Privacy renders signed out");
    assert.ok(/doesn’t charge for its use/.test(termsHtml) && !/prepaid balance\b.*There’s no subscription/.test(termsHtml) && !/Stripe/.test(termsHtml) && !/Stripe/.test(privacyHtml), "billing off: the Terms say it doesn't charge, and neither page names Stripe");
    // Where the site charges, the same template states the billing rules with config's own numbers.
    {
      const legalOn = { charges: true, entity: "Example Inc.", depositUsd: cfg.billing.depositUsd, refillThresholdUsd: (cfg.billing.autoRefillThresholdCents / 100).toFixed(0), markupPct: 50, markupCapUsd: 50, markupAfterPct: 15, bulkPct: 15 };
      const on = await require("express-handlebars").create(require("../lib/hbs")).render(path.join(root, "views", "terms.hbs"), { brandName: "Example", legal: legalOn });
      assert.ok(on.includes(`at least $${cfg.billing.depositUsd} before its first sync`) && on.includes(`$${cfg.billing.autoRefillThresholdCents / 100} or below`) && /non-refundable/.test(on) && /syncing pauses/.test(on) && /Stripe/.test(on), "billing on: the Terms state the deposit, the refill line, non-refundable, the pause and Stripe, from config");
    }
    const topup = await fetch(`${base}/billing/topup?amount=25`, { redirect: "manual" });
    assert.deepStrictEqual([topup.status, topup.headers.get("location")], [302, "/"], "a top-up needs sign-in");
    // The Admin page (routes/admin.js) is a 404 to anyone but an admin, signed out included; sending feedback needs
    // sign-in (and the global CSRF check, as every POST).
    assert.strictEqual((await fetch(`${base}/admin`, { redirect: "manual" })).status, 404, "signed out: /admin doesn't exist");
    assert.strictEqual((await fetch(`${base}/admin?tab=waitlist`, { redirect: "manual" })).status, 404, "signed out: the waitlist's admin tab doesn't exist");
    // A POST can't be tried signed out (CSRF refuses it first), so every admin route is checked in the source: each one
    // the router declares takes adminOnly before its handler (an Invite lets someone in).
    {
      const src = fs.readFileSync(path.join(root, "routes", "admin.js"), "utf8");
      const routes = [...src.matchAll(/router\.(get|post|put|delete|use)\(([^,]+),\s*([A-Za-z]+)/g)];
      assert.ok(routes.length >= 6, "routes/admin.js: its routes are found");
      for (const r of routes) assert.strictEqual(r[3], "adminOnly", `routes/admin.js: ${r[1]} ${r[2]} is admins only`);
    }

    // Sign-in hands off to X with PKCE + state + the exact registered callback, and pins a session for the return.
    const start = await fetch(`${base}/auth/x?tz=America%2FNew_York`, { redirect: "manual" });
    assert.strictEqual(start.status, 302);
    const to = new URL(start.headers.get("location"));
    assert.strictEqual(to.origin + to.pathname, "https://x.com/i/oauth2/authorize");
    assert.strictEqual(to.searchParams.get("redirect_uri"), "http://127.0.0.1:3100/auth/x/callback");
    assert.strictEqual(to.searchParams.get("code_challenge_method"), "S256");
    assert.ok(to.searchParams.get("code_challenge") && to.searchParams.get("state"), "challenge + state present");
    assert.strictEqual(to.searchParams.get("scope"), SCOPES_ALL.join(" "), "every sign-in asks for every scope");
    // Joining the waitlist asks X only who you are: no write, no offline access (features.SCOPES_JOIN).
    const joining = new URL((await fetch(`${base}/auth/x?join=1`, { redirect: "manual" })).headers.get("location"));
    assert.strictEqual(joining.searchParams.get("scope"), "tweet.read users.read", "Join the waitlist asks X for tweet.read and users.read only");
    const cookie = (start.headers.getSetCookie().find((c) => c.startsWith("xt.sid=")) || "").split(";")[0];
    assert.ok(cookie, "the session that holds the verifier is set");

    // A callback with someone else's state (or none) never reaches X.
    const forged = await fetch(`${base}/auth/x/callback?code=abc&state=not-the-state`, { redirect: "manual", headers: { cookie } });
    assert.strictEqual(forged.headers.get("location"), "/?n=signin-expired", "a wrong state is refused");
    const replay = await fetch(`${base}/auth/x/callback?code=abc&state=${to.searchParams.get("state")}`, { redirect: "manual", headers: { cookie } });
    assert.strictEqual(replay.headers.get("location"), "/?n=signin-expired", "the pending sign-in is single-use (the forged try consumed it)");
    const denied = await fetch(`${base}/auth/x/callback?error=access_denied`, { redirect: "manual" });
    assert.strictEqual(denied.headers.get("location"), "/?n=signin-cancelled");

    // THE toast: ?n=<key> shows that notice on any page (here the signed-out landing); an unknown key shows nothing,
    // and nothing from the URL is echoed.
    const toasted = await (await fetch(`${base}/?n=signin-failed`)).text();
    assert.ok(/class="toast error" role="alert" data-toast>\s*<span>X didn(’|'|&#x27;)t finish the sign-in\. Try again\.<\/span>/.test(toasted), "?n= shows its notice as the toast, an error one as an alert");
    const unknown = await (await fetch(`${base}/?n=%3Cscript%3E`)).text();
    assert.ok(!unknown.includes("data-toast") && !unknown.includes("<script>"), "an unknown ?n= shows nothing");

    // One hostname: localhost goes to APP_ORIGIN (where the cookie and the callback live).
    const other = await rawGet(port, "/people/1", { host: `localhost:${port}` });
    assert.deepStrictEqual([other.statusCode, other.headers.location], [301, "http://127.0.0.1:3100/people/1"]);

    // THE LOOK stylesheet is generated from lib/fonts.js and lib/accents.js: a face, a data-font rule and a preview class
    // per font, every face self-hosted; per accent, its light tokens, its dark tokens both ways app.css switches (the
    // system's dark under auto, and data-theme="dark") and its swatch; an unknown choice falls back to the default.
    const css = await (await fetch(`${base}/look.css?v=test`)).text();
    for (const f of FONTS) {
      assert.ok(css.includes(`url("${f.href}")`) && f.href.startsWith(`/fonts/${f.file}?v=`) && css.includes(`[data-font="${f.key}"]`), `look.css covers ${f.name}`);
      assert.ok(fs.existsSync(path.join(root, "public", "fonts", f.file)), `${f.file} is actually in public/fonts`);
    }
    assert.strictEqual(fontFor("comic-sans").key, DEFAULT_FONT);
    const { ACCENTS, accentFor, DEFAULT_ACCENT } = require("../lib/accents");
    for (const a of ACCENTS) {
      const ok = css.includes(`:root[data-accent="${a.key}"] { --accent: ${a.light.accent};`) && css.includes(`:root:not([data-theme="light"])[data-accent="${a.key}"] { --accent: ${a.dark.accent};`) && css.includes(`:root[data-theme="dark"][data-accent="${a.key}"] { --accent: ${a.dark.accent};`) && css.includes(`.swatch-${a.key} {`);
      assert.ok(ok, `look.css covers the ${a.name} accent, light and dark`);
    }
    assert.strictEqual(accentFor("neon").key, DEFAULT_ACCENT);
    assert.strictEqual(DEFAULT_FONT, "dm-sans");

    // Versioned static files are served (the immutable cache itself only switches on with NODE_ENV=production).
    const js = await fetch(`${base}/js/images.js?v=test`);
    assert.strictEqual(js.status, 200);
  } finally {
    server.close();
  }
  console.log("verify-security: all checks pass");
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
