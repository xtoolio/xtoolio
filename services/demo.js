// The front page's hero: two Inbox cards made of INVENTED people and posts, drawn by the real pipeline
// (inbox.inboxRows → partials/thread.hbs), so the picture is always the Inbox as it looks today, in either theme,
// with nobody's real posts on a public page. Times are relative to `now` ("2h"). No pictures (initials), no links that
// matter: the landing renders it `inert`. Pure.
"use strict";

const { inboxRows } = require("./inbox");
const { boardView, SIZES, HANDLES_MAX, sizeOf, capacityOf } = require("./circle");

const ME = "demo-you";
const MIN = 60 * 1000;

// Who's in it (Person-shaped: name, username). Invented names; no picture, so the initial shows, on a colour of their
// own (`hue`, app.css --hue-N: all-grey initials read as dull).
const PEOPLE = {
  [ME]: { name: "You", username: "you", hue: 2 },
  maya: { name: "Maya Okafor", username: "mayaships", hue: 1 },
  dev: { name: "Dev Raman", username: "devmakesthings", hue: 3 },
  lena: { name: "Lena Park", username: "lenaparkdesign", hue: 7 },
  sam: { name: "Sam Ortiz", username: "samortiz_", hue: 4 },
};
// The demo's pictures (public/demo, shapes only; served from the site, as the CSP allows): X's media shape.
const PICTURES = {
  darkMode: { key: "3_1", type: "photo", url: "/demo/dark-mode.svg", width: 1200, height: 750 },
  podium: { key: "16_2", type: "animated_gif", url: "/demo/podium.svg", width: 900, height: 600 },
};

// Snowflake-ordered ids (inboxRows sorts by them) with the time each was posted, minutes ago.
function demoPosts(now) {
  const at = (minsAgo) => new Date(now - minsAgo * MIN);
  const reply = (id, authorId, minsAgo, text, toPost, toUser, extra = {}) => ({ _id: id, authorId, createdAt: at(minsAgo), text, conversationId: extra.conversationId, inReplyToUserId: toUser, referenced: [{ type: "replied_to", id: toPost }], ...extra });
  return [
    // A card about something you asked: two people answered, you answered one of them.
    { _id: "1000000000000000100", authorId: ME, createdAt: at(190), text: "What’s one tool you’d pay for that doesn’t exist yet?", conversationId: "1000000000000000100" },
    reply("1000000000000000110", "maya", 120, "An inbox for my replies. Half of them die in notifications.", "1000000000000000100", ME, { conversationId: "1000000000000000100" }),
    reply("1000000000000000120", ME, 64, "Say less 👀", "1000000000000000110", "maya", { conversationId: "1000000000000000100" }),
    reply("1000000000000000130", "dev", 22, "Something that tells me who I actually talk to on here. Ranked.", "1000000000000000100", ME, { conversationId: "1000000000000000100", media: [PICTURES.podium] }),
    // A card where someone only tagged you, under someone else's post.
    { _id: "1000000000000000050", authorId: "lena", createdAt: at(400), text: "Hot take: most dashboards are just anxiety with charts.", conversationId: "1000000000000000050" },
    reply("1000000000000000060", "sam", 300, "@lenaparkdesign @you this is literally your whole brand", "1000000000000000050", "lena", {
      conversationId: "1000000000000000050",
      mentions: [{ id: "lena", username: "lenaparkdesign", start: 0, end: 15 }, { id: ME, username: "you", start: 16, end: 20 }],
    }),
  ];
}

// → the Inbox rows for the hero, newest first.
function demoInbox(now = Date.now()) {
  const posts = demoPosts(now);
  const profiles = new Map(Object.entries(PEOPLE).map(([id, p]) => [id, { _id: id, ...p }]));
  const likers = new Map([
    ["1000000000000000100", ["maya", "dev", "lena"]], // your question
    ["1000000000000000110", [ME]], // you liked Maya's
    ["1000000000000000120", ["maya"]], // she liked your answer
  ]);
  return inboxRows(posts, ME, { byId: new Map(posts.map((p) => [p._id, p])), profiles, likers, canLike: true, canRepost: true });
}

