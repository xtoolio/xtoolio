// `npm run probe:live` — what an attacker sees of https://xtoolio.com from outside, after every deploy (docs/DEPLOY.md).
// READ-ONLY: GETs, plus a few POSTs that must be refused before they do anything (no CSRF token, no Stripe signature).
// ~45 requests, under the 120/min signed-out limit. Ports (only 22 / 80 / 443), TLS (1.2+, 1.3 offered), headers (CSP
// without unsafe-*, HSTS, no framing, no versions), files that must never be served (.env, .git, sources, path tricks),
// signed-in pages signed out (no account data), forged requests, the public pages' promises (the code link answers),
// and errors without stack traces. Its first run found: nginx's version showed (server_tokens), and the server's .env
// carried a development placeholder SOURCE_REPO_URL (a "Read the code" link to a repo that didn't exist yet).
// The site: the first argument, else `https://` + SITE_DOMAIN from .env (default xtoolio.com). Its address is looked up,
// never written here (everything tracked may become public).
"use strict";
require("dotenv").config({ quiet: true });
const net = require("net");
const tls = require("tls");
const dns = require("dns").promises;

const BASE = (process.argv[2] || `https://${process.env.SITE_DOMAIN || "xtoolio.com"}`).replace(/\/+$/, "");
const HOST = new URL(BASE).hostname;
let IP = null;
const results = [];
const note = (ok, what, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "OK  " : "FAIL"} ${what}${detail ? `  (${detail})` : ""}`);
};
const get = (path, opts = {}) => fetch(BASE + path, { redirect: "manual", ...opts });

function portOpen(port, ms = 4000) {
  return new Promise((resolve) => {
    const s = net.connect({ host: IP, port });
    const done = (open) => {
      s.destroy();
      resolve(open);
    };
    s.setTimeout(ms, () => done(false));
    s.on("connect", () => done(true));
    s.on("error", () => done(false));
  });
}
function tlsVersion(maxVersion) {
  return new Promise((resolve) => {
    const s = tls.connect({ host: HOST, port: 443, servername: HOST, minVersion: "TLSv1", maxVersion }, () => {
      const v = s.getProtocol();
      s.end();
      resolve(v);
    });
    s.on("error", () => resolve(null));
    s.setTimeout(8000, () => {
      s.destroy();
      resolve(null);
    });
  });
}

(async () => {
  IP = (await dns.lookup(HOST, { family: 4 })).address;
  console.log(`probing ${BASE} (${IP})`);
  console.log("── PORTS (only 22, 80, 443 should answer)");
  for (const [port, name] of [[22, "ssh"], [80, "http"], [443, "https"], [3100, "the app directly"], [27017, "mongodb"], [9615, "pm2 web"], [8080, "alt http"], [3000, "dev server"]]) {
    const open = await portOpen(port);
    note([22, 80, 443].includes(port) ? open : !open, `port ${port} (${name}) ${open ? "open" : "closed"}`);
  }

  console.log("── TLS");
  note((await tlsVersion("TLSv1.1")) === null, "TLS 1.0 / 1.1 refused");
  note((await tlsVersion("TLSv1.3")) === "TLSv1.3", "TLS 1.3 offered");

  console.log("── HEADERS on the front page");
  const home = await get("/");
  const h = (k) => home.headers.get(k);
  note(home.status === 200, "front page 200");
  note(!!h("content-security-policy") && !/unsafe-/.test(h("content-security-policy")), "CSP, no unsafe-*");
  note(/max-age=\d{7,}/.test(h("strict-transport-security") || ""), "HSTS", h("strict-transport-security"));
  note(h("x-content-type-options") === "nosniff", "X-Content-Type-Options nosniff");
  note(/frame-ancestors 'none'|frame-ancestors 'self'/.test(h("content-security-policy") || "") || !!h("x-frame-options"), "can't be framed (clickjacking)");
  note(!!h("referrer-policy"), "Referrer-Policy", h("referrer-policy"));
  note(!!h("permissions-policy"), "Permissions-Policy");
  note(!h("x-powered-by"), "no X-Powered-By");
  note(!/\d/.test(h("server") || ""), "Server header without a version", h("server") || "none");

  console.log("── FILES that must not be served (404 or redirect, never the file)");
  for (const p of ["/.env", "/.env.example", "/.git/config", "/.git/HEAD", "/package.json", "/package-lock.json", "/ecosystem.config.js", "/app.js", "/web.js", "/config/index.js", "/node_modules/express/package.json", "/tmp/app.log", "/scripts/shot.js", "/CLAUDE.md", "/docs/DEPLOY.md", "/deploy/nginx-xtoolio.conf", "/../.env", "/%2e%2e/.env", "/js/../../.env", "/server-status", "/.well-known/security.txt"]) {
    const r = await get(p);
    const body = r.status === 200 ? await r.text() : "";
    const leaked = r.status === 200 && /MONGO_URI|TOKEN_KEY|"dependencies"|\[core\]|module\.exports|require\(/.test(body);
    note(!leaked && r.status !== 200, `${p} → ${r.status}`);
  }

  console.log("── SIGNED-IN pages without signing in (must bounce, never show data)");
  for (const p of ["/settings", "/usage", "/usage/rows", "/people", "/posts", "/follows", "/follows/back", "/media", "/media/library", "/live", "/people/circle", "/posts/1/likes-line"]) {
    const r = await get(p);
    const body = r.status === 200 ? await r.text() : "";
    // Signed out, a module page draws the front page (its demo Inbox has invented posts): account data is the signed-in
    // header (you, your counts, your balance) or a live stream.
    const data = r.status === 200 && /data-me=|data-header-balance|data-me-v|event: status/.test(body);
    note(!data, `${p} → ${r.status}${r.headers.get("location") ? ` → ${r.headers.get("location")}` : ""}`);
  }

  console.log("── FORGED REQUESTS (must be refused before acting)");
  const form = (body) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  for (const p of ["/theme", "/sync", "/posts/1/like", "/inbox/done", "/inbox/like-all", "/people/1/follow", "/follows/back/unfollow", "/billing/autorefill"]) {
    const r = await get(p, form("on=1"));
    note(r.status === 403 || r.status === 401 || (r.status >= 300 && r.status < 400 && /\/auth|\/$/.test(r.headers.get("location") || "")), `POST ${p} without a CSRF token → ${r.status}`);
  }
  const wh = await get("/stripe/webhook", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=forged" }, body: "{}" });
  note(wh.status === 400 || wh.status === 503, `Stripe webhook with a forged signature → ${wh.status}`);

  console.log("── PROMISES the public pages make (each must be true on this deployment)");
  const front = await (await get("/")).text();
  const repo = (front.match(/href="(https:\/\/github\.com\/[^"]+)"/) || [])[1];
  if (repo) {
    const r = await fetch(repo, { redirect: "manual" });
    note(r.status === 200, `the front page's code link answers (${repo} → ${r.status})`);
  } else note(true, "no code link on the front page (SOURCE_REPO_URL unset)");
  const terms = await (await get("/terms")).text();
  const dm = (terms.match(/a DM to <a href="https:\/\/x\.com\/([A-Za-z0-9_]+)"/) || [])[1];
  note(!!dm, `Terms say whom to DM about an account (CONTACT_X)`, dm ? `@${dm}` : "unset: \"reach us on X\"");
  if (dm) {
    const r = await fetch(`https://x.com/${dm}`, { redirect: "manual" });
    note(r.status === 200, `x.com/${dm} exists → ${r.status}`);
  }

  console.log("── ERRORS don't leak internals");
  const bad = await get("/people/%E0%A4%A");
  const badBody = await bad.text();
  note(!/at .*\.js:\d+|node_modules|Error:/.test(badBody), `a malformed URL → ${bad.status}, no stack trace`);

  const failed = results.filter((ok) => !ok).length;
  console.log(failed ? `\n${failed} to look at` : `\nall ${results.length} checks ok`);
})();
