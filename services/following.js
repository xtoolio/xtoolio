// THE FOLLOW RECONCILER (a huge account you follow will never follow back, and that's fine; the ones that
// matter are the small accounts that haven't): the accounts you follow that don't follow you back,
// under a follower threshold, each with THE Follow button to unfollow, and the bulk unfollow (web.js: up to 50 a press,
// X's 50 unfollows per 15 minutes).
//
// ONE read gives it all: X's following list carries `connection_status` per account (lib/x.js USER_FIELDS; a
// spike: "followed_by" marks the ones who follow you back), so the followers list isn't read too. The read is
// charged at the usual markup (only onboarding gets the 15% rate: services/balance.js), priced on the spot in tiers
// (followingOptions: your newest 1,000 / 2,500 / everything; X lists them roughly newest follow first, verified
// against stored follow events: the newest 7 in order, one out of place), capped at the tier, and never charged more
// than its quote (UsageEntry.ceilingUsd).
//
// What it writes is the PAIRS (models/Follow.js record: you → them, them → you), which Live's follow events keep
// current afterwards in both directions, free; the list is drawn from the pairs, so it also counts anyone a profile
// read already told us about. Only a read of the WHOLE list can say you stopped following someone (`complete`).
//
// ONE READ, THEN LIVE (nothing needs a second check after the first): once the
// whole list is read, the follow events keep it current, so there's no "Check again" (it re-read the whole list at full
// price: $375 for someone following 25,000). It's offered again only when the Follows module was turned on after the
// read (its events weren't subscribed meanwhile; X skipping an event is best effort, as the Follows tab is). A PARTIAL
// read (a newest-N tier, or stopped by the balance or X) offers THE REST, from X's page marker where it stopped
// (`next`), never the newest again.
//
// A WALK, saved page by page, in the WORKER (services/followingReads.js: 25,000 accounts is 25 requests and
// ~25,000 profiles to store, which ran inside the button's request and saved nothing until the end, so one X failure on
// page 20 threw away 19 pages already paid for). The press records what's wanted (`want`); the worker reads it, each
// page's pairs and its marker saved as they arrive; a stop (X down, a restart, X's limit) resumes from the marker.
"use strict";

const Follow = require("../models/Follow");
const Person = require("../models/Person");
const SyncState = require("../models/SyncState");
const LiveEvent = require("../models/LiveEvent");
const { ReadCapReached } = require("../lib/x");
const { createListing } = require("./listing");

const TIERS = [1000, 2500];
// "Everything" reads up to this many more than the count it was priced on (follows made since): its quote, the
// charge's ceiling, stays the count's.
const EVERYTHING_SLACK = 100;

// ── Rules (pure) ──

const fmt = (n) => n.toLocaleString("en-US");

// The read's choices for an account following `count` (Account.following, from its own profile every sync), X's cost
// `perUser` each (a profile; the owner's own list at the Owned Read rate), by where its WALK stands (`walk`:
// SyncState.following, or null):
//   never read (or `reread`: the Follows module turned on since): from the top, the tiers; a tier that reaches the whole
//     list becomes "All N" and nothing longer is offered
//   read part of the list, X's marker kept: THE REST, from the marker (key "rest"), sized on what's left
//   read whole: nothing (Live keeps it current)
// `from`: "top" | "next". `button`: the words on the one button the page shows once a read is done.
// → [{ key, label, button, budget, cap, all, from, estimate }]
function followingOptions(count, { perUser, walk = null, reread = false }) {
  const n = Number.isFinite(count) && count > 0 ? Math.round(count) : null;
  const read = walk && walk.listedAt ? walk.read || 0 : 0;
  if (walk && walk.listedAt && !reread) {
    if (walk.complete) return [];
    if (walk.next) {
      const left = Math.max(1, (n || 0) - read);
      return [{ key: "rest", label: `The other ${fmt(left)}`, button: `Read the other ${fmt(left)}`, budget: left, cap: left + EVERYTHING_SLACK, all: true, from: "next", estimate: left * perUser }];
    }
    // A partial read with no marker (one from before markers were kept): from the top, as never read.
  }
  const out = [];
  for (const t of TIERS) {
    if (n !== null && t >= n) break;
    out.push({ key: String(t), label: `Your newest ${fmt(t)}`, budget: t, cap: t, all: false });
  }
  if (n !== null) out.push({ key: "all", label: out.length ? `All ${fmt(n)}` : `All ${fmt(n)} you follow`, budget: n, cap: n + EVERYTHING_SLACK, all: true });
  return out.map((o) => ({ ...o, from: "top", button: reread ? "Check again" : o.label, estimate: o.budget * perUser }));
}