// THE TOUR (views/landing.hbs: a very simple carousel of the app's pages, drawn, with the use cases beside
// it, every claim plainly true): one invented account's pages,
// drawn by the real partials, every number agreeing with what's drawn (the thread line counts the replies under it,
// the toolbar the cards). Invented people only, each on their own colour (`hue`), and two invented pictures.
const TOUR_PEOPLE = {
  ...PEOPLE,
  priya: { name: "Priya Shah", username: "priyabuilds", followers: 2140, following: 610, hue: 5 },
  jon: { name: "Jon Vale", username: "jonvale_makes", followers: 890, following: 1204, hue: 6 },
  kai: { name: "Kai Moreno", username: "kaimoreno", followers: 5310, following: 402, hue: 8 },
  ola: { name: "Ola Nwosu", username: "olanwosu", followers: 312, following: 288, hue: 1 },
  nina: { name: "Nina Ross", username: "ninaross", followers: 1520, following: 980, hue: 7 },
  rob: { name: "Rob Haines", username: "robhaines", followers: 48200, following: 120, hue: 2 },
  tess: { name: "Tess Kim", username: "tesskim_", followers: 760, following: 815, hue: 3 },
  ben: { name: "Ben Okoro", username: "benokoro_", followers: 3050, following: 2210, hue: 4 },
  zoe: { name: "Zoe Hart", username: "zoehart", followers: 96, following: 340, hue: 5 },
  ari: { name: "Ari Lev", username: "arilev", followers: 214, following: 1990, hue: 6 },
  cole: { name: "Cole Diaz", username: "colediaz", followers: 431, following: 3870, hue: 8 },
  ivy: { name: "Ivy Chen", username: "ivychen", followers: 655, following: 702, hue: 1 },
  // Only in your circle (with CROWD below).
  max: { name: "Max Weber", username: "maxw", hue: 2 },
  eva: { name: "Eva Lund", username: "evalund", hue: 3 },
  leo: { name: "Leo Grant", username: "leogrant", followers: 12900, following: 410, hue: 4 },
  mia: { name: "Mia Torres", username: "miatorres", hue: 5 },
  raj: { name: "Raj Patel", username: "rajbuilds", hue: 6 },
  ana: { name: "Ana Silva", username: "anasilva", hue: 7 },
  tom: { name: "Tom Becker", username: "tombecker", hue: 8 },
  uma: { name: "Uma Rao", username: "umarao", hue: 1 },
};
// YOUR CIRCLE's crowd: the drawn circle is full (the classic's 48: the named 24 above, then these), so the tour shows it
// as a real account's looks. Invented names, first × last, each on a colour; only their initial and name (the tooltip) show.
const FIRST = ["Abby", "Ben", "Cara", "Dan", "Elle", "Finn", "Gia", "Hugo", "Iris", "Jay", "Kim", "Liam", "Mae", "Noah", "Opal", "Pia", "Quinn", "Ruth", "Sol", "Theo", "Uri", "Vera", "Wes", "Yara", "Zed"];
const LAST = ["Abel", "Brook"];
const CROWD = [];
for (let i = 0; CROWD.length < 24; i++) {
  const first = FIRST[i % FIRST.length];
  const last = LAST[Math.floor(i / FIRST.length) % LAST.length];
  const id = `crowd${i}`;
  TOUR_PEOPLE[id] = { name: `${first} ${last}`, username: `${first}${last}`.toLowerCase(), hue: ((i * 5) % 8) + 1 };
  CROWD.push(id);
}
TOUR_PEOPLE.maya = { ...PEOPLE.maya, followers: 3480, following: 512 };
TOUR_PEOPLE.dev = { ...PEOPLE.dev, followers: 1960, following: 744 };
TOUR_PEOPLE.lena = { ...PEOPLE.lena, followers: 8720, following: 390 };
TOUR_PEOPLE.sam = { ...PEOPLE.sam, followers: 1105, following: 1340 };

