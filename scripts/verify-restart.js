// `npm run verify:restart` — THE RESTART, for real (app.js, lib/shutdown.js, lib/lease.js), the way `pm2 reload` does
// it: real processes, the real database, X's real stream, pm2's own "shutdown" message (Windows has no SIGINT between
// processes; pm2 sends this there). Run it when you touch any of those, with the local app STOPPED (it holds the lease
// and the stream). Costs a catch-up sync or two (a few cents of X reads); takes about a minute (X takes ~20 s to accept
// a stream connection).
//   LEASE: on a throwaway name (deleted after): one holder at a time; a dead process on this machine is taken over at
//     once; another machine's holder waits for the lapse; a lapsed one is taken.
//   WORKER: A runs; B starts beside it, its X stream opens (ready), its duties wait for the lease; A is told to stop:
//     A halts X, drains, stops its duties, releases the lease, B's duties start, A closes its stream and exits. After:
//     X's stream still marked connected (B's connection, not cleared by A's goodbye), B holds the lease.
//   WEB: one copy on PORT 3199 with an open /live and a slow page in flight; told to stop: the page still answers
//     200, the /live gets "retry" and ends, and the process exits.
// First run: A handed over in 0.4 s; B's interrupted catch-up stopped "for a restart" with progress saved.
"use strict";
require("dotenv").config({ quiet: true });
const { fork } = require("child_process");
const crypto = require("crypto");
const path = require("path");
const mongoose = require("mongoose");
const signature = require("cookie-signature");
const config = require("../config");

const APP = path.join(__dirname, "..", "app.js");
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start(name, env) {
  const child = fork(APP, [], { env: { ...process.env, ...env }, silent: true });
  const lines = [];
  const seen = (re) => lines.some((l) => re.test(l));
  for (const s of [child.stdout, child.stderr]) {
    s.on("data", (d) => String(d).split("\n").filter(Boolean).forEach((l) => { lines.push(l); console.log(`  ${at()} [${name}] ${l}`); }));
  }
  let ready = false;
  child.on("message", (m) => { if (m === "ready") { ready = true; console.log(`  ${at()} [${name}] → ready`); } });
  const exited = new Promise((r) => child.on("exit", (code) => { console.log(`  ${at()} [${name}] exited ${code}`); r(code); }));
  return { child, lines, seen, isReady: () => ready, exited };
}
async function until(cond, what, ms = 90000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
  console.log(`${at()} ✓ ${what}`);
}

(async () => {
  await mongoose.connect(config.mongoUri);
  const LiveState = require("../models/LiveState");
  const Lease = require("../models/Lease");
  const checks = [];
  const check = (ok, what) => { checks.push([ok, what]); console.log(`${at()} ${ok ? "PASS" : "FAIL"} ${what}`); };

  // ── THE LEASE ──
  const { tryTake } = require("../lib/lease");
  const os = require("os");
  const name = `verify-lease-${Date.now()}`;
  const host = os.hostname();
  try {
    check((await tryTake(name, `${host}:${process.pid}:a`)) === true, "lease: free, taken");
    check((await tryTake(name, `${host}:${process.pid}:b`)) === false, "lease: held by a live process, not taken");
    await Lease.updateOne({ _id: name }, { $set: { holder: `${host}:999999:x`, until: new Date(Date.now() + 60e3) } });
    check((await tryTake(name, `${host}:${process.pid}:c`)) === true, "lease: held by a dead process on this machine, taken at once");
    await Lease.updateOne({ _id: name }, { $set: { holder: "other-host:1:x", until: new Date(Date.now() + 60e3) } });
    check((await tryTake(name, `${host}:${process.pid}:d`)) === false, "lease: another machine's holder waits for the lapse");
    await Lease.updateOne({ _id: name }, { $set: { until: new Date(Date.now() - 1) } });
    check((await tryTake(name, `${host}:${process.pid}:e`)) === true, "lease: lapsed, taken");
  } finally {
    await Lease.deleteOne({ _id: name });
  }

  // ── WORKER HANDOVER ──
  const worker = { PROC_ROLE: "worker", SCHEDULER_ENABLED: "true" };
  const A = start("A", worker);
  await until(() => A.isReady() && A.seen(/scheduler:/), "A connected to X and holds the lease");
  const B = start("B", worker);
  await until(() => B.isReady(), "B's stream accepted beside A's (pm2 would stop A now)");
  check(!B.seen(/scheduler:/) && B.seen(/waiting for the previous worker/), "B's duties wait while A holds the lease");
  const stopAt = Date.now();
  A.child.send("shutdown");
  await A.exited;
  console.log(`${at()} A took ${Date.now() - stopAt} ms to hand over`);
  await until(() => B.seen(/scheduler:/), "B's duties started after A let go");
  await sleep(1500);
  const st = await LiveState.findById("stream").lean();
  check(!!(st && st.connectedAt), "X's stream is still marked connected (A's goodbye didn't clear B's mark)");
  const lease = await Lease.findById("worker").lean();
  check(!!(lease && lease.holder.includes(String(B.child.pid))), "B holds the worker lease");
  B.child.send("shutdown");
  await B.exited;
  check(!(await Lease.findById("worker").lean()), "B let go of the lease on its way out");

  // ── WEB DRAIN ──
  const MongoStoreImport = require("connect-mongo");
  const MongoStore = MongoStoreImport.default || MongoStoreImport;
  const store = MongoStore.create({ client: mongoose.connection.getClient(), collectionName: "sessions", ttl: 3600 });
  const Account = require("../models/Account");
  const acct = await Account.findOne({}, "_id").sort({ createdAt: 1 }).lean();
  const sid = crypto.randomBytes(24).toString("base64url");
  await new Promise((res, rej) => store.set(sid, { cookie: { originalMaxAge: 3600000, expires: new Date(Date.now() + 3600000), httpOnly: true, path: "/" }, accountId: acct._id }, (e) => (e ? rej(e) : res())));
  const cookie = "xt.sid=" + encodeURIComponent("s:" + signature.sign(sid, config.sessionSecret));
  const BASE = "http://127.0.0.1:3199";
  const W = start("W", { PROC_ROLE: "web", SCHEDULER_ENABLED: "false", PORT: "3199", APP_ORIGIN: BASE });
  await until(() => W.isReady(), "the web copy is listening");
  try {
    // An open tab's /live, read as it arrives.
    let liveText = "";
    let liveEnded = false;
    fetch(BASE + "/live", { headers: { cookie } }).then(async (res) => {
      for await (const chunk of res.body) liveText += Buffer.from(chunk).toString();
      liveEnded = true;
    }).catch(() => { liveEnded = true; });
    await until(() => liveText.includes("event: status"), "an open tab's /live is streaming");
    // A slow page in flight (the Inbox: ~1–2 s), then the stop, while it's still being drawn.
    const page = fetch(BASE + "/", { headers: { cookie } }).then((r) => r.status, () => "failed");
    await sleep(150);
    W.child.send("shutdown");
    check((await page) === 200, "the page in flight still answered 200");
    await until(() => liveEnded, "the /live stream was ended");
    check(liveText.includes("retry: 1000"), "and told the tab to come back in a second");
    await W.exited;
  } finally {
    await new Promise((r) => store.destroy(sid, r));
  }

  await mongoose.disconnect();
  const failed = checks.filter(([ok]) => !ok);
  console.log(failed.length ? `verify-restart: ${failed.length} FAILED` : `verify-restart: all ${checks.length} checks pass`);
  process.exitCode = failed.length ? 1 : 0;
})().catch(async (e) => {
  console.error(e);
  process.exitCode = 1;
});