// The accounts you follow who don't follow you back, from the pairs: `following` (ids you follow), `followsYou` (Map id →
// whether they follow you; only an explicit false counts: unknown isn't "no"). ctx: { profiles, known (Set: who has a
// People page) }. → rows for partials/follow-card.hbs (kind "back").
function notFollowingBack(following, followsYou, { profiles = new Map(), known = new Set() } = {}) {
  return following
    .filter((id) => followsYou.get(id) === false)
    .map((id) => {
      const profile = profiles.get(id) || null;
      const person = { id, username: (profile && profile.username) || null, profile, page: known.has(id) ? `/people/${id}` : null };
      return {
        id,
        kind: "back",
        person,
        followsYou: false,
        youFollow: true,
        followers: profile && Number.isFinite(profile.followers) ? profile.followers : null,
      };
    });
}

// The follower threshold: under this many, or any. Free to change: it filters what's stored.
const UNDER = ["100", "500", "1000", "5000", "10000", "any"];
// 50 a page: "Select all on this page" fills one bulk unfollow (web.js UNFOLLOW_MAX: the press took up to
// 50 while the page showed 30 rows, so the page matches it).
const listing = createListing({
  path: "/follows/back",
  defaultSort: "followers",
  pageSize: 50, // no search: the follower threshold drives the list (views/follows-back.hbs)
  sorts: {
    // Smallest first: the accounts that "should" have followed back. Unknown counts last.
    followers: { value: (r) => (r.followers === null ? Infinity : r.followers), natural: "asc" },
  },
  filters: {
    under: { values: UNDER, default: "1000", test: (r, v) => v === "any" || (r.followers !== null && r.followers < Number(v)) },
  },
});

// ── The press: what it records for the worker (POST /follows/back/read). A choice from followingOptions → the update
// for SyncState (`want`: the read asked for; `ceilingUsd` its quote in X's cost, never charged past across every attempt
// it takes, `spentUsd` so far; `readNow` how many this read has read, against its `cap`). A read from the TOP (`top`)
// starts a new walk at its first page (readPages), so one refused before it leaves the last read as it was; `walkAt`,
// when it began, is what closeWalk compares against (a pair not re-read since was not on the list). Pure.
function wantUpdate(choice, now = new Date()) {
  const top = choice.from === "top";
  const want = { key: choice.key, budget: choice.budget, cap: choice.cap, ceilingUsd: choice.estimate, spentUsd: 0, readNow: 0, tries: 0, top, at: now };
  return { $set: { "following.want": want, ...(top && { "following.walkAt": now }) } };
}

// ── The walk: one attempt at the read asked for (`want`), from where the walk stands (`walk.next`), saved PAGE BY PAGE
// (its people and pairs, X's marker, the counts) and told to the open page (LiveEvent "following"). `x`: a client on
// this attempt's metered unit (userCap = what's left of the want's cap). Its ceiling reached (the quote, the balance:
// lib/x.js ReadCapReached) is a clean stop; anything else X throws is thrown on, with every page before it kept.
// → { complete, readNow, read } (complete: X has nothing after the last page) ──
async function readPages({ accountId, x, want, walk }) {
  // A read from the top, before its first page: a new walk (the last one's marker and count left behind).
  const fresh = want.top && !(want.readNow > 0);
  let next = fresh ? undefined : walk.next || undefined;
  let read = fresh ? 0 : walk.read || 0;
  let readNow = want.readNow || 0;
  do {
    let page;
    try {
      page = await x.followingPage(accountId, { paginationToken: next, maxResults: Math.min(1000, want.cap - readNow) });
    } catch (err) {
      if (err instanceof ReadCapReached) return { complete: false, readNow, read };
      throw err;
    }
    const now = new Date();
    const others = page.users.filter((u) => u.id !== accountId);
    await Person.store(page.users, now);
    // A page whose pairs weren't written (X sent no follow status: models/Follow.js) must not count as read: completing
    // the walk would take everyone on it for unfollowed.
    if (others.length && !(await Follow.record(accountId, page.users, now))) throw new Error("X sent no follow status with the list");
    read += page.users.length;
    readNow += page.users.length;
    next = page.nextToken || undefined;
    await SyncState.updateOne(
      { _id: accountId },
      { $set: { "following.read": read, "following.complete": false, "following.want.readNow": readNow, ...(next && { "following.next": next }) }, ...(!next && { $unset: { "following.next": "" } }) }
    );
    await LiveEvent.note(accountId, "following", { text: fmt(readNow) });
  } while (next && readNow < want.cap);
  return { complete: !next, readNow, read };
}

// The walk reached the list's end: anyone you were recorded as following whose pair this walk didn't re-read
// (checkedAt before it began) wasn't on the list, so you don't follow them any more. → how many.
async function closeWalk(accountId, walkAt, now = new Date()) {
  if (!walkAt) return 0;
  const r = await Follow.updateMany({ followerId: accountId, follows: true, checkedAt: { $lt: new Date(walkAt) } }, { $set: { follows: false, checkedAt: now } });
  return r.modifiedCount || 0;
}

module.exports = { followingOptions, notFollowingBack, listing, wantUpdate, readPages, closeWalk, UNDER, TIERS, EVERYTHING_SLACK };
