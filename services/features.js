// What an account has switched on: the four MODULES, each bought on its own in any combination (docs/MODULES.md:
// any one module alone is a valid choice),
// and the add-ons that come WITH them. ONE registry. Pure (no config, no DB): services/sync.js, services/liveRules.js,
// routes/auth.js and web.js all decide through it.
//
// Only modules are switched (Account.features.<module>.on). The add-ons (Replies, live; Liking; Replying; Following)
// have no switch of their own: each is active whenever a module that draws it is (the Buttons toggles were
// removed, the buttons simply on, and live replies come with the Inbox as the front page prices them). Sign-in
// asks X for EVERY scope at once (no half state: all permissions, which is cleaner): no incremental consent, so
// turning a module on in Settings never leaves the site. Until then each feature asked for its scope when turned on.
"use strict";

const { SCOPES } = require("../lib/x");

// The modules in their fixed order: the order Settings and the front page's picker list them.
const MODULES = ["inbox", "people", "likes", "follows"];

// key → { label, module?, scopes, needs? }. `needs`: an add-on is active while at least one of these is (the module
// that shows its button).
const FEATURES = {
  // Inbox: replies, mentions and quotes to you, one card per conversation. Reads your own timeline (so it knows what
  // you answered) and your mentions forward, from a week before you joined, plus the posts around them and each new
  // person's profile once. No permission beyond sign-in's.
  inbox: { key: "inbox", label: "Inbox", module: true, scopes: [] },
  // People: everyone you go back and forth with, ranked, over the history you chose to read ("how far back?",
  // services/history.js), with the top people's profiles kept fresh (services/syncPrefs.js), and how many of each
  // other's posts you liked: the posts YOU like are read (liked_tweets) for "You liked", hence like.read.
  people: { key: "people", label: "People", module: true, scopes: ["like.read"] },
  // Likes: who liked YOUR posts, live (X's like events, PRICE.likeEvent each), checked a day later only for replies posted while the
  // stream wasn't connected (services/extras.js). Not the posts you like: that's People's, or Liking's.
  likes: { key: "likes", label: "Likes", module: true, scopes: ["like.read"] },
  // Follows: who followed and unfollowed you, live ($0.01 an event, both directions), best effort (what X doesn't send
  // isn't re-read: the follower check was deleted), and the Follows tab. (Merged from "Follows", the
  // free badges, and "Follows, live": the "Follows you / Mutual" tags now come with any profile read, whatever's on.)
  follows: { key: "follows", label: "Follows", module: true, scopes: ["follows.read"] },
  // LIKESTORM ONLY: a switch BESIDE the four modules, not one of them (not in MODULES, so the scheduler, Live, the
  // mentions check and the estimator never see it): an account with only this on reads NOTHING on its own, no sync and
  // no live events, and pays per storm alone (routes/pages.js answerStorm). Turned on by the start page's "Likestorms
  // only" (POST /start/storm); Get started turns the four on beside it. It brings Liking (below), which a storm needs.
  likestorm: { key: "likestorm", label: "Likestorm", module: true, scopes: ["like.read", "like.write"] },

  // Replies, live: X pushes each reply, mention, quote and post of yours within seconds (Live's post events) instead of
  // the next 15-minute sync reading it. X bills a post event $0.005, which for the app's owner is 5× the sync's Owned
  // Read of the same post; for anyone else it's the price the sync pays anyway. No extra scope.
  liveReplies: { key: "liveReplies", label: "Replies, live", scopes: [], needs: ["inbox"] },
  // Liking: the ♥ under someone's post (the Inbox, a conversation) likes or unlikes it on X. A write; it reads the posts
  // you like as well (like.read), so the ♥ knows what you've already liked.
  liking: { key: "liking", label: "Liking", scopes: ["like.read", "like.write"], needs: ["inbox", "people", "likestorm"] },
  // Replying: a reply box under a message (the Inbox, a conversation) posts your reply on X. The second write
  // (tweet.write: "create and repost on your behalf"); xtoolio only ever posts text you wrote and sent.
  replying: { key: "replying", label: "Replying", scopes: ["tweet.write"], needs: ["inbox", "people"] },
  // Reposting: the ↻ under someone's post (the Inbox, a conversation) reposts it on X, or undoes it
  // (each reply gets its own repost button). The same tweet.write ("create and repost on your
  // behalf"), so no account signs in again for it.
  reposting: { key: "reposting", label: "Reposting", scopes: ["tweet.write"], needs: ["inbox", "people"] },
  // Pictures: photos (up to 4) or a GIF in a reply (lib/media.js), uploaded to X as you send it (media.write: "upload
  // media on your behalf"); X hosts them, xtoolio keeps nothing. Its own add-on, so text replies keep working for an
  // account that hasn't granted media.write (everyone who signed in before Pictures existed, until they sign in again).
  pictures: { key: "pictures", label: "Pictures", scopes: ["tweet.write", "media.write"], needs: ["inbox", "people"] },
  // Following: THE Follow button (the Follows tab, People's cards, a person's page) follows or unfollows them on X. The
  // third write (follows.write).
  following: { key: "following", label: "Following", scopes: ["follows.write"], needs: ["follows", "people"] },
};

