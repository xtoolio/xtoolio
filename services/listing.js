// A list you can search, filter, sort and page, server-side: every view is a URL (shareable, back-button-safe, works
// with no JS) and the CSP stays script-light. Pure: rows in, one page out. ONE engine for every list page
// (createListing): Your people (`people`, below) and the Inbox (services/inbox.js `listing`).
//
// Each row keeps its RANK from the order it came in (the leaderboard's ranking, the Inbox's newest-first), so "#4"
// still means 4th after a sort or a search, and ties keep it.
"use strict";

const { handleInLink } = require("../lib/handle");

// spec: {
//   path        where the page lives; every link starts here
//   sorts       { key: { value: (row) => comparable, natural: "asc" | "desc" } }; `natural` is the way a new sort runs
//   defaultSort
//   pageSize
//   text        (row) => the string a search looks in: what the row SHOWS (names, @handles, the words on screen),
//               never what it hides (X's reply @-prefix: every reply to you starts with your handle, and searching it
//               matched the whole Inbox)
//   filters     { key: { values: [...], default, test: (row, value) => bool } } (optional; the default is in no URL).
//               An open-ended one (an X id) says `accepts: (value) => bool` in place of `values`.
// }
//
// THE SEARCH (searchKey, searchTerms, matches): both sides folded to plain lowercase letters (accents dropped,
// "Gregório" → "gregorio"; X's fancy-font names, "𝓜𝓪𝔂𝓪" → "maya", by Unicode's compatibility forms), the query split
// into WORDS that must all appear, in any order ("maya launch": her name and a word of her post), each word's leading
// "@" dropped (a handle), and a pasted profile link read as its handle ("https://x.com/maya" → "maya").

// Plain lowercase letters: compatibility forms (fancy fonts, full-width) unfolded, accents and other marks dropped. Pure.
const searchKey = (s) => String(s || "").normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();

// The words a search looks for, folded: [] for an empty search. A profile link on X (x.com / twitter.com, with or
// without https:// or www.) is its handle. Pure.
function searchTerms(q) {
  const raw = String(q || "").trim();
  const link = handleInLink(raw);
  const words = link ? [link] : raw.split(/\s+/);
  return words.map((w) => searchKey(w.replace(/^@+/, ""))).filter(Boolean);
}

// Does `haystack` (a row's text) hold every term? Pure.
const matches = (haystack, terms) => {
  const hay = searchKey(haystack);
  return terms.every((t) => hay.includes(t));
};

