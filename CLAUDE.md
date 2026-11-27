# xtoolio

A side-tool next to the X app (not a client): your replies, mentions and quotes as an Inbox, who you go back and forth
with, who liked and reposted your posts, who followed and unfollowed you. Four MODULES, each switched on its own and
priced on its own: **Inbox, People, Likes, Follows** (`services/features.js` is the one registry). Beside them,
**Likestorm only**: a switch that is no module, so an account with only it on syncs nothing and pays per storm.

The stack is deliberately boring: Node 22+, Express 5, Handlebars rendered on the server (no build step), plain
JavaScript (no TypeScript), MongoDB through Mongoose, pm2. Multi-user through Sign in with X.

This file is the short guide for working on the code. The bigger parts have their own design notes in `docs/`
(BILLING, LIVE, MODULES, ACTIVITY-API, DEPLOY, WAITLIST-DMS).

## Run

- `cp .env.example .env`, fill it in (every setting is explained there), then `npm start`: connects, starts the sync
  scheduler and serves at `APP_ORIGIN` (http://127.0.0.1:3100). Use that exact hostname: the session cookie and X's
  registered callback live on one hostname.
- `npm run dev`: the same under `node --watch`. Views are read fresh per request.
- `pm2 start ecosystem.config.js`: production's web / worker split (`xtoolio-web` serves, `xtoolio-worker` runs the
  scheduler, X's activity stream, the balance clock, the mentions check while someone has the app open, the waitlist's
  DMs, and the away check: with Keep syncing live off, an account pauses after an hour without the app open,
  `services/away.js`). Restart with `pm2 reload ecosystem.config.js --update-env`,
  never `restart`: the shutdown sequence (`lib/shutdown.js`) hands over without losing a live event.
- `npm run sync -- <username>`: one sync run for one account, with the full report.

## Tests

- `npm run verify` (no network, no database): `verify-people` (the Inbox, threads, text, sync paging against a fake
  X), `verify-security` (the real web.js on an in-memory session store: headers, CSRF, sign-in, the CSP rules grepped
  across views and scripts) and `verify-billing` (the money rules). Run before every commit.
- `npm run verify:db`: the atomic money moves, account deletion, private accounts, the Inbox's start, the waitlist and
  its DMs against a TEST
  database. It creates and deletes accounts: never point it at real data.

## Layout

- `config/index.js` is the ONE reader of the environment. The pure services take their settings as arguments, so the
  verify scripts load them with no `.env`.
- `app.js` = entry (connect, scheduler, session store, listen). `web.js` = `createApp()`: middleware and the routes
  not yet moved into `routes/`, which has one router per area (`inbox`, `people`, `auth`, `agents`, `mcp`, `admin`,
  `account`, `feedback`, `pause`, `tagged`, `likestorm`; `routes/pages.js` is what they share).
- `services/` = the logic. `sync.js` is the sync engine; `conversations.js` builds every page's data (the Inbox's
  cards, a conversation, the leaderboard) and the agent tools call the same loaders; `inbox.js`, `people.js`,
  `text.js`, `listing.js` are pure view logic.
- `lib/x.js` is the ONE door to X's API: nothing else calls api.x.com (verify-security fails otherwise).
- `models/` = Mongoose schemas. Posts and profiles are SHARED across accounts (a post is stored once, keyed by X's id;
  `Post.accounts` says whose feeds it's in); likes are per account (they're private on X).
- `views/` = Handlebars; `lib/hbs.js` is the one setup (helpers, partials) for serving and offline renders alike.
  `public/` = static files: `app.css` (every colour a token, light and dark) and `public/js/*.js`.

## Conventions

- **What people write is text, never markup.** Handlebars escapes once; the only `{{{ }}}` is the layout's body, and
  no helper returns a SafeString. A link from X's data becomes an href only when it's http(s) (`services/text.js
  webHref`).
- **The CSP is strict and self-only**: no inline `<script>`, no `style=`, no `on*=` handlers, no `title=` (tooltips
  are `data-tip`). Behaviour goes in `public/js`, styling in `app.css`. Every POST form carries `{{csrfToken}}`;
  fetches send `x-csrf-token`.
- **A form can't end on another site** (`form-action 'self'`): anything that goes to x.com or Stripe is a link.
- **Every X call is metered.** Work that reads or writes X runs inside `usage.metered()`, which records each response
  as it arrives; `createClient` refuses to run without a meter. Money is integer micro-dollars; the markup is applied
  in ONE place (`services/balance.js`).
- **Messages after a redirect** are keys in ONE list, `lib/notices.js`, shown by the toast (`?n=<key>`). Short: what
  happened, then the next step if there is one.
- **Lists** (search, filter, sort, pages) go through ONE engine, `services/listing.js createListing`.
- **Dates** are written in the account's time zone by the `lib/hbs.js` helpers, never the machine's.
- **The brand** is `config.brandName` (`BRAND_NAME`): no view or client string types the site's name.
- On screen the words are **post** and **reply**, never "message" or "card".

## Security

- Sign in with X is OAuth 2.0 + PKCE; the pending sign-in lives in the session, single-use, 10 minutes. X tokens are
  sealed with AES-256-GCM (`lib/crypto.js`, `TOKEN_KEY`) and opened only right before a call.
- Sign-up is closed by default (`ALLOWED_USERNAMES`); everyone else goes on the waitlist. Admins are X user ids
  (`ADMIN_IDS`), never handles.
- A private account's post is drawn for an account only when X showed it to that account
  (`services/accountData.js visibleTo`, the one rule every loader uses).
- Agents reach an account's data at `/mcp` (`routes/mcp.js`, `services/agentTools.js`), by OAuth or a token made in
  Settings; tokens are stored as hashes. An agent can only read, and leave draft replies the person sends.
- Use maintained libraries for security (`helmet`, `csrf-csrf`, `express-session`, the MCP SDK's OAuth); don't
  hand-roll it.
