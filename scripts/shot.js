// DEV ONLY. Screenshot the REAL running app, signed in, with its real CSP: mint a session for the first account
// through the app's own Mongo session store (destroyed after), sign its cookie with SESSION_SECRET, drive headless
// Edge over CDP (Node's built-in WebSocket), set the cookie, and capture each URL × theme × width. Reports console
// errors (CSP violations show up there) and kills only the Edge it started (by its profile dir, never every
// msedge.exe). Start the app first (`npm start`).
//
// The theme is applied INSIDE the headless page (<html data-theme> + the emulated color scheme), never by writing
// Account.theme: it once did, and every page the person loaded during a run came back in whatever theme the
// script had set ("why does light/dark flip?"). It writes nothing to the account.
//   SHOT_OUT=<dir> node scripts/shot.js     (default: tmp/shots)
//   SHOT_ONLY=settings,landing node scripts/shot.js     (only shots whose name contains one of these)
//   SHOT_URL=/people/<id>/c/<conv> node scripts/shot.js (one page: light + phone dark; SHOT_SIGNED_OUT=1 as a visitor)
//   SHOT_JS="document.querySelector('.liked').scrollIntoView()" node scripts/shot.js
//                                                       (run in the page before each shot: a scroll, the rows
//                                                        layout; in the page only, never a write to the account)
//   SHOT_ACCOUNT=<account id> node scripts/shot.js      (signed in as that account instead of the first one: the
//                                                        owner never sees billing, so a customer's pages need one)
//   SHOT_PERSON=<X user id> node scripts/shot.js        (whose page the person shots show; default: whom the
//                                                        account replies to most)
//   SHOT_WAIT=<ms>                                      (how long after SHOT_JS before the shot; default 400)
//   SHOT_W=<px>                                         (SHOT_URL's desktop shot width; default 1200: a big
//                                                        monitor is 1920 or 2560)
//   SHOT_PROBE="<expression>"                           (evaluated in the page after the wait; its value is printed:
//                                                        an in-page test reads back a toast, a button's state)
//   SHOT_WAITLIST=<X user id> SHOT_URL=/waitlist         (the session holds that waitlist place and no account: the
//                                                        waiting page as that sign-in sees it)
require("dotenv").config({ quiet: true });
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, execSync } = require("child_process");
const mongoose = require("mongoose");
const signature = require("cookie-signature");
const config = require("../config");
const { connect } = require("../lib/db");
const Account = require("../models/Account");

