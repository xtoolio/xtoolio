// ecosystem.config.js — pm2 process topology (the web/worker split).
//
// TWO apps, both running `node app.js`; the only differences are PROC_ROLE (does it listen on HTTP?) and
// SCHEDULER_ENABLED (does it run the worker's jobs?). Both are read by config/index.js.
//
//   • xtoolio-web    — serves HTTP. One copy per core but one (left for the worker): a resized server gets more copies
//                     on the next start, nothing to edit (`WEB_INSTANCES` in .env overrides it; 3 on a 4-core
//                     server). In cluster mode on one port. Every copy is the same: sessions, live events and the rate-limit
//                     windows are in Mongo; each copy holds its own open tabs' /live (services/livePush.js). The
//                     per-IP request limiters are per copy, so N copies allow N times as much: fine.
//   • xtoolio-worker — the worker's jobs ONLY (PROC_ROLE=worker: no listener). ONE, in cluster mode all the same, so
//                     `pm2 reload` starts the new one BESIDE the old (its X stream open first) and only then stops the
//                     old: a restart without a gap (app.js). EXACTLY ONE does the duties: the "worker" lease
//                     (lib/lease.js), whatever pm2 does.
//
// RESTARTS (docs/DEPLOY.md): `pm2 reload ecosystem.config.js --update-env`, never `restart` (which stops before it
// starts). wait_ready: pm2 waits for the new process's "ready" (app.js: web listening; worker's X stream accepted, which
// took 20 s in a spike, hence listen_timeout 60 s, after which pm2 goes ahead anyway). kill_timeout sits
// above SHUTDOWN_MS (25 s), so a stopping process is never killed mid-handover.
//
// Secrets stay in .env (loaded by config/index.js); only topology + role flags live here. NODE_ENV=production
// is for Express's own sake (view caching, terse error pages) and turns on the immutable cache for versioned
// assets and the Secure flag on the CSRF cookie.
//
// Usage:  pm2 start ecosystem.config.js   then   pm2 save
// max_memory_restart changes don't apply via `pm2 restart`: pm2 delete all && pm2 start ecosystem.config.js.
const graceful = { wait_ready: true, listen_timeout: 60000, kill_timeout: 30000 };
// pm2 reads this file in its own process, without the app's config/index.js, so `.env` is loaded here for the topology
// knobs (without it, WEB_INSTANCES in .env was silently ignored). The app itself still reads .env.
require("dotenv").config({ path: require("path").join(__dirname, ".env"), quiet: true });
const webInstances = Number(process.env.WEB_INSTANCES) || Math.max(1, require("os").cpus().length - 1);

module.exports = {
  apps: [
    {
      name: "xtoolio-web",
      script: "app.js",
      exec_mode: "cluster",
      instances: webInstances,
      env: { NODE_ENV: "production", PROC_ROLE: "web", SCHEDULER_ENABLED: "false" },
      max_memory_restart: "500M",
      ...graceful,
    },
    {
      name: "xtoolio-worker",
      script: "app.js",
      exec_mode: "cluster",
      instances: 1, // EXACTLY ONE (the lease makes a second one wait, never double up)
      env: { NODE_ENV: "production", PROC_ROLE: "worker", SCHEDULER_ENABLED: "true" },
      // The worker holds SYNC_SLOTS first reads at once (each a whole history in memory while it's stored), so it gets
      // room for a launch's rush (~15 slots: docs/DEPLOY.md), where 500M would have it killed and restarted mid-read.
      // On an 8 GB server, 3 web copies at 500M + this leave half of it free.
      max_memory_restart: "1536M",
      ...graceful,
    },
  ],
};
