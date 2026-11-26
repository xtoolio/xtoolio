// How fresh the sync keeps profiles, and what a month of an account's reading comes to: ONE policy for every account,
// the same assumptions the front page's estimate makes (a person who estimated their cost on the front
// page must find the same figure in Settings, every assumption the same). These used to be per-account choices in Settings (Account.syncPrefs: how many top people, how often
// theirs and everyone else's profiles were re-read). Pure (no config, no DB): services/sync.js and web.js read it.
//
// Prices: X bills a profile once per UTC day however often it's read (lib/pricing.js), so a refresh at least daily
// costs the same as daily.
//
// How often to check for new posts is not a setting either (removed): a check that finds nothing returns
// nothing billable and each post is billed once, so a slower check only made the page staler at the same price. Every
// account syncs every scheduler tick (SYNC_EVERY_MINUTES). Your OWN profile is read on every run (X bills it once a
// UTC day; verified on X's balance, a same-day re-read cost $0).
"use strict";

const { PRICE, MONTH_CONTEXT_PER_POST, MONTH_PEOPLE_PER_POST } = require("../lib/pricing");

const DAY_MS = 24 * 3600 * 1000;

// THE profile policy, with People on: your top 50 people's profiles re-read weekly, everyone else's monthly. A profile
// read also brings that person's follow status with it (models/Follow.js), so this is how fresh "Follows you" is too.
const PROFILES = Object.freeze({ topN: 50, topDays: 7, restDays: 30 });

// Without People (its tiers are People's, docs/MODULES.md): everyone looked up once, the account itself every run.
const LOOKED_UP_ONCE = Object.freeze({ topN: 0, topDays: 0, restDays: 0 });

// How old a profile may get before the sync looks it up again, by its place in the ranked list (0 = the account
// itself, 1..topN its top people, then everyone else). Infinity = never again. Pure.
function profileTtlMs(index, prefs) {
  if (index === 0) return 0; // the account itself: every run (billed once a day however often it's read)
  if (index <= prefs.topN) return prefs.topDays * DAY_MS;
  return prefs.restDays ? prefs.restDays * DAY_MS : Infinity;
}

// Refreshes a month: 30 / days, at most one a day (X's daily dedup).
const perMonth = (days) => 30 / Math.max(days, 1);

// How many profiles each tier holds, of the `people` the profile pass ranks (the account itself first): its top N
// and everyone else. Pure.
function tierCounts(prefs, people) {
  const others = Math.max(0, people - 1);
  const top = Math.min(prefs.topN, others);
  return { top, rest: others - top };
}

// Your own profile, read every run: one profile a day (X's dedup), every day.
const SELF_MONTHLY_USD = PRICE.user * 30;

// A month of an account's reading at X's price, from how much it posts and gets a day (measured from its real month on
// X, services/estimator.js, or guessed): THE estimate, the front page's and Settings' alike. X's cost per part, with
// the counts it's made of; the caller applies the markup. Pure.
// → { parts: [{ key, count, times, unitUsd, usd }], usd }
function estimateMonth({ written = 0, received = 0 } = {}, prefs = PROFILES) {
  const posts = Math.round((written + received) * 30);
  const context = Math.round(posts * MONTH_CONTEXT_PER_POST);
  const people = Math.round(posts * MONTH_PEOPLE_PER_POST);
  const { top, rest } = tierCounts(prefs, people + 1); // the profile pass ranks the account itself first
  const parts = [
    { key: "posts", count: posts, times: 1, unitUsd: PRICE.post },
    { key: "context", count: context, times: 1, unitUsd: PRICE.post },
    { key: "people", count: people, times: 1, unitUsd: PRICE.user },
    { key: "top", count: top, times: perMonth(prefs.topDays), unitUsd: PRICE.user },
    { key: "rest", count: rest, times: prefs.restDays ? perMonth(prefs.restDays) : 0, unitUsd: PRICE.user },
    { key: "self", count: 1, times: 30, unitUsd: PRICE.user },
  ].map((p) => ({ ...p, usd: p.count * p.times * p.unitUsd }));
  return { parts, usd: parts.reduce((s, p) => s + p.usd, 0) };
}

module.exports = { PROFILES, LOOKED_UP_ONCE, profileTtlMs, tierCounts, estimateMonth, SELF_MONTHLY_USD };
