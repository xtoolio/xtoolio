# Deploying and restarting

The server runs pm2 with `ecosystem.config.js`: `xtoolio-web` (several copies, cluster mode, one port) and
`xtoolio-worker` (one). nginx sits in front (one proxy hop: `app.set("trust proxy", 1)` in web.js; anything added in
front of nginx, a CDN, needs that changed or every visitor shares one rate limit).

## Restarting without losing anything

```
git pull && npm ci --omit=dev && pm2 reload ecosystem.config.js --update-env
```

Always `reload`, never `restart` (restart stops a process before its replacement is up). What happens (app.js,
lib/shutdown.js):

- **Web copies**, one at a time: the new copy starts and says it's ready once listening; the old one stops accepting,
  sends every open tab's `/live` back to reconnect in a second (the browser reconnects to a copy that's up and replays
  what it missed by `Last-Event-ID`), lets every request in flight finish (a Stripe webhook, a reply, a bulk unfollow),
  then exits. Stripe also retries any webhook that didn't get a 2xx for 3 days, and every credit is applied exactly once
  (`Account.appliedRefs`), so even a hard crash mid-webhook loses nothing.
- **The worker**: the new one starts BESIDE the old and opens its own connection to X's activity stream (X accepts two,
  shown in a spike; it takes X ~20 s to accept); only then is the old one stopped. Its duties (the scheduler, the
  accounts watch, the hourly subscription check and ledger flush, the balance clock, the waitlist's DMs, the away
  check of services/away.js) wait for the `worker` lease
  (lib/lease.js), which the old one releases after stopping its own: its syncs stop at their next request to X with
  their progress saved, and the new worker's first pass carries on. The old one closes its stream LAST, so no event X
  sends during a deploy is missed (both receive for a moment; every write is an upsert).
- A crash is covered too: a worker that dies without letting go frees the lease at once when the new one is on the
  same machine and the old process is gone, else within 2 minutes; whatever X sent while no stream was open is read by
  the catch-up sync on reconnect (services/scheduler.js catchUp).

`npm run verify:restart` runs all of this for real (local app stopped first): 11 checks, about a minute.

Not graceful: `max_memory_restart` (pm2 restarts, not reloads, a process over its memory cap) and `pm2 delete all`
(needed when changing `max_memory_restart` itself). The crash path above covers them.

## The server

A few dedicated cores, in the region of the database. One web copy per core but one (`WEB_INSTANCES` overrides) + the
worker. No server backups needed (it holds no data: the database and git do). Keep `.env` in a password manager:
losing `TOKEN_KEY` signs everyone out.

Measured on a development machine (a one-off load check, 10 at once, an account with a few thousand posts
and a few hundred Inbox cards): one web copy serves 5-7 signed-in Inbox / People / Likes / Follows pages a second (each
re-reads and re-ranks the account's whole history), 37 Settings pages; the signed-out front page takes 32 ms.
Re-measure on the server before announcing.

## A launch's sign-up rush

New accounts' first reads queue in the worker, `SYNC_SLOTS` at a time (default 5), first come first served, ahead of
the regular syncs; each person's progress page says where they are in line and, once a few first reads have finished,
about how long ("You're 12th in line ... ready in about 8 minutes"). X's limits are per user, so more at once is safe
for X; the bound is the worker's memory and the database. Before opening sign-ups, raise it (`SYNC_SLOTS=15` in
`.env`) and watch the worker's memory under the first real rush (`pm2 ls`, its mem column). The worker may use 1.5 GB
before pm2 restarts it (`max_memory_restart` in ecosystem.config.js; it used to be 500 MB, which a rush of 15 first
reads could pass, killing them mid-read). pm2 applies a new memory limit only to a process started fresh, never on a
reload, so after changing it: `pm2 delete xtoolio-worker && pm2 start ecosystem.config.js --only xtoolio-worker && pm2
save` (the web copies stay up; X's live stream drops for the seconds it takes, and the new worker's catch-up sync reads
what was sent meanwhile).

