// app.js — the entry point (`npm start`, and both pm2 processes in ecosystem.config.js).
// Connects to Mongo, runs the worker's jobs where enabled, and serves web.js unless this is the worker.
//
// RESTARTS WITHOUT LOSING ANYTHING (restart the app in flight without missing a webhook; docs/DEPLOY.md). `pm2 reload` starts the new process, waits for it to say it's ready, then stops the
// old one (lib/shutdown.js runs its steps in the order registered here):
//   WEB (several copies, reloaded one at a time): ready once listening. Stopping: accept nothing new, send every open
//     tab's /live back to reconnect (it lands on a copy that's up and replays what it missed by Last-Event-ID), let the
//     requests in flight finish (a Stripe webhook, a reply, a bulk unfollow), then exit.
//   WORKER (one): ready once X's stream has accepted ITS connection (X allows two at once: seen in a spike), so for a
//     moment both workers receive events (every write is an upsert: a duplicate stores nothing twice). Its duties (the
//     scheduler, the accounts watch, the hourly ensure + ledger flush, the balance clock, the waitlist's DMs) wait for the "worker" lease
//     (lib/lease.js). Stopping: start nothing new, halt X (each run stops at its next request, progress saved), wait
//     for the runs, stop the duties, release the lease (the successor's duties start), and only then close its stream.
"use strict";

const config = require("./config");
const { connect } = require("./lib/db");
const { onShutdown, handleSignals, haltX } = require("./lib/shutdown");

// Tell pm2 this process is ready (ecosystem.config.js wait_ready): the old one is stopped only after it.
const ready = () => process.send && process.send("ready");

async function startWorker() {
  const live = require("./services/live");
  const scheduler = require("./services/scheduler");
  const mentionsCheck = require("./services/mentionsCheck");
  const followingReads = require("./services/followingReads");
  const balanceClock = require("./services/balanceClock");
  const waitlistDms = require("./services/waitlistDms");
  const away = require("./services/away");
  const { acquire } = require("./lib/lease");
  let release = null;
  // Registered in the order they run on stop.
  onShutdown("scheduler", async () => {
    haltX();
    await Promise.all([scheduler.drain(), mentionsCheck.stop(), followingReads.stop()]);
  });
  onShutdown("duties", async () => {
    await live.stopDuties();
    await balanceClock.stop();
    await waitlistDms.stop();
    away.stop();
    if (release) await release();
  });
  onShutdown("stream", () => live.stopStream());

  live.startStream({ onFirstOpen: ready });
  release = await acquire("worker", { onWait: () => console.log("worker: waiting for the previous worker to hand over") });
  scheduler.start(config, { bootPass: !config.x.bearerToken }); // Live's first connect catches up
  mentionsCheck.start(); // while someone has the app open: the replies X's stream doesn't push
  followingReads.start(); // the follow reconciler's reads, page by page (a press only records what's wanted)
  live.startDuties();
  if (config.x.ownerId) balanceClock.start(); // X's real balance, once a minute (one reader)
  waitlistDms.start(); // the waitlist's "you're in" DMs, from the site's account (one sender: here, under the lease)
  away.start(); // Keep syncing live off: an hour without xtoolio open pauses it (services/away.js)
}

function startWeb(mongoose) {
  // Sessions live in Mongo on the app's own connection (one pool), expiring with the cookie.
  const MongoStoreImport = require("connect-mongo");
  const MongoStore = MongoStoreImport.default || MongoStoreImport;
  const sessionStore = MongoStore.create({ client: mongoose.connection.getClient(), collectionName: "sessions", ttl: config.sessionDays * 24 * 3600 });

  // Live, the page side: hand what changed to the open tabs over SSE (services/livePush.js).
  require("./services/livePush").start();

  const { createApp } = require("./web");
  const app = createApp({ sessionStore });
  // Requests in flight, so stopping can wait for them; the open /live streams aren't counted (they're sent back).
  let inFlight = 0;
  const server = app.listen(config.port, config.host, () => {
    console.log(`${config.brandName} on ${config.appOrigin}`);
    ready();
  });
  server.on("request", (req, res) => {
    if (req.url.startsWith("/live")) return;
    inFlight++;
    res.on("close", () => inFlight--);
  });
  onShutdown("web", async () => {
    server.close(); // accept nothing new; resolves once every connection is gone, which isn't awaited
    app.closeLive();
    while (inFlight > 0) await new Promise((r) => setTimeout(r, 100));
    server.closeIdleConnections();
  });
}

async function start() {
  const mongoose = await connect(config);
  handleSignals({ mongoose, deadlineMs: config.shutdownMs });
  // A plain `npm start` is both: the web first on stop (finish what people are doing), then the worker's handover.
  if (config.procRole !== "worker") startWeb(mongoose);
  if (config.schedulerEnabled) await startWorker();
  if (config.procRole === "worker") console.log(`${config.brandName} worker started — scheduler only`);
}

start().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