function createListing({ path, sorts, defaultSort, pageSize, text, filters = {} }) {
  const allowed = (f, v) => (f.accepts ? typeof v === "string" && f.accepts(v) : f.values.includes(v));
  // Everything the URL can say, cleaned: unknown keys and values fall back to the defaults, page is clamped later.
  function parseQuery(q = {}) {
    const sort = typeof q.sort === "string" && Object.hasOwn(sorts, q.sort) ? q.sort : defaultSort; // not "constructor"
    const dir = q.dir === "asc" || q.dir === "desc" ? q.dir : sorts[sort].natural;
    const picked = Object.fromEntries(Object.entries(filters).map(([k, f]) => [k, allowed(f, q[k]) ? q[k] : f.default]));
    return { q: typeof q.q === "string" ? q.q.trim().slice(0, 80) : "", sort, dir, ...picked, page: Math.max(1, Number.parseInt(q.page, 10) || 1) };
  }

  // rows: in their own order (the rank). `size` overrides the page size (tests). → { rows, total, matched, page,
  // pages, from, to, ...query }
  function listRows(rows, query, size = pageSize) {
    let list = rows.map((r, i) => ({ ...r, rank: i + 1 }));
    const total = list.length;
    for (const [k, f] of Object.entries(filters)) list = list.filter((r) => f.test(r, query[k]));
    const terms = searchTerms(query.q);
    if (terms.length) list = list.filter((r) => matches(text(r), terms));
    const { value } = sorts[query.sort];
    const sign = query.dir === "asc" ? 1 : -1;
    // Stable: ties keep rank order.
    list = list
      .map((r) => ({ r, v: value(r) }))
      .sort((a, b) => (a.v < b.v ? -sign : a.v > b.v ? sign : a.r.rank - b.r.rank))
      .map((x) => x.r);
    const matched = list.length;
    const pages = Math.max(1, Math.ceil(matched / size));
    const page = Math.min(query.page, pages);
    // Page 1 starts at 0 outright: with `size` Infinity (every match, "Mark all done") (1 - 1) × Infinity is NaN, and a
    // NaN slice is empty. It returned no cards, so Mark all done marked nothing.
    const start = page > 1 ? (page - 1) * size : 0;
    return { ...query, rows: list.slice(start, start + size), total, matched, page, pages, from: matched ? start + 1 : 0, to: Math.min(start + size, matched) };
  }

  // A URL for this list with some parts changed; defaults are left out so URLs stay short.
  function hrefFor(query, change = {}) {
    const next = { ...query, ...change };
    const p = new URLSearchParams();
    if (next.q) p.set("q", next.q);
    for (const [k, f] of Object.entries(filters)) if (next[k] !== f.default) p.set(k, next[k]);
    if (next.sort !== defaultSort) p.set("sort", next.sort);
    if (next.dir !== sorts[next.sort].natural) p.set("dir", next.dir);
    if (next.page > 1) p.set("page", String(next.page));
    const s = p.toString();
    return s ? `${path}?${s}` : path;
  }

  // A sort's link: a new sort runs its natural way, the active one flips.
  function sortHref(query, key) {
    const dir = query.sort === key ? (query.dir === "asc" ? "desc" : "asc") : sorts[key].natural;
    return hrefFor(query, { sort: key, dir, page: 1 });
  }

  // Page links: first, last, and a window around the current page, with gaps marked; plus prev / next.
  function pager(list) {
    const links = [];
    let prev = 0;
    for (let p = 1; p <= list.pages; p++) {
      if (p === 1 || p === list.pages || Math.abs(p - list.page) <= 2) {
        if (p - prev > 1) links.push({ gap: true });
        links.push({ page: p, href: hrefFor(list, { page: p }), current: p === list.page });
        prev = p;
      }
    }
    return {
      links,
      many: list.pages > 1,
      prevHref: list.page > 1 ? hrefFor(list, { page: list.page - 1 }) : null,
      nextHref: list.page < list.pages ? hrefFor(list, { page: list.page + 1 }) : null,
    };
  }

  // The search form's hidden fields: the filters in force (a search keeps them; the sort travels in its own select).
  const keep = (query) => Object.entries(filters).filter(([k, f]) => query[k] !== f.default).map(([k]) => ({ name: k, value: query[k] }));

  return { path, sorts, defaultSort, pageSize, parseQuery, listRows, hrefFor, sortHref, pager, keep };
}

// THE page of LIST ROWS (Your posts, People, Follows): one number, so the pages read alike and the pager shows on a big
// screen. Not following back keeps 50 (one page = one bulk unfollow, X's window) and the Inbox its 20 cards.
const ROWS_PER_PAGE = 20;

// ── Your people: the leaderboard (/people; it was home until the Inbox took `/`) ──
// The default is back and forth, most first: the arrow then points the way the NUMBERS run (↓), which a "rank
// ascending" default got backwards. Ties keep rank order, so the default view is exactly the ranking.
const people = createListing({
  path: "/people",
  defaultSort: "mutual",
  pageSize: ROWS_PER_PAGE,
  text: (r) => `${r.profile && r.profile.name ? r.profile.name : ""} ${r.username || ""}`.toLowerCase(),
  sorts: {
    mutual: { value: (r) => r.mutual, natural: "desc" },
    name: { value: (r) => ((r.profile && r.profile.name) || r.username || r.id).toLowerCase(), natural: "asc" },
    replies: { value: (r) => r.total, natural: "desc" },
    likes: { value: (r) => (r.likedByYou || 0) + (r.likedYou || 0), natural: "desc" },
    followers: { value: (r) => (r.profile && r.profile.followers) || 0, natural: "desc" },
    last: { value: (r) => (r.last ? new Date(r.last).getTime() : 0), natural: "desc" },
  },
});

module.exports = { createListing, people, ROWS_PER_PAGE, searchKey, searchTerms, matches };