Still to confirm: X's app-wide ceiling of post reads a month (our notes say 3 million on
pay-per-use; a deep first read is up to ~4,000 posts, so ~750 of them would use a month's worth), and whether X caps
how many accounts one app can subscribe to live events.

## Scaling

What to watch, and the lever for each, in the order they're likely needed:

- **A sign-up rush**: the first-read line (each progress page says it) → `SYNC_SLOTS` in `.env`, `pm2 reload
  ecosystem.config.js --update-env`. Bounded by the worker's memory (`pm2 ls`, mem column; capped at 1.5 GB).
- **Pages slow under load**: `pm2 monit`, the web copies' CPU high for minutes → a bigger server. On DigitalOcean:
  Resize → **CPU and RAM only** (reversible; a disk resize never is), the same family. It powers
  the server off for a few minutes: the site is down meanwhile. pm2 brings back its saved process list on boot with the
  OLD number of web copies, so after it: `pm2 scale xtoolio-web <cores - 1> && pm2 save` (live, no restart).
  `ecosystem.config.js` defaults to cores - 1 for any later `pm2 start`; `WEB_INSTANCES` in `.env` overrides it. With
  more RAM, the worker's `max_memory_restart` can rise too (see above for how a new cap is applied). More copies = more
  open tabs: check nginx's `worker_connections`.
- **The database**: Atlas → the cluster → Metrics (CPU, operation time, connections) and Performance Advisor (missing
  indexes). A bigger dedicated tier is Atlas → Edit configuration, rolled one node at a time with no downtime (the driver
  rides through the primary changing); turn on its cluster-tier and storage auto-scaling. From a shared or Flex tier to
  a dedicated one is a migration with a short cutover, not a click. Connections: each process opens up to
  `MONGO_MAX_POOL_SIZE` (10) plus its change streams; 8 processes is ~100, far under any dedicated tier's limit.
- **One big account's pages slow** (not load: every page re-reads and re-ranks its whole history): more cores don't
  help. The fix is code: build the Inbox and the ranking once per sync and store them, read per page.
- **Past one server**: the web copies keep nothing in memory that matters (sessions, live events, rate windows are in
  Mongo; each copy's own change stream feeds its own tabs), so more servers behind a load balancer work,
  with `trust proxy` raised for the extra hop (see the top). The worker stays ONE (the lease) until a claimed-job queue
  lets several share the syncs: needed at hundreds of active accounts, not before.

## nginx

The site is `deploy/nginx-xtoolio.conf` (copied to `/etc/nginx/sites-available/xtoolio`); certbot added TLS to it.
- `proxy_buffering off` for `/live` (the SSE), and HTTP/2: browsers allow 6 HTTP/1.1 connections per host and every
  open tab holds one. Certbot writes `listen 443 ssl;`: `http2` was added to both 443 lines by hand.
- Raise `worker_connections` (Ubuntu's default is 768): every open tab is a connection.
- `server_tokens off;` in `/etc/nginx/nginx.conf` (Ubuntu ships it commented out): no version in the Server header.

## After every deploy

`npm run probe:live` (from any machine): what an attacker sees from outside, read-only. And the production `.env` is
NOT a development machine's: `APP_ORIGIN=https://<your domain>`, `METERED_BILLING_ENABLED` as decided, a fresh `SESSION_SECRET`, the
SAME `TOKEN_KEY`; `SOURCE_REPO_URL` only once the public repo exists (the front page says "Read the code" with it), and
`CONTACT_X` set to the handle that reads its DMs (Terms and Privacy name it for questions; deleting an account is
self-serve in Settings only, never by request).

## The server as built

One Ubuntu server. Root login and password login off; one sudo user. Swap 2 GB, ufw (OpenSSH, 80, 443), Node 24
(NodeSource), pm2 (+ pm2-logrotate, startup on boot), nginx, certbot (the domain + www, auto-renew). Code: `git clone`
with a read-only deploy key into the sudo user's home; `.env` is `chmod 600`. A
development machine never writes the production database: it runs on its own test database and can only
READ production (`MONGO_LIVE_READ_URI`, `.env.example`).