const personOf = (id) => ({ id, username: TOUR_PEOPLE[id].username, profile: { _id: id, ...TOUR_PEOPLE[id] }, page: null });

function demoTour(now = Date.now()) {
  const at = (minsAgo) => new Date(now - minsAgo * MIN);
  const profiles = new Map(Object.entries(TOUR_PEOPLE).map(([id, p]) => [id, { _id: id, ...p }]));

  // Each card's own "♥ Like N", as web.js draws it on a real card: what it still owes a like, one press at most
  // LIKE_ALL_MAX (X's 50 in a window, a fresh one here).
  const withCardLike = (r) => ({ ...r, cardLike: r.owedSplit.like ? { n: r.owedSplit.like, key: `post-${r.conversationId}`, person: null, likeN: Math.min(r.owedSplit.like, 50) } : null });
  // The toolbar's two presses over these cards, counted from them.
  const toolbarOf = (rows) => ({ like: rows.reduce((s, r) => s + r.owedSplit.like, 0), done: rows.reduce((s, r) => s + r.waitingReplies, 0) });

  // The Inbox.
  const inbox = demoInbox(now).map(withCardLike);
  const toolbar = toolbarOf(inbox);

  // A thread: four people answered your post. Where you stand with each (the pairs) decides the line above it and the
  // Follow beside each name: Priya and Jon follow you, Kai is mutual, Ola neither.
  const conv = "1000000000000000300";
  const reply = (id, who, minsAgo, text) => ({ _id: id, authorId: who, createdAt: at(minsAgo), text, conversationId: conv, inReplyToUserId: ME, referenced: [{ type: "replied_to", id: conv }] });
  const threadPosts = [
    { _id: conv, authorId: ME, createdAt: at(240), text: "Shipped dark mode tonight. What should I build next?", conversationId: conv, media: [PICTURES.darkMode] },
    reply("1000000000000000310", "priya", 200, "Keyboard shortcuts. Please."),
    reply("1000000000000000320", "kai", 150, "Export to CSV and I'm yours"),
    reply("1000000000000000330", "jon", 90, "Following for the answer"),
    reply("1000000000000000340", "ola", 30, "An undo for everything"),
  ];
  const follows = { followers: new Set(["priya", "jon", "kai"]), following: new Set(["kai"]) };
  const threadLikers = new Map([
    [conv, ["priya", "kai", "jon", "ola", "maya"]], // your post
    ["1000000000000000320", [ME]], // you liked Kai's
  ]);
  const threadRow = withCardLike(inboxRows(threadPosts, ME, { byId: new Map(threadPosts.map((p) => [p._id, p])), profiles, likers: threadLikers, canLike: true, canRepost: true, follows })[0]);
  const writers = ["priya", "kai", "jon", "ola"];
  const notFollowed = writers.filter((w) => !follows.following.has(w));
  const back = notFollowed.filter((w) => follows.followers.has(w));
  const thread = { row: threadRow, toolbar: toolbarOf([threadRow]), follow: { who: { n: writers.length, did: "wrote here" }, all: notFollowed.length, back: back.length, allN: notFollowed.length, backN: back.length, left: 50, resetAt: null, action: "/inbox/follow-all", fields: [{ name: "post", value: conv }], faces: { people: [...back, ...notFollowed.filter((w) => !back.includes(w))].map(personOf), more: 0 } } };

  // Follows: who followed and unfollowed you, newest first, and where you stand now.
  const event = (id, kind, who, minsAgo, youFollow) => ({ id, kind, at: at(minsAgo), person: personOf(who), followsYou: kind === "follow", youFollow });
  const followsFeed = [event("e1", "follow", "nina", 4, false), event("e2", "unfollow", "rob", 55, true), event("e3", "follow", "tess", 130, true), event("e4", "unfollow", "ben", 310, false)];

  // Not following back: who you follow that doesn't follow you, the smallest first, each picked for the bulk unfollow.
  const notBack = ["zoe", "ari", "cole", "ivy"].map((who) => ({ id: who, kind: "back", person: personOf(who), followsYou: false, youFollow: true, picking: true, picked: true }));

  // Who they tag (Follows → Who they tag): the accounts Rob's last 200 posts tag, most first, none you follow yet (the
  // page's default view), each picked for the bulk follow. Priya and Nina follow you (Follow back), as on the other screens.
  const tagger = personOf("rob");
  const tag = (who, n, minsAgo) => ({ id: who, kind: "tagged", person: personOf(who), followsYou: ["priya", "nina"].includes(who), youFollow: false, tagged: n, lastAt: at(minsAgo), picking: true, picked: true, pickVerb: "follow", pickForm: "follow-many" });
  const tags = { by: tagger, posts: 200, rows: [tag("priya", 6, 180), tag("nina", 4, 1500), tag("ola", 3, 2900), tag("leo", 2, 5200)] };

  // Your people: who you go back and forth with, ranked by the smaller side.
  const person = (who, out, inn, likedByYou, likedYou, minsAgo, followsYou = true, youFollow = true) => ({ id: who, username: TOUR_PEOPLE[who].username, profile: { _id: who, ...TOUR_PEOPLE[who] }, mutual: Math.min(out, inn), out, in: inn, likedByYou, likedYou, last: at(minsAgo), followsYou, youFollow });
  const board = [person("maya", 41, 38, 52, 47, 64), person("dev", 22, 25, 30, 19, 22), person("lena", 14, 12, 9, 15, 400, true, false), person("sam", 9, 7, 6, 4, 300)];

  // Your circle (the sidebar's Circle): you in the middle, the same ranking around you, THE CLASSIC 50 (overlapping
  // faces) with every ring full, drawn by THE circle partial from services/circle.js's board view; the size tabs over
  // it. The classic 50 with overlapping faces (it briefly showed 250).
  const SIZE = "50";
  const ranked = ["maya", "dev", "lena", "sam", "kai", "priya", "tess", "nina", "jon", "ola", "rob", "ben", "zoe", "ari", "cole", "ivy", "max", "eva", "leo", "mia", "raj", "ana", "tom", "uma", ...CROWD];
  const members = ranked.slice(0, capacityOf(sizeOf(SIZE)));
  const circle = { ...boardView(personOf(ME), members.map(personOf), SIZE), sizes: SIZES.map((s) => ({ key: s.key, on: s.key === SIZE })), handlesN: Math.min(members.length, HANDLES_MAX), handlesTop: members.length > HANDLES_MAX };

  return { inbox, toolbar, thread, follows: followsFeed, notBack, tags, board, circle };
}

// THE USE CASES beside the tour, in its slides' order (`key` = the slide, views/landing.hbs; `nav` = the sidebar place
// lit on its screen): one short line each, nothing under it (the section is called Use cases, no
// sub-text). Nothing here that isn't built. No AI
// agent case (it used to be second, its screen the drafts; the product isn't an agentic system, the
// MCP door is useful to know but not the product, so no picture of it): it's the small
// "Bring your own agent" section at the page's foot (partials/byo-agent.hbs), with no picture.
const TOUR_CASES = [
  { key: "inbox", nav: "inbox", title: "Clear last night’s replies in one queue" },
  { key: "like", nav: "inbox", title: "Like every reply in one press" },
  { key: "thread", nav: "inbox", title: "Follow back a whole thread" },
  { key: "follows", nav: "follows", title: "See who followed and unfollowed you" },
  { key: "back", nav: "follows", title: "Unfollow who doesn’t follow back" },
  { key: "tags", nav: "follows", title: "Follow who an account tagged recently" },
  { key: "people", nav: "people", title: "Know who you actually talk to" },
  { key: "circle", nav: "people", title: "Share your circle" },
];

module.exports = { demoTour, TOUR_CASES };