// THE scopes every sign-in asks for: the base ones and every feature's, whatever's on (a new authorization replaces
// the old grant, so asking for all of them each time means none is ever lost).
const SCOPES_ALL = [...new Set([...SCOPES, ...Object.values(FEATURES).flatMap((f) => f.scopes)])];
// JOINING THE WAITLIST asks only who you are (X's consent screen listed every write, none of which the
// waitlist needs): X's /2/users/me needs exactly these two; no offline.access, no write.
// routes/auth.js `?join=1`; someone who turns out to be let in is sent to the full sign-in at once.
const SCOPES_JOIN = ["tweet.read", "users.read"];
// THE SITE'S OWN ACCOUNT (SITE_X) asks for everything a customer does PLUS dm.write: it is also the waitlist's "you're
// in" DM sender (services/waitlistDms.js), and since a new authorization replaces the old grant, its one grant must
// carry both (a second grant for the sender was replaced by the account's next sign-in). Never asked of anyone else
// (routes/auth.js; verify-security).
const SCOPES_SITE = [...SCOPES_ALL, "dm.write"];

// A module the account switched on. Add-ons have no switch: "on" is whether a module that draws them is.
const isOn = (account, key) =>
  FEATURES[key].module ? !!(account && account.features && account.features[key] && account.features[key].on) : FEATURES[key].needs.some((n) => isOn(account, n));

// Has X actually granted what this feature needs? (An account that signed in before every scope was asked for, or
// revoked one on X, until it signs in again.)
const granted = (account, key) => {
  const have = new Set(String((account && account.tokens && account.tokens.scope) || "").split(/\s+/));
  return FEATURES[key].scopes.every((s) => have.has(s));
};

// Does this feature run for this account: a module on and granted; an add-on granted with a module it needs active.
// THE check every door uses.
const active = (account, key) => (FEATURES[key].module ? isOn(account, key) : FEATURES[key].needs.some((n) => active(account, n))) && granted(account, key);

// The modules the account chose (on, granted or not: a paused one is still chosen). [] = it hasn't picked yet.
const modulesOn = (account) => MODULES.filter((k) => isOn(account, k));

// LIKESTORM ONLY (FEATURES.likestorm): no module on, the likestorm switch on. Its home is the Likestorm page, and
// nothing syncs for it.
const stormOnly = (account) => !modulesOn(account).length && isOn(account, "likestorm");

// The Mongo filter for accounts that picked at least one module (the scheduler's passes).
const MODULE_FILTER = { $or: MODULES.map((k) => ({ [`features.${k}.on`]: true })) };

// THE write that turns modules on (Settings, the sign-in callback, the start page): on, `since` now, `first` kept
// if it was ever on before ($min), and `live.due` (it can change what X pushes). → an update for Account.updateOne.
function turnOn(keys, now = new Date()) {
  const ks = [].concat(keys);
  return {
    $set: { ...Object.fromEntries(ks.flatMap((k) => [[`features.${k}.on`, true], [`features.${k}.since`, now]])), "live.due": true },
    $min: Object.fromEntries(ks.map((k) => [`features.${k}.first`, now])),
  };
}

// When the account first turned a feature on (accounts from before `first` was kept: when the account was made). The
// Inbox starts a week before its own (inbox.inboxStart), so turning it on months after joining doesn't pour months
// of old replies in as Waiting.
const firstOn = (account, key) => (account && account.features && account.features[key] && account.features[key].first) || (account && account.createdAt);

// Is a FIRST read due: no run has finished yet, or one finished before the account last asked for a deeper read of
// its conversations (the Inbox turned on: its week; People's history chosen). The scheduler starts it at once, at the
// front of its pool, and the Inbox / People pages show its progress until it's done. `state`: its SyncState (lastRunAt).
// A RESUME (services/pause.js, Account.resumedAt: "how far back?" after a pause) asks for one too.
function pullDue(account, state) {
  const last = state && state.lastRunAt ? new Date(state.lastRunAt).getTime() : 0;
  if (!last) return true;
  const f = (account && account.features) || {};
  const asked = [isOn(account, "inbox") && f.inbox.since, isOn(account, "people") && account.history && account.history.chosenAt, account && account.resumedAt].filter(Boolean).map((d) => new Date(d).getTime());
  return asked.some((t) => t > last);
}

// Is the account still in its FIRST READ, for its pages' sake: the read itself (pullDue), or its likes not yet
// reconciled to its history (SyncState.likes.reconciled === false: set when a first read with People begins, web.js;
// unset on accounts from before, which are never held). Until then its Inbox, People and Posts show
// the progress page, so nothing shows as owing a like already given, and no bulk like pays X for one twice.
// THE RESUME READ (SyncState.resume, services/pause.js) holds them the same way until its posts and likes are read.
// `state`: its SyncState (lastRunAt, likes.reconciled, resume). Pure.
const firstReadGoing = (account, state) => pullDue(account, state) || !!(state && state.likes && state.likes.reconciled === false) || !!(state && state.resume);

// When the account asked for the read pullDue finds due (the latest of: the account made, the Inbox turned on,
// People's history chosen), in ms: the first-read queue's order (services/pullQueue.js byAsked). Pure.
function pullAskedAt(account) {
  const f = (account && account.features) || {};
  const asked = [account && account.createdAt, isOn(account, "inbox") && f.inbox.since, isOn(account, "people") && account.history && account.history.chosenAt, account && account.resumedAt];
  return Math.max(0, ...asked.filter(Boolean).map((d) => new Date(d).getTime()));
}

module.exports = { MODULES, FEATURES, MODULE_FILTER, SCOPES_ALL, SCOPES_JOIN, SCOPES_SITE, isOn, granted, active, modulesOn, stormOnly, pullDue, firstReadGoing, pullAskedAt, turnOn, firstOn };