const OUT = process.env.SHOT_OUT || path.join(__dirname, "..", "tmp", "shots");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PROFILE = path.join(os.tmpdir(), "xtoolio-cdp-profile");
const BASE = config.appOrigin;
const SHOTS = [
  { name: "inbox-light", url: "/", theme: "light", w: 1200, h: 1100 },
  { name: "inbox-laptop-dark", url: "/?show=all", theme: "dark", w: 1512, h: 1000 }, // the rail beside the cards
  { name: "inbox-phone-dark", url: "/", theme: "dark", w: 390, h: 1000, mobile: true },
  { name: "board-light", url: "/people", theme: "light", w: 1440, h: 1100 },
  { name: "board-dark", url: "/people", theme: "dark", w: 1440, h: 1100 },
  { name: "board-sorted-dark", url: "/people?sort=followers&q=a", theme: "dark", w: 1440, h: 900 },
  { name: "board-phone-dark", url: "/people", theme: "dark", w: 390, h: 1000, mobile: true },
  // {person}: SHOT_PERSON=<X user id>, else the person this account replies to most (found below, never hard-coded).
  { name: "person-dark", url: "/people/{person}", theme: "dark", w: 1440, h: 1000 },
  { name: "person-light", url: "/people/{person}", theme: "light", w: 1440, h: 1000 },
  { name: "person-phone-dark", url: "/people/{person}", theme: "dark", w: 390, h: 1000, mobile: true },
  { name: "person-phone-light", url: "/people/{person}", theme: "light", w: 390, h: 1000, mobile: true },
  // "@convo:<person path>": open that person's table and follow its first conversation link.
  { name: "convo-dark", url: "@convo:/people/{person}", theme: "dark", w: 1200, h: 900 },
  { name: "convo-light", url: "@convo:/people/{person}", theme: "light", w: 1200, h: 900 },
  { name: "convo-phone-dark", url: "@convo:/people/{person}", theme: "dark", w: 390, h: 900, mobile: true },
  { name: "settings-dark", url: "/settings", theme: "dark", w: 1200, h: 1100 },
  { name: "settings-light", url: "/settings", theme: "light", w: 1200, h: 1100 },
  // Signed out (no cookie): the landing page, in the browser's own scheme.
  { name: "landing-light", url: "/", signedOut: true, theme: "light", w: 1200, h: 3000 },
  { name: "landing-dark", url: "/", signedOut: true, theme: "dark", w: 1200, h: 3000 },
  { name: "landing-phone-light", url: "/", signedOut: true, theme: "light", w: 390, h: 4000, mobile: true },
].filter((s) => !process.env.SHOT_ONLY || process.env.SHOT_ONLY.split(",").some((part) => s.name.includes(part)));
// SHOT_URL=/people/<id>/c/<conv>: just that page, light, and a phone in both themes. SHOT_SIGNED_OUT=1: as a visitor
// (the front page with a query, say).
if (process.env.SHOT_URL) {
  const signedOut = !!process.env.SHOT_SIGNED_OUT;
  const h = Number(process.env.SHOT_H || 1100);
  SHOTS.splice(0, SHOTS.length, { name: "url-light", url: process.env.SHOT_URL, signedOut, theme: "light", w: Number(process.env.SHOT_W || 1200), h }, { name: "url-phone-dark", url: process.env.SHOT_URL, signedOut, theme: "dark", w: 390, h, mobile: true }, { name: "url-phone-light", url: process.env.SHOT_URL, signedOut, theme: "light", w: 390, h, mobile: true });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const mongooseConn = await connect(config);
  const acct = await Account.findOne(process.env.SHOT_ACCOUNT ? { _id: process.env.SHOT_ACCOUNT } : {}, "_id").lean();
  if (!acct) throw new Error(`no account ${process.env.SHOT_ACCOUNT || ""}`);
  // The person the person/conversation shots show: SHOT_PERSON, else whom this account replies to most.
  if (SHOTS.some((s) => s.url.includes("{person}"))) {
    let person = process.env.SHOT_PERSON;
    if (!person) {
      const [top] = await require("../models/Post").aggregate([
        { $match: { authorId: acct._id, inReplyToUserId: { $nin: [null, acct._id] } } },
        { $group: { _id: "$inReplyToUserId", n: { $sum: 1 } } },
        { $sort: { n: -1 } },
        { $limit: 1 },
      ]);
      person = top && top._id;
    }
    if (!person) throw new Error("no person to shoot: set SHOT_PERSON=<X user id>");
    for (const s of SHOTS) s.url = s.url.replace("{person}", person);
  }

  // A session in the app's own store, so the app accepts it exactly as if X had signed us in.
  const MongoStoreImport = require("connect-mongo");
  const MongoStore = MongoStoreImport.default || MongoStoreImport;
  const store = MongoStore.create({ client: mongooseConn.connection.getClient(), collectionName: "sessions", ttl: 3600 });
  const sid = crypto.randomBytes(24).toString("base64url");
  await new Promise((res, rej) => store.set(sid, { cookie: { originalMaxAge: 3600000, expires: new Date(Date.now() + 3600000), httpOnly: true, path: "/" }, ...(process.env.SHOT_WAITLIST ? { waitlist: process.env.SHOT_WAITLIST } : { accountId: acct._id }) }, (e) => (e ? rej(e) : res())));
  const cookieValue = "s:" + signature.sign(sid, config.sessionSecret);

  fs.rmSync(PROFILE, { recursive: true, force: true });
  const edge = spawn(EDGE, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--user-data-dir=${PROFILE}`, "--remote-debugging-port=0", "about:blank"], { stdio: "ignore" });
  let port;
  for (let i = 0; i < 50 && !port; i++) {
    await sleep(200);
    try { port = fs.readFileSync(path.join(PROFILE, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch (_) {}
  }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

  await cdp("Network.enable");
  await cdp("Page.enable");
  const consoleErrors = [];
  await cdp("Runtime.enable");
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") consoleErrors.push(m.params.args.map((a) => a.value).join(" "));
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error") consoleErrors.push(m.params.entry.text);
  });
  await cdp("Log.enable");

  try {
    for (const s of SHOTS) {
      if (s.signedOut) await cdp("Network.deleteCookies", { name: "xt.sid", url: BASE });
      else await cdp("Network.setCookie", { name: "xt.sid", value: cookieValue, url: BASE, httpOnly: true });
      // The shot's theme, in this browser only: the system scheme (for "auto") ...
      await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: s.theme || "light" }] });
      await cdp("Emulation.setDeviceMetricsOverride", { width: s.w, height: s.h, deviceScaleFactor: 1, mobile: !!s.mobile });
      let url = BASE + s.url;
      if (s.url.startsWith("@convo:")) {
        await cdp("Page.navigate", { url: BASE + s.url.slice(7) });
        await sleep(2000);
        const r = await cdp("Runtime.evaluate", { expression: "(document.querySelector('.about-link') || {}).href || ''", returnByValue: true });
        url = r.result.result.value || url;
      }
      await cdp("Page.navigate", { url });
      await sleep(2500);
      // ... and the page's own <html data-theme>, which a pinned account theme would otherwise override.
      if (s.theme) {
        await cdp("Runtime.evaluate", { expression: `document.documentElement.setAttribute("data-theme", ${JSON.stringify(s.theme)})` });
        await sleep(200);
      }
      // SHOT_JS=<expression>: run in the page before the shot (open a modal, switch a layout). In the page only:
      // like the theme above, never a write to the account.
      if (process.env.SHOT_JS) {
        await cdp("Runtime.evaluate", { expression: process.env.SHOT_JS });
        await sleep(Number(process.env.SHOT_WAIT) || 400); // SHOT_WAIT=<ms>: longer, for an animation it sets off
      }
      // SHOT_PROBE=<expression>: evaluated in the page after SHOT_JS and the wait; its value is printed (what a test of
      // an in-page behaviour reads back: a toast's text, a button's state).
      if (process.env.SHOT_PROBE) {
        const r = await cdp("Runtime.evaluate", { expression: process.env.SHOT_PROBE, returnByValue: true });
        console.log(`probe ${s.name}:`, JSON.stringify(r.result && r.result.result ? r.result.result.value : r.result));
      }
      const shot = await cdp("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(OUT, `${s.name}.png`), Buffer.from(shot.result.data, "base64"));
      console.log("shot", s.name);
    }
  } finally {
    await new Promise((r) => store.destroy(sid, r));
    ws.close();
    edge.kill();
    await sleep(500);
    // Kill anything left from THIS profile only (never all of msedge.exe).
    try {
      execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='msedge.exe'\\" | Where-Object { $_.CommandLine -like '*xtoolio-cdp-profile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`, { stdio: "ignore" });
    } catch (_) {}
    await mongoose.disconnect();
  }
  console.log(consoleErrors.length ? `console errors:\n  ${consoleErrors.join("\n  ")}` : "no console errors (CSP violations would show here)");
})().catch((e) => { console.error(e); process.exit(1); });
