// The Follows page (/follows, web.js): who followed and unfollowed you, one row per event, newest first. Pure: the
// account's FollowEvent rows TO it (direction "in") in, rows out. Drawn by partials/follow-card.hbs (a People card); listed by the one
// listing engine (services/listing.js). Nothing here reads X: the events are what Live stored.
"use strict";

const { createListing, ROWS_PER_PAGE } = require("./listing");

// `events`: FollowEvent rows (direction "in"). ctx: { profiles, known (Set: who has a People page), follows ({ followers,
// following }: the pairs as they stand now, extras.signalsFor), seenBefore (Date: the account last opened this page) }.
// → rows, newest first: { id, kind, at, atMs, person ({ id, username, profile, page }), followsYou, youFollow (now),
// fresh (stored since seenBefore), followers, haystack }.
function followRows(events, { profiles = new Map(), known = new Set(), follows = { followers: new Set(), following: new Set() }, seenBefore = null }) {
  const seen = seenBefore ? new Date(seenBefore).getTime() : Infinity;
  return events
    .filter((e) => e.direction === "in")
    .map((e) => {
      const profile = profiles.get(e.personId) || null;
      const person = { id: e.personId, username: (profile && profile.username) || null, profile, page: known.has(e.personId) ? `/people/${e.personId}` : null };
      const at = new Date(e.at);
      return {
        id: e._id,
        kind: e.kind,
        at,
        atMs: at.getTime(),
        person,
        followsYou: follows.followers.has(e.personId),
        youFollow: follows.following.has(e.personId),
        fresh: new Date(e.seenAt).getTime() > seen,
        followers: (profile && profile.followers) || 0,
        haystack: [person.username, profile && profile.name].filter(Boolean).join(" ").toLowerCase(),
      };
    })
    .sort((a, b) => b.atMs - a.atMs);
}

const listing = createListing({
  path: "/follows",
  defaultSort: "newest",
  pageSize: ROWS_PER_PAGE,
  text: (r) => r.haystack,
  sorts: {
    newest: { value: (r) => r.atMs, natural: "desc" },
    followers: { value: (r) => r.followers, natural: "desc" },
  },
  filters: {
    show: { values: ["all", "follow", "unfollow"], default: "all", test: (r, v) => v === "all" || r.kind === v },
  },
});

module.exports = { followRows, listing };
