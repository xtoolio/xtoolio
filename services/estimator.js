// THE COST ESTIMATE FROM A REAL ACCOUNT (the platform pays for the measurement): a visitor types an @handle on the front page (and a signed-in account is measured by its own) and gets
// the month THE estimate prices, from that account's real pace instead of the dropdowns' guesses. Three requests with
// the app's own token: the profile ($0.01) and X's post counts per day for `from:handle` and `@handle -from:handle`
// ($0.010 each, X's "Counts: All", lib/x.js postCounts) — about 3 cents, the platform's cost, on the ledger as kind "estimate" with no
// account. Never charged to anyone's balance.
//
// THE WINDOW is the last WINDOW_DAYS (30) whole UTC days from X's full archive (GET /2/tweets/counts/all:
// a month of data, not 6 days). It used to be counts/recent,
// which covers 7 days: minus the partial first and last, 6. Note a month AVERAGES: an account that got busy last week
// measures well under its current pace (one measured account: under half its pace over the last 6 days).
//
// Why counts and not a sample of posts: a sample of N posts covers however many hours the account took to write them
// (25 of a busy account's posts were a few hours of one afternoon, priced as a whole day), while the counts are whole
// days without returning a single post. Checked against what the sync stored for one account: the same within a
// few a day.
//
// KEPT A WEEK (models/HandleEstimate.js, with a Re-estimate button): a measurement is fresh for FRESH_MS, for everyone who asks, across restarts and processes (it
// was a per-process memory cache for the UTC day, so every restart measured again: dozens of estimates during
// development). Settings' Re-estimate (`force`) measures now, at most once in REMEASURE_MS. Guards, since every
// measurement costs the platform money: visitors have a per-visitor limit (web.js) and DAILY_MAX across everyone, after
// which the page falls back to the dropdowns; a signed-in account (`visitor: false`) isn't counted against it: it's
// measured about once a week, bounded by how many accounts there are.
"use strict";

const UsageEntry = require("../models/UsageEntry");
const HandleEstimate = require("../models/HandleEstimate");
const Person = require("../models/Person");
const { createClient } = require("../lib/x");
const { metered } = require("./usage");
const { handleOf } = require("../lib/handle");

const WINDOW_DAYS = 30;
const DAY_MS = 86400000;
const FRESH_MS = 7 * DAY_MS; // a measurement is good for a week
const REMEASURE_MS = 3600000; // Re-estimate: at most once an hour
const UNKNOWN_MS = DAY_MS; // "X has no such account": asked again after a day (it may be new)
const DAILY_MAX = 500; // visitors' measurements a day, ~3 cents each: ~$15 a day at most

// Per-day rate from X's daily counts, every bucket a whole day (postCounts asks for whole days). → { perDay, days }. Pure.
function rateOf(buckets) {
  if (!buckets.length) return { perDay: 0, days: 0 };
  return { perDay: buckets.reduce((s, b) => s + b.n, 0) / buckets.length, days: buckets.length };
}

// The stored row as the pages take it. → { handle, name, image, written, received, days, posts, measuredAt } or
// { error, handle }. `name` and `image` say whose month it is (the estimate's header: their picture, name and @handle).
const view = (row) => (row.error ? { error: row.error, handle: row.handle } : { handle: row.handle, name: row.name, image: row.image, written: row.written, received: row.received, days: row.days, posts: row.posts, measuredAt: row.measuredAt });

// Measure one account, or return its stored measurement while fresh. → view() or { error: "unknown" | "busy" | "off",
// handle }: "unknown", X has no such account (the handle asked about rides along, so the page can name it); "off",
// this copy can't measure (no Bearer token: a self-hosted copy without Live, or a developer's machine), which the page
// doesn't announce (its guesses stand; it once said "X has no account @." for the owner's own handle).
// `token`: the app's Bearer token. `fresh`: whether this caller may spend (a visitor past web.js's per-visitor limit
// may not: only a stored result shows). `visitor`: counted against DAILY_MAX. `force`: measure now (remeasure).
async function measure(handleText, { token, fresh = true, visitor = true, force = false }) {
  const handle = handleOf(handleText);
  if (!handle) return { error: "unknown", handle: String(handleText || "").replace(/^@/, "").slice(0, 20) };
  if (!token) return { error: "off", handle };
  const _id = handle.toLowerCase();
  const now = Date.now();
  const kept = await HandleEstimate.findById(_id).lean();
  const stillFresh = kept && now - new Date(kept.measuredAt).getTime() < (kept.error ? UNKNOWN_MS : FRESH_MS);
  // A row measured before the estimate's header drew the picture has no `image` key at all (one with no picture on X
  // stores null): it's measured again, once, rather than drawing an initial for the rest of its week.
  const complete = kept && (kept.error || "image" in kept);
  if (kept && stillFresh && complete && !force) return view(kept);
  if (!fresh) return kept && !kept.error ? view(kept) : { error: "busy" };
  if (visitor) {
    const today = new Date(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`);
    if ((await UsageEntry.countDocuments({ kind: "estimate", visitor: true, startedAt: { $gte: today } })) >= DAILY_MAX) {
      return kept && !kept.error ? view(kept) : { error: "busy" };
    }
  }
  const row = await metered({ accountId: null, kind: "estimate", label: `Cost estimate: @${handle}`, visitor }, async (meter) => {
    const x = createClient({ token, meter, readCap: 0, userCap: 1 });
    const user = await x.userByUsername(handle);
    if (!user) return { error: "unknown", handle };
    const [own, to] = await Promise.all([x.postCounts(`from:${user.username}`, WINDOW_DAYS), x.postCounts(`@${user.username} -from:${user.username}`, WINDOW_DAYS)]);
    const w = rateOf(own);
    const r = rateOf(to);
    // `posts`: their lifetime post count, which prices their one-time history read (services/history.js). `image`: their
    // picture, by THE rule (Person.imageOf: X's own host only, 73px), for the estimate's header; null, not left out, when
    // there's none (X's default avatar), so the row reads as measured with it.
    return { handle: user.username, name: user.name, image: Person.imageOf(user.profile_image_url) || null, written: Math.round(w.perDay), received: Math.round(r.perDay), days: Math.min(w.days, r.days), posts: user.public_metrics && user.public_metrics.tweet_count };
  });
  const measuredAt = new Date(now);
  const stored = { ...row, measuredAt, expireAt: new Date(now + (row.error ? UNKNOWN_MS : FRESH_MS)) };
  await HandleEstimate.replaceOne({ _id }, stored, { upsert: true });
  return view(stored);
}

// Settings' Re-estimate: a signed-in account's own handle measured now, unless it was measured within REMEASURE_MS.
// → measure()'s result, or { tooSoon: true }.
async function remeasure(handleText, { token }) {
  const handle = handleOf(handleText);
  const kept = handle && (await HandleEstimate.findById(handle.toLowerCase(), "measuredAt error").lean());
  if (kept && !kept.error && Date.now() - new Date(kept.measuredAt).getTime() < REMEASURE_MS) return { tooSoon: true };
  return measure(handleText, { token, visitor: false, force: true });
}

module.exports = { measure, remeasure, rateOf, WINDOW_DAYS, FRESH_MS, REMEASURE_MS, DAILY_MAX };
