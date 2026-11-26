// No network, no database: the leaderboard math and the sync's paging logic.
//   npm run verify
const assert = require("assert");
const { leaderboard, threads } = require("../services/people");
const { streamSteps, readForward, pageShare, backfillPageSize, runReadCap, profilesToFetch, contextToFetch } = require("../services/sync");
const { createClient } = require("../lib/x");
const { untilKnown, newLikesPageSize, likesPlan, afterBackfillPage } = require("../services/extras");
const listing = require("../services/listing").people;
const { historyOptions } = require("../services/history");
const { estimatePull, costOf } = require("../lib/pricing");
const Person = require("../models/Person");
const Post = require("../models/Post");
const { segments, bioSegments } = require("../services/text");

const ME = "1";
const own = (id, to, mentions = []) => ({ _id: id, stream: "own", authorId: ME, inReplyToUserId: to, createdAt: `2026-01-${id.padStart(2, "0")}`, mentions });
// A post from your mentions feed mentions you (that's what the feed is), so the fixture says so too.
const men = (id, from, mentions = []) => ({ _id: id, stream: "mention", authorId: from, createdAt: `2026-01-${id.padStart(2, "0")}`, mentions: [{ id: ME }, ...mentions] });

// ── leaderboard ──
// ann: 2 out / 2 in  → mutual 2
// bob: 0 out / 6 in  → mutual 0 (one-way fan), must rank BELOW ann despite more traffic
// cat: 1 out / 0 in  → mutual 0, total 1
// self-replies (threads) never count
const posts = [
  own("1", "10", [{ id: "10", username: "ann" }]),
  own("2", "10", [{ id: "10", username: "ann" }]),
  own("3", "30", [{ id: "30", username: "cat" }]),
  own("4", ME),
  men("5", "10"),
  men("6", "10"),
  ...["7", "8", "9", "11", "12", "13"].map((id) => men(id, "20")),
];
const board = leaderboard(posts, ME);
assert.deepStrictEqual(board.map((r) => r.id), ["10", "20", "30"], "ranked by mutual, then total");
assert.strictEqual(board[0].mutual, 2);
assert.strictEqual(board[0].username, "ann");
assert.strictEqual(board[1].username, null, "bob only ever mentions us — unnamed until his profile is fetched");
assert.ok(!board.some((r) => r.id === ME), "self-replies are not a person");

// ── a reply's pictures (lib/media.js): the type from the bytes, X's rules ──
{
  const { sniff, checkAttachments, MEDIA_LIMITS } = require("../lib/media");
  const pad = (head, n = 16) => Buffer.concat([head, Buffer.alloc(Math.max(0, n - head.length))]);
  const png = pad(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpg = pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  const webp = pad(Buffer.from("RIFF\0\0\0\0WEBP", "latin1"));
  const gif = pad(Buffer.from("GIF89a"));
  assert.deepStrictEqual([png, jpg, webp, gif].map(sniff), ["png", "jpeg", "webp", "gif"], "types from the first bytes");
  assert.strictEqual(sniff(pad(Buffer.from("<svg xmlns="))), null, "an SVG (or anything else) isn't a picture X takes");
  assert.deepStrictEqual(checkAttachments([]), { ok: true, items: [] });
  assert.deepStrictEqual(checkAttachments([{ buffer: png }, { buffer: jpg }]).items.map((i) => [i.mime, i.category]), [["image/png", "tweet_image"], ["image/jpeg", "tweet_image"]]);
  assert.strictEqual(checkAttachments([{ buffer: gif }]).items[0].category, "tweet_gif", "a GIF goes as tweet_gif");
  assert.strictEqual(checkAttachments([{ buffer: gif }, { buffer: png }]).notice, "media-mix", "a GIF goes alone");
  assert.strictEqual(checkAttachments(Array(MEDIA_LIMITS.photos + 1).fill({ buffer: png })).notice, "media-many");
  assert.strictEqual(checkAttachments([{ buffer: pad(png, MEDIA_LIMITS.photoBytes + 1) }]).notice, "media-big", "a photo over 5 MB");
  assert.ok(checkAttachments([{ buffer: pad(gif, MEDIA_LIMITS.photoBytes + 1) }]).ok, "a GIF may be over 5 MB");
  assert.strictEqual(checkAttachments([{ buffer: pad(Buffer.from("hello there, not a picture")) }]).notice, "media-type", "named .png or not, it's the bytes");
  // An MP4: uploaded, a VIDEO (alone, up to videoBytes); from your own media, X's copy of a GIF you posted, as a GIF.
  const mp4 = pad(Buffer.from("\0\0\0\x20ftypisom", "latin1"));
  assert.strictEqual(sniff(mp4), "mp4");
  assert.deepStrictEqual(checkAttachments([{ buffer: mp4 }]).items.map((i) => [i.mime, i.category]), [["video/mp4", "tweet_video"]], "an uploaded MP4 goes as a video");
  assert.strictEqual(checkAttachments([{ buffer: mp4 }, { buffer: png }]).notice, "media-mix", "a video goes alone");
  assert.ok(checkAttachments([{ buffer: pad(mp4, MEDIA_LIMITS.gifBytes + 1) }]).ok, "a video may be over a GIF's size");
  assert.strictEqual(checkAttachments([{ buffer: pad(mp4, MEDIA_LIMITS.videoBytes + 1) }]).notice, "media-big", "but not over its own");
  assert.deepStrictEqual(checkAttachments([{ buffer: mp4, fromLibrary: true }]).items.map((i) => [i.mime, i.category]), [["video/mp4", "tweet_gif"]], "your GIF, from X's MP4");
  assert.strictEqual(checkAttachments([{ buffer: mp4, fromLibrary: true }, { buffer: png }]).notice, "media-mix", "and it still goes alone");
  assert.ok(MEDIA_LIMITS.videoBytes < 25 * 1024 * 1024, "a video fits under nginx's 25 MB request limit (deploy/nginx-xtoolio.conf)");
  const { sourceOf } = require("../lib/media");
  assert.deepStrictEqual(sourceOf({ type: "photo", url: "https://pbs.twimg.com/media/AbCdEfGhIjKl_Mn.jpg" }), { url: "https://pbs.twimg.com/media/AbCdEfGhIjKl_Mn.jpg?name=orig", kind: "photo" });
  assert.deepStrictEqual(sourceOf({ type: "animated_gif", url: "https://pbs.twimg.com/tweet_video_thumb/ZyXwVuTsRqPoNmL.jpg" }), { url: "https://video.twimg.com/tweet_video/ZyXwVuTsRqPoNmL.mp4", kind: "gif" });
  assert.strictEqual(sourceOf({ type: "video", url: "https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/a.jpg" }), null, "videos aren't offered");
  assert.strictEqual(sourceOf({ type: "photo", url: "https://evil.example/media/a.jpg" }), null, "only X's hosts");
}

// ── your circle (services/circle.js): who's in it, the rings, the seats ──
{
  const circle = require("../services/circle");
  // Seats 0, 8 and 47 of a full classic as services/circle.js placed them before the sizes were added.
  const CLASSIC_SEATS = [["cs-1-8-0", 379.71, 248.1, 53.85], ["cs-2-0", 427.97, 144.8, 48.59], ["cs-3-23", 290.87, 67.7, 45.49]];
  assert.deepStrictEqual(circle.members(board).map((r) => r.id), ["10"], "only a real back and forth: bob's mentions and our one reply to cat don't count");
  const many = Array.from({ length: 400 }, (_, i) => ({ id: String(i), mutual: 400 - i }));
  // THE SIZES: 50 the classic (8 + 16 + 24 = 48, as it always was), 100 and 250 the rings, exactly; the classic by default.
  assert.deepStrictEqual(circle.SIZES.map((s) => [s.key, circle.capacityOf(s)]), [["50", 48], ["100", 100], ["250", 250]]);
  assert.strictEqual(circle.sizeOf(undefined).key, "50", "the classic by default");
  assert.strictEqual(circle.sizeOf("nonsense").key, "50");
  for (const [size, cap] of [["50", 48], ["100", 100], ["250", 250]]) {
    assert.strictEqual(circle.members(many, size).length, cap, `size ${size}: at most its rings' seats`);
  }
  assert.deepStrictEqual(circle.members(many, "250").slice(0, 3).map((r) => r.id), ["0", "1", "2"], "in the leaderboard's order");
  // Only the people drawn: 80 eligible at 250 fill the inner ring and the second (56); at 50, 40 fill 8 + 16.
  assert.strictEqual(circle.members(many.slice(0, 80), "250").length, 56, "members are exactly who's drawn");
  assert.strictEqual(circle.members(many.slice(0, 40), "50").length, 24);
  // THE CLOSENESS ORDER: the likes they gave your posts count, a third of a back and forth each.
  {
    const rows = [{ id: "a", mutual: 3, total: 6 }, { id: "b", mutual: 2, total: 9 }, { id: "c", mutual: 0, total: 4 }];
    const order = circle.ranked(rows, new Map([["b", 6], ["c", 3], ["liker", 3], ["once", 2]])).map((r) => [r.id, r.closeness]);
    assert.deepStrictEqual(order.map(([id]) => id), ["b", "a", "c", "liker"], "6 likes lift b (2 + 2) past a (3); three likes are one back and forth");
    assert.ok(!order.some(([id]) => id === "once"), "two likes alone aren't enough");
    assert.ok(order.some(([id]) => id === "liker"), "someone who only likes your posts is in it");
    assert.deepStrictEqual(circle.ranked(rows).map((r) => r.id), ["a", "b"], "no likes known: the back and forth alone, as before");
    assert.strictEqual(circle.members(rows, "50", new Map([["liker", 3]])).find((r) => r.id === "liker").profile, null, "a liker's profile is the caller's to fill (services/conversations.js circleFor)");
  }
  // A ring is drawn only when full; the inner ring takes any 1..n; never past the size's rings.
  const S = (k) => circle.sizeOf(k);
  for (const [size, n, want] of [["50", 0, [0, 0, 0]], ["50", 5, [5, 0, 0]], ["50", 20, [8, 0, 0]], ["50", 24, [8, 16, 0]], ["50", 48, [8, 16, 24]], ["50", 300, [8, 16, 24]], ["250", 5, [5, 0, 0, 0, 0, 0]], ["250", 55, [20, 0, 0, 0, 0, 0]], ["250", 56, [20, 36, 0, 0, 0, 0]], ["250", 250, [20, 36, 41, 46, 51, 56]], ["250", 300, [20, 36, 41, 46, 51, 56]], ["100", 300, [20, 38, 42]]]) {
    assert.deepStrictEqual(circle.ringCounts(n, S(size)), want, `ringCounts(${n}) at ${size}`);
  }
  // THE ZOOM: the rings' fewer rings are enlarged (at most 1.4), a full 250 isn't; the classic never zooms.
  assert.ok(circle.zoomOf(5, "250") === 1.4 && circle.zoomOf(250, "250") < 1.03 && circle.zoomOf(56, "250") > circle.zoomOf(97, "250") && circle.zoomOf(100, "100") > 1.3, "zoom shrinks as rings fill");
  assert.ok([1, 8, 24, 48].every((n) => circle.zoomOf(n, "50") === 1), "the classic never zooms");
  const css = circle.circleCss();
  for (const k of [0, 1, 2, 6]) assert.ok(css.includes(`.circle-board.g-r250.cz-${k} { --z:`), `zoom class cz-${k}`);
  for (const k of [0, 3]) assert.ok(css.includes(`.circle-board.g-classic.cz-${k} { --z: 1; }`), `the classic's cz-${k} is 1`);
  assert.ok(css.includes(".circle-board.g-classic::before { background: radial-gradient"), "the classic's ring lines");
  // Every seat any layout uses is placed by /circle.css and sits inside its board at its zoom.
  for (const size of ["50", "100", "250"]) {
    const geo = S(size).geo;
    for (const n of [1, 2, 3, 8, 20, 24, 48, 56, 58, 100, 250]) {
      const seats = circle.layout(many.slice(0, n), size);
      const z = circle.zoomOf(n, size);
      const half = geo.BOARD / 2;
      for (const s of seats) {
        assert.ok(css.includes(`.circle-board.g-${geo.key} .${s.slot} {`), `${s.slot} is in circle.css (${size})`);
        assert.ok(Math.hypot(s.x - half, s.y - half) * z + s.a * z <= half + 0.5, `${s.slot} inside the board at zoom ${z} (${size})`);
      }
      // THE CLASSIC: neighbours in a full ring sit close (kissing or a little over, on purpose: no gap over 12) but
      // never so far over that a face is hidden (centres over 75% of their radii apart). THE RINGS: nothing touches.
      for (const ring of [1, 2, 3, 4, 5, 6]) {
        const r = seats.filter((s) => s.ring === ring);
        for (let i = 0; i + 1 < r.length; i++) {
          const d = Math.hypot(r[i].x - r[i + 1].x, r[i].y - r[i + 1].y);
          if (geo.key === "classic") {
            assert.ok(d > 0.75 * (r[i].a + r[i + 1].a), `classic ring ${ring} seats ${i} and ${i + 1} don't hide each other (${n} people)`);
            if (n === 48) assert.ok(d < r[i].a + r[i + 1].a + 12, `classic ring ${ring} seats ${i} and ${i + 1} sit close when full`);
          } else assert.ok(d >= r[i].a + r[i + 1].a + 4, `ring ${ring} seats ${i} and ${i + 1} don't touch (${n} people)`);
        }
      }
    }
  }
  for (const geo of [circle.RINGS_100, circle.RINGS_250]) geo.RINGS.forEach((g, k) => {
    const inside = k === 0 ? geo.CENTER.a : geo.RINGS[k - 1].r + geo.RINGS[k - 1].a;
    assert.ok(g.r - g.a >= inside + 4, `ring ${k + 1} clears what's inside it`);
  });
  // THE CLASSIC is the original circle to the pixel: a few of its seats as that code placed them.
  const classic = circle.layout(many.slice(0, 48), "50");
  assert.deepStrictEqual([classic[0], classic[8], classic[47]].map((s) => [s.slot, +s.x.toFixed(2), +s.y.toFixed(2), +s.a.toFixed(2)]), CLASSIC_SEATS, "the classic's seats unchanged");
  // THE board view: the classic's pictures all at X's 200px and no pill; the rings' you at 400px, the inner ring 200px,
  // the outer rings the stored 73px, and the pill.
  const pic = (id) => ({ id, profile: { image: `https://pbs.twimg.com/profile_images/${id}/a_bigger.jpg` } });
  const bv = circle.boardView(pic("me"), many.slice(0, 56).map((p) => pic(p.id)), "250");
  assert.ok(bv.me.profile.image.endsWith("_400x400.jpg") && bv.dots[0].person.profile.image.endsWith("_200x200.jpg") && bv.dots[55].person.profile.image.endsWith("_bigger.jpg"), "picture sizes by ring");
  assert.deepStrictEqual([bv.board, bv.around], ["g-rings g-r250 cz-2", 56]);
  const bc = circle.boardView(pic("me"), many.slice(0, 48).map((p) => pic(p.id)), "50");
  assert.ok(bc.me.profile.image.endsWith("_200x200.jpg") && bc.dots[47].person.profile.image.endsWith("_200x200.jpg"), "the classic: every picture at 200px");
  assert.deepStrictEqual([bc.board, bc.around], ["g-classic cz-3", null]);
  assert.strictEqual(circle.bigImage("https://pbs.twimg.com/profile_images/1/a_bigger.jpg"), "https://pbs.twimg.com/profile_images/1/a_200x200.jpg");
  assert.strictEqual(circle.bigImage(undefined), undefined);
  // The share image's colours come from app.css's light tokens (services/circleImage.js lightTokens).
  const fs = require("fs");
  const { lightTokens } = require("../services/circleImage");
  const tokens = lightTokens(fs.readFileSync(require("path").join(__dirname, "..", "public", "app.css"), "utf8"));
  for (const t of ["bg", "surface", "ink", "muted", "accent", "line", "them"]) assert.ok(/^#[0-9a-f]{6}$/i.test(tokens[t] || ""), `--${t} read from app.css's light :root`);
}

// ── threads ──
// P = the person, T = a third party. Three threads:
//   A (200): T's root ← P (context) ← you → P ← P replies to you ← T chimes
//            in ← P answers. Topic = the two posts before your reply.
//   B (300): your reply to P, whose parent 300 isn't stored; quotes T's 400.
//   C (500): a 5-post topic by T and P before your reply: folds.
const P = "50";
const T = "60";
const tp = (id, stream, author, conv, opts = {}) => ({
  _id: id,
  stream,
  authorId: author,
  conversationId: conv,
  createdAt: opts.at || `2026-01-0${opts.day || 1}`,
  inReplyToUserId: opts.to,
  referenced: [
    ...(opts.parent ? [{ type: "replied_to", id: opts.parent }] : []),
    ...(opts.quote ? [{ type: "quoted", id: opts.quote }] : []),
  ],
  text: `post ${id}`,
  mentions: stream === "mention" ? [{ id: ME }] : [], // a mentions-feed post mentions you
});
const tposts = [
  tp("200", "context", T, "200"),
  tp("201", "context", P, "200", { parent: "200", to: T }),
  tp("202", "own", ME, "200", { parent: "201", to: P, day: 2 }),
  tp("203", "mention", P, "200", { parent: "202", to: ME, day: 3 }),
  tp("204", "context", T, "200", { parent: "203", to: P, day: 3 }),
  tp("206", "mention", P, "200", { parent: "204", to: T, day: 3 }),
  tp("301", "own", ME, "300", { parent: "300", to: P, quote: "400", day: 5 }),
  tp("400", "context", T, "400"),
  tp("500", "context", T, "500"),
  tp("501", "context", T, "500", { parent: "500" }),
  tp("502", "context", T, "500", { parent: "501" }),
  tp("503", "context", T, "500", { parent: "502" }),
  tp("504", "context", P, "500", { parent: "503" }),
  tp("505", "own", ME, "500", { parent: "504", to: P, day: 4 }),
];
const tprofiles = new Map([[T, { _id: T, username: "third", name: "Third" }]]);
const th = threads(tposts, ME, P, tprofiles);
const ids = (items) => items.map((i) => i.id);
assert.deepStrictEqual(th.map((t) => t.id), ["300", "500", "200"], "newest exchange first");

const [b, c, a] = th;
assert.deepStrictEqual(ids(a.topic), ["200", "201"], "topic: everything before your exchange, even P's own post");
assert.deepStrictEqual(ids(a.dialogue), ["202", "203", "204", "206"], "dialogue from the first exchange on, oldest first");
assert.deepStrictEqual(a.dialogue.map((i) => i.side), ["me", "them", "them", "them"]);
assert.deepStrictEqual(a.dialogue.map((i) => i.runStart), [true, true, true, true], "each author change starts a run");
assert.strictEqual(a.dialogue[2].author.profile.name, "Third", "third parties get their profile");

assert.deepStrictEqual(ids(b.topic), [], "no topic when your reply is the first stored post");
assert.deepStrictEqual(ids(b.dialogue), ["301"]);
assert.strictEqual(b.dialogue[0].quoted.id, "400");
assert.strictEqual(b.dialogue[0].quoted.author.username, "third");

assert.deepStrictEqual(ids(c.topic), ["500", "501", "502", "503", "504"], "a long topic shows whole, nothing folded");
assert.deepStrictEqual(ids(c.dialogue), ["505"]);

// The table row for each conversation: what it's about (its first stored post), who wrote how much, and who
// had the last word. A: T's post is the subject; P answered last → their word.
assert.deepStrictEqual([a.about.text, a.about.author.id, a.you, a.them, a.lastWord], ["post 200", T, 1, 2, "them"]);
assert.deepStrictEqual([b.lastWord, c.lastWord], ["you", "you"]);

// Who liked a post, as the conversation shows it under the post.
const { likeLine } = require("../services/people");
assert.deepStrictEqual(
  [[ME], [P], [P, ME], [P, "x", "y"], ["x"], [ME, P, "x"], [], undefined].map((l) => likeLine(l, ME, [{ id: P, name: "Pat" }])),
  ["You", "Pat", "You and Pat", "Pat and 2 others", "1 person", "You, Pat and 1 other", null, null]
);
// Several named (an Inbox card's writers, under the post they answered): everyone who liked it by name.
const two = [{ id: P, name: "Pat" }, { id: T, name: "Tim" }];
assert.deepStrictEqual([likeLine([P, T], ME, two), likeLine([ME, P, T], ME, two), likeLine([T, "x"], ME, two)], ["Pat and Tim", "You, Pat and Tim", "Tim and 1 other"]);
// YOUR POSTS (services/likes.js postRows; it was the Likes page): every post of yours, and each reply of
// yours that drew something, with its likes, reposts and replies; the latest activity first. X's like time when known
// (a live like); a like X gave no time (the likers check's) dates nothing, so the row keeps its post's time. Your own
// like, and a like on a post that isn't yours, are left out; `fresh` = a LIVE like or repost since you last opened it.
{
  const { postRows, listing: likesListing } = require("../services/likes");
  const mine = (id, createdAt, refs = []) => ({ _id: id, authorId: ME, createdAt, text: `mine ${id}`, referenced: refs });
  const posts = [
    mine("700", "2026-01-01", [{ type: "replied_to", id: "600" }]), // a reply of yours that drew likes: listed
    mine("701", "2026-01-03"), // a post: listed
    mine("702", "2026-01-02"), // a post nobody touched: listed all the same
    mine("703", "2026-01-02", [{ type: "replied_to", id: "601" }]), // a reply nobody touched: not listed
    mine("704", "2026-01-08", [{ type: "retweeted", id: "602" }]), // a plain repost of someone's post: not yours to list
    { _id: "705", authorId: P, createdAt: "2026-01-02", text: "theirs", referenced: [] }, // not yours
  ];
  const lk = (postId, likerId, seenAt, likedAt) => ({ postId, likerId, seenAt: new Date(seenAt), ...(likedAt && { likedAt: new Date(likedAt) }) });
  const likesOn = [
    lk("700", P, "2026-01-05"), // found by the likers check after you looked: no time, not new
    lk("700", T, "2026-01-06", "2026-01-06"), // live, after you looked: new
    lk("701", P, "2026-01-09"), // found by the check on the 9th: no time, so 701 keeps its own (the 3rd)
    lk("701", ME, "2026-01-09"), // your own like on your post: not counted
    lk("705", T, "2026-01-09", "2026-01-09"), // on someone else's post
  ];
  const profiles = new Map([[P, { username: "pat", name: "Pat" }], [T, { username: "tim", name: "Tim" }]]);
  const rows = postRows(posts, { meId: ME, likes: likesOn, profiles, seenBefore: new Date("2026-01-04T12:00Z") });
  assert.deepStrictEqual(rows.map((r) => [r.postId, r.count, r.likers.map((u) => u.profile && u.profile.name), r.fresh]), [["700", 2, ["Tim", "Pat"], true], ["701", 1, ["Pat"], false], ["702", 0, [], false]], "posts all listed, replies only with something, newest liker first, your own like not counted");
  assert.deepStrictEqual(rows[1].latestAt, new Date("2026-01-03"), "a like X gave no time leaves the post's own time");
  assert.strictEqual(rows[0].href, "/posts/700", "a row opens the post here");
  assert.deepStrictEqual(postRows(posts, { meId: ME, likes: [lk("700", P, "2026-01-09")], seenBefore: new Date("2026-01-04") })[0].fresh, false, "a like the check found after you looked is not new");
  // A live like you watched arrive on another page (Like.viewedAt, POST /posts/viewed) isn't new here.
  const watched = { ...lk("700", T, "2026-01-06", "2026-01-06"), viewedAt: new Date("2026-01-06") };
  assert.deepStrictEqual(postRows(posts, { meId: ME, likes: [watched], seenBefore: new Date("2026-01-04") })[0].fresh, false, "a like you saw arrive elsewhere is not new");
  // REPOSTS and REPLIES ride on their post's row: counted apart, their faces among the likers' (newest first, once
  // each), a repost news like a live like; a reply moves the row to its time; your own repost or reply isn't one.
  const rpOf = (postId, who, at) => ({ postId, reposterId: who, repostedAt: new Date(at), seenAt: new Date(at) });
  const reply = (id, who, to, at) => ({ _id: id, authorId: who, createdAt: at, referenced: [{ type: "replied_to", id: to }] });
  const drew = postRows(posts, {
    meId: ME,
    likes: [lk("700", P, "2026-01-05")],
    reposts: [rpOf("700", T, "2026-01-07"), rpOf("700", P, "2026-01-08"), rpOf("700", ME, "2026-01-09")],
    replies: [reply("800", T, "702", "2026-01-10"), reply("801", ME, "702", "2026-01-11")],
    seenBefore: new Date("2026-01-04"),
  });
  assert.deepStrictEqual(drew.map((r) => [r.postId, r.count, r.reposts, r.replies, r.likers.map((u) => u.id)]), [["702", 0, 0, 1, [T]], ["700", 1, 2, 0, [P, T]], ["701", 0, 0, 0, []]], "a reply brings its post up; reposts and likes on one row, each face once");
  assert.strictEqual(drew[1].fresh, true, "a repost since you looked is new");
  const searched = likesListing.listRows(rows, likesListing.parseQuery({ q: "tim" }));
  assert.deepStrictEqual(searched.rows.map((c) => c.postId), ["700"], "search finds a row by a liker's name");
}
// Live follow events (services/liveRules.js followEventFor): which way, by whose end the account is; neither end = none.
// Then the Follows page (services/follows.js): only the ones TO you, newest first, where you stand now, fresh, filters.
{
  const { followEventFor } = require("../services/liveRules");
  const ev = (type, src, tgt, uuid = "u1") => ({ event_type: type, event_uuid: uuid, created_at: "2026-01-05T10:00:00Z", payload: { source: { data: { id: src } }, target: { data: { id: tgt } } } });
  const pick = (r) => r && [r.direction, r.kind, r.personId];
  assert.deepStrictEqual(
    [pick(followEventFor(ev("follow.follow", P, ME), ME)), pick(followEventFor(ev("follow.unfollow", P, ME), ME)), pick(followEventFor(ev("follow.follow", ME, T), ME)), followEventFor(ev("follow.follow", P, T), ME), followEventFor({ ...ev("follow.follow", P, ME), event_uuid: undefined }, ME)],
    [["in", "follow", P], ["in", "unfollow", P], ["out", "follow", T], null, null]
  );
  const { followRows, listing: followsListing } = require("../services/follows");
  const fe = (id, direction, kind, personId, at, seenAt) => ({ _id: id, direction, kind, personId, at: new Date(at), seenAt: new Date(seenAt) });
  const rows = followRows(
    [fe("a", "in", "follow", P, "2026-01-02", "2026-01-02"), fe("b", "in", "unfollow", T, "2026-01-04", "2026-01-04"), fe("c", "out", "follow", T, "2026-01-05", "2026-01-05")],
    { profiles: new Map([[T, { username: "tim", name: "Tim", followers: 9 }]]), follows: { followers: new Set([P]), following: new Set([T]) }, seenBefore: new Date("2026-01-03") }
  );
  assert.deepStrictEqual(rows.map((r) => [r.id, r.kind, r.followsYou, r.youFollow, r.fresh]), [["b", "unfollow", false, true, true], ["a", "follow", true, false, false]], "yours left out; newest first; where you stand now; fresh");
  assert.deepStrictEqual(followsListing.listRows(rows, followsListing.parseQuery({ show: "unfollow" })).rows.map((r) => r.id), ["b"], "the Unfollowed tab");
  assert.deepStrictEqual(followsListing.listRows(rows, followsListing.parseQuery({ q: "tim" })).rows.map((r) => r.id), ["b"], "search by name");
}
// THE HANDLE (lib/handle.js, every box that takes one: the estimate, Who they tag, Admin's Invite): typed or pasted as a
// profile link, cleaned or refused.
{
  const { handleOf } = require("../lib/handle");
  assert.deepStrictEqual(["@Sample_J", "name", " @a ", "two words", "@toolonghandle_123", "a".repeat(16), "", undefined].map(handleOf), ["Sample_J", "name", "a", null, null, null, null, null]);
  assert.deepStrictEqual(["https://x.com/Maya_D", "x.com/@maya", "https://twitter.com/maya/status/1", "www.x.com/maya?s=20", "https://example.com/maya", "https://x.com/"].map(handleOf), ["Maya_D", "maya", "maya", "maya", null, null], "a pasted profile link is its handle; another site's isn't");
}
// The front page's estimate from a real account (services/estimator.js): X's daily counts averaged over the window,
// every bucket a whole UTC day (lib/x.js postCounts asks counts/all for whole days).
{
  const { rateOf } = require("../services/estimator");
  const b = (...ns) => ns.map((n, i) => ({ start: `2026-11-0${i + 1}`, n }));
  assert.deepStrictEqual(rateOf(b(100, 180, 220, 200, 300)), { perDay: 200, days: 5 }, "every whole day counts");
  assert.deepStrictEqual(rateOf([]), { perDay: 0, days: 0 }, "no days: nothing to say");
}
// The follow reconciler (services/following.js): the read's tiers on the following count, and who doesn't follow back.
{
  const { followingOptions, wantUpdate, notFollowingBack, listing: B, EVERYTHING_SLACK } = require("../services/following");
  const keys = (n, o = {}) => followingOptions(n, { perUser: 0.01, ...o }).map((c) => `${c.key}:${c.budget}`);
  assert.deepStrictEqual(keys(5000), ["1000:1000", "2500:2500", "all:5000"], "newest 1,000 / 2,500 / all of them");
  assert.deepStrictEqual(keys(741), ["all:741"], "a list under the first tier: only all of it");
  assert.deepStrictEqual(keys(1800), ["1000:1000", "all:1800"], "a tier that reaches the whole list becomes 'all'");
  assert.deepStrictEqual(keys(undefined), ["1000:1000", "2500:2500"], "no count known: no 'all' to price");
  const all = followingOptions(741, { perUser: 0.01 })[0];
  assert.ok(Math.abs(all.estimate - 7.41) < 1e-9 && all.cap === 741 + EVERYTHING_SLACK, "priced on the count; read with room for follows since");
  // ONE READ, THEN LIVE: a whole read offers nothing; a partial one THE REST from X's marker; Follows turned on since, the whole list again.
  const at = new Date("2026-11-20T00:00:00Z");
  assert.deepStrictEqual(keys(25000, { walk: { listedAt: at, read: 25000, complete: true } }), [], "read whole: nothing to buy, Live keeps it current");
  const rest = followingOptions(25000, { perUser: 0.01, walk: { listedAt: at, read: 1000, complete: false, next: "tok" } });
  assert.deepStrictEqual(rest.map((c) => [c.key, c.budget, c.from, c.button]), [["rest", 24000, "next", "Read the other 24,000"]], "read in part: the rest, from where it stopped");
  assert.ok(Math.abs(rest[0].estimate - 240) < 1e-9 && rest[0].cap === 24000 + EVERYTHING_SLACK, "the rest is priced on what's left, never the newest again");
  assert.deepStrictEqual(keys(25000, { walk: { listedAt: at, read: 1000, complete: false } }), ["1000:1000", "2500:2500", "all:25000"], "a partial read with no marker (from before markers): from the top");
  const again = followingOptions(528, { perUser: 0.01, walk: { listedAt: at, read: 528, complete: true }, reread: true });
  assert.deepStrictEqual(again.map((c) => [c.key, c.from, c.button]), [["all", "top", "Check again"]], "Follows turned on since the read: the whole list again");
  const topWant = wantUpdate(followingOptions(25000, { perUser: 0.01 })[2], at);
  assert.ok(topWant.$set["following.want"].top && +topWant.$set["following.walkAt"] === +at && topWant.$set["following.want"].ceilingUsd === 250, "a read from the top starts a walk, its quote the ceiling");
  assert.ok(!wantUpdate(rest[0], at).$set["following.walkAt"] && !wantUpdate(rest[0], at).$set["following.want"].top, "the rest keeps the walk going");
  const profiles = new Map([["a", { username: "a", followers: 50 }], ["b", { username: "b", followers: 5000 }], ["c", { username: "c", followers: 200 }], ["d", { username: "d" }]]);
  const followsYou = new Map([["a", false], ["b", false], ["c", true], ["d", false]]);
  const rows = notFollowingBack(["a", "b", "c", "d", "e"], followsYou, { profiles });
  assert.deepStrictEqual(rows.map((r) => r.id), ["a", "b", "d"], "only an explicit no: c follows back, e is unknown");
  const show = (q) => B.listRows(rows, B.parseQuery(q)).rows.map((r) => r.id);
  assert.deepStrictEqual(show({}), ["a"], "default: under 1,000 followers (an unknown count isn't under anything)");
  assert.deepStrictEqual(show({ under: "any" }), ["a", "b", "d"], "any: smallest first, unknown last");
  assert.deepStrictEqual(show({ under: "nope" }), ["a"], "an unknown threshold falls back to the default");
}
const likedThread = threads(tposts, ME, P, tprofiles, { likers: new Map([["206", [ME]]]) }).find((t) => t.id === "200");
assert.strictEqual(likedThread.dialogue.find((i) => i.id === "206").liked, "You", "a liked post in a conversation says who liked it");
assert.strictEqual(likedThread.dialogue.find((i) => i.id === "202").liked, null, "…and one nobody's known to like says nothing");
const selfLiked = threads(tposts, ME, P, tprofiles, { likers: new Map([["202", [ME]], ["203", [ME, P]]]) }).find((t) => t.id === "200");
assert.strictEqual(selfLiked.dialogue.find((i) => i.id === "202").liked, "You", "your own like on your own post counts, as X's number does");
assert.match(selfLiked.dialogue.find((i) => i.id === "203").liked, /^You and /, "…named first, with whoever else liked it");
// Each conversation counts its likes as the cards do: their posts you liked, your posts they liked (a third party's
// like on yours, or yours on a third party's, isn't theirs).
const counted = threads(tposts, ME, P, tprofiles, { likers: new Map([["206", [ME]], ["202", [P, T]], ["204", [ME]]]) }).find((t) => t.id === "200");
assert.deepStrictEqual([counted.youLiked, counted.theyLiked], [1, 1]);
// The ♥ button (Liking on): on someone else's post, toggling the way your own like says; never on yours.
const liking = threads(tposts, ME, P, tprofiles, { likers: new Map([["206", [ME]]]), canLike: true }).find((t) => t.id === "200");
const post = (id) => liking.dialogue.find((i) => i.id === id);
assert.deepStrictEqual([post("206").likeable, post("206").youLiked, post("203").likeable, post("203").youLiked, post("202").likeable], [true, true, true, false, false]);
assert.ok(!likedThread.dialogue.some((i) => i.likeable), "without Liking, no ♥ button");

// The Inbox: replies, mentions and quotes from its start on (nothing expires), one card per CONVERSATION, newest
// first, oldest first inside. Done is a mark you set (InboxMark: through the latest incoming message), never a like or
// a reply, never a timer.
{
  const { inboxRows, listing: L } = require("../services/inbox");
  const box = [
    tp("71", "own", ME, "c0", { day: 1 }),
    tp("72", "mention", P, "c0", { to: ME, parent: "71", day: 2 }), // you replied to it (80): still waiting, unmarked
    tp("73", "mention", P, "c0", { to: ME, parent: "71", day: 3 }), // marked done through 73
    tp("74", "mention", P, "c1", { to: ME, day: 4 }), // waiting
    tp("75", "mention", P, "c1", { to: ME, day: 4 }), // waiting, same person + conversation: same group
    tp("76", "mention", T, "c2", { day: 4 }), // only tags you: waiting, a mention
    tp("77", "mention", T, "c3", { to: ME, day: 4 }), // marked done through 77
    tp("70", "mention", P, "c4", { to: ME, at: "2025-12-20" }), // before the Inbox's start (startId 71)
    tp("80", "own", ME, "c0", { to: P, parent: "72", day: 3 }),
  ];
  const marks = new Map([["c0", "73"], ["c3", "77"]]);
  const opts = { byId: new Map(box.map((p) => [p._id, p])), startId: "71", rankOf: new Map([[T, 1], [P, 2]]), marks };
  const rows = inboxRows(box, ME, opts);
  const view = (q) => L.listRows(rows, L.parseQuery(q)).rows.map((g) => g.key);
  assert.deepStrictEqual(view({}), ["c2", "c1"], "waiting (the default), newest first");
  assert.deepStrictEqual(view({ show: "done" }), ["c3", "c0"], "done: the cards you marked");
  // THE CONVERSATION ENGINE for one conversation's whole history (a post's page, a person's conversation: `only` +
  // `doneBefore`): c4 lies wholly before the Inbox's start, so its card is drawn, settled (no Done of its own), its
  // message owing nothing and wearing no "✓ Done"; c1, inside the Inbox, is drawn exactly as the Inbox draws it.
  const history = inboxRows(box, ME, { ...opts, startId: "0", doneBefore: "71", only: new Set(["c4", "c1"]) });
  const c4 = history.find((r) => r.key === "c4");
  assert.deepStrictEqual(history.map((r) => r.key).sort(), ["c1", "c4"], "only the conversations asked for");
  assert.deepStrictEqual([c4.settled, c4.status, c4.dialogue[0].owes, c4.dialogue[0].finished, c4.dialogue[0].doneIn], [true, "done", null, false, null], "before the start: settled history, nothing owed, no Done");
  const c1Inbox = rows.find((r) => r.key === "c1");
  const c1History = history.find((r) => r.key === "c1");
  assert.deepStrictEqual([c1History.settled, c1History.status, c1History.owedSplit], [false, c1Inbox.status, c1Inbox.owedSplit], "inside the Inbox: the same card the Inbox draws");
  // The Inbox tab's red count (inbox.owedCount) is the likes and replies still owed, by the page's own rule: the same
  // number as the rail's Everyone with no search, from the incoming posts plus your replies in their conversations
  // (what services/inboxCount.js loads).
  const { owedCount, railOf: railOfRows } = require("../services/inbox");
  const loaded = box.filter((p) => p.authorId !== ME || p.conversationId);
  const everyoneOwed = railOfRows(L.listRows(rows, L.parseQuery({}), Infinity).rows).total;
  assert.deepStrictEqual([owedCount(box, ME, opts), owedCount(loaded, ME, opts), everyoneOwed], [6, 6, 6], "the red count is the rail's Everyone");
  assert.deepStrictEqual(inboxRows(box, ME, { ...opts, marks: new Map() }).filter((g) => g.status === "done").length, 0, "a reply or a like alone never marks a card done");
  // Liked AND answered = done, nothing left to do with it (standingOf); a like alone or a reply alone isn't. Without your
  // likes known, a reply is all a message can owe, so the reply alone does it.
  const both = inboxRows(box, ME, { ...opts, marks: new Map(), likers: new Map([["72", [ME]], ["73", [ME]]]) });
  const c0both = (extra) => inboxRows([...box, tp("81", "own", ME, "c0", { to: P, parent: "73", day: 3 })], ME, { ...opts, marks: new Map(), ...extra }).find((g) => g.key === "c0");
  assert.deepStrictEqual(both.find((g) => g.key === "c0").status, "waiting", "72 liked and answered, 73 liked only: still waiting");
  assert.deepStrictEqual([c0both({ likers: new Map([["72", [ME]], ["73", [ME]]]) }).status, c0both({}).status, c0both({ likesKnown: false }).status], ["done", "waiting", "done"], "both liked and answered: done; answered only: waiting; likes unknown: answered is enough");
  const half = c0both({ likers: new Map([["72", [ME]]]) });
  assert.deepStrictEqual([half.status, half.dialogue.filter((m) => !m.fromMe).map((m) => m.id), half.earlier.filter((m) => !m.fromMe).map((m) => m.id)], ["waiting", ["73"], ["72"]], "a waiting card folds the done message, shows the one still owed");
  assert.deepStrictEqual(owedCount([...box, tp("81", "own", ME, "c0", { to: P, parent: "73", day: 3 })], ME, { ...opts, marks: new Map([["c3", "77"]]), liked: new Set(["72", "73"]) }), 6, "the red count agrees: c0 owes nothing unmarked, c1 and c2 still do");
  assert.deepStrictEqual(rows.filter((g) => g.note).map((g) => [g.key, g.note]), [["c3", "Replied to you"], ["c2", "Mentioned you"], ["c1", "Replied to you"]], "a card that only tagged you says so; one with no seed always says why (its band)");
  // A quote of your post (it neither replies to nor tags you) is someone talking to you: its own card, "Quoted your
  // post", and it counts on the leaderboard (one once never showed).
  const quote = { ...tp("120", "mention", T, "c7", { day: 4 }), referenced: [{ type: "quoted", id: "71" }], quotedAuthorId: ME };
  assert.deepStrictEqual(require("../services/people").exchangeWith(quote, ME), { personId: T, dir: "in" });
  const qcard = inboxRows([...box, quote], ME, opts).find((g) => g.key === "c7");
  assert.deepStrictEqual([!!qcard, qcard && qcard.topic.length, qcard && qcard.note], [true, 0, "Quoted your post"], "a quote is in the Inbox, no seed above it: its band says why (partials/inbox-done.hbs)");
  // A plain REPOST is never them talking to you ("RT @you: …" tags you, and another account's repost of
  // your post sat in the Inbox as "Mentioned you"), nor anyone's repost of a post that tagged you.
  const rt = (id, conv) => ({ ...tp(id, "mention", T, conv, { day: 4 }), mentions: [{ id: ME, username: "me" }], referenced: [{ type: "retweeted", id: "71" }] });
  assert.strictEqual(require("../services/people").exchangeWith(rt("121", "c8"), ME), null, "a repost mentioning you isn't an exchange");
  assert.ok(!inboxRows([...box, rt("121", "c8")], ME, opts).some((g) => g.key === "c8"), "…so it makes no Inbox card");
  assert.strictEqual(owedCount([...box, rt("121", "c8")], ME, opts), owedCount(box, ME, opts), "…and the red count doesn't move");
  const { eventContents: ec } = require("../lib/x");
  const qe = ec({ payload: { id: "120", author_id: T, referenced_tweets: [{ type: "quoted", id: "71" }] }, includes: { tweets: [{ id: "71", author_id: ME }] } });
  assert.deepStrictEqual(qe.posts.map((p) => [p.id, p.quoted_author_id || null]), [["120", ME], ["71", null]], "a live quote event records whose post it quotes");
  assert.deepStrictEqual(view({ show: "all", q: "post 73" }), ["c0"], "search finds their words");
  assert.deepStrictEqual(view({ sort: "closest" }), ["c2", "c1"], "the people you talk with most first (T ranks 1)");
  const c1 = rows.find((g) => g.key === "c1");
  assert.strictEqual(c1.replyId, "75", "Reply on X answers their latest post");
  assert.deepStrictEqual(c1.dialogue.map((p) => [p.side, p.runStart, !!p.replyTo]), [["them", true, true], ["them", false, true]], "drawn as a conversation's chat: one run on their side; each of theirs has its own ↩ Reply");
  // Your reply is in the card, on your side, right under what it answers (80 answers 72, written after 73): what
  // they answered is the seed.
  const c0 = rows.find((g) => g.key === "c0");
  assert.deepStrictEqual(c0.dialogue.map((p) => [p.id, p.side, p.runStart]), [["72", "them", true], ["80", "me", true], ["73", "them", true]]);
  assert.deepStrictEqual(c0.topic.map((p) => p.id), ["71"], "the seed is what they answered (71 isn't c0's first post: nothing says so, its exit opens it on X)");
  // THE THREAD ABOVE the seed (inbox.threadAbove; without it, what you'd replied to was lost): your reply
  // in the box (601) answered someone's post (600); it's drawn above, oldest first, the seed LAST, owing nothing. A long
  // thread shows its first and last above the seed, the middle folded; a chain stops at a post not stored or gone.
  {
    const { threadAbove } = require("../services/inbox");
    const pants = [tp("600", "context", T, "600"), tp("601", "own", ME, "600", { to: T, parent: "600", day: 2 }), tp("602", "mention", T, "600", { to: ME, parent: "601", day: 3 })];
    const card = inboxRows(pants, ME, { byId: new Map(pants.map((p) => [p._id, p])), withThread: true })[0];
    assert.deepStrictEqual(inboxRows(pants, ME, { byId: new Map(pants.map((p) => [p._id, p])) })[0].topic.map((p) => p.id), ["601"], "a card nobody draws doesn't walk (withThread off: a press recounting the Inbox)");
    assert.deepStrictEqual([card.topic.map((p) => p.id), card.topicFold, card.topic[0].owes, card.topic[0].doneIn, !!card.topic[0].folded], [["600", "601"], null, undefined, undefined, false], "the post your reply answered sits above it, context only");
    assert.deepStrictEqual(card.dialogue.map((p) => p.id), ["602"], "the chat is still just their answer");
    // Your own thread (610 → 611), T answers 611, P later answers 610: 610 is at the top (above the seed 611), so it isn't
    // drawn again in the chat; P's reply starts its own branch there, as a reply to the seed does.
    const own = [tp("610", "own", ME, "610"), tp("611", "own", ME, "610", { parent: "610", day: 2 }), tp("612", "mention", T, "610", { to: ME, parent: "611", day: 3 }), tp("613", "mention", P, "610", { to: ME, parent: "610", day: 4 })];
    const ownCard = inboxRows(own, ME, { byId: new Map(own.map((p) => [p._id, p])), withThread: true })[0];
    assert.deepStrictEqual([ownCard.topic.map((p) => p.id), ownCard.dialogue.map((p) => p.id).sort()], [["610", "611"], ["612", "613"]], "a post at the top is never drawn twice");
    const deep = [tp("700", "context", T, "700"), tp("701", "context", P, "700", { parent: "700" }), tp("702", "context", T, "700", { parent: "701" }), tp("703", "context", P, "700", { parent: "702" }), tp("704", "own", ME, "700", { to: P, parent: "703", day: 2 }), tp("705", "mention", P, "700", { to: ME, parent: "704", day: 3 })];
    const long = inboxRows(deep, ME, { byId: new Map(deep.map((p) => [p._id, p])), withThread: true })[0];
    assert.deepStrictEqual([long.topic.map((p) => [p.id, !!p.folded]), long.topicFold], [[["700", false], ["701", true], ["702", true], ["703", false], ["704", false]], { n: 2 }], "a long thread: first and last above the seed, the middle folded");
    const byId = new Map(deep.map((p) => [p._id, p]));
    byId.set("702", { ...byId.get("702"), gone: "x" });
    assert.deepStrictEqual(threadAbove(byId.get("704"), byId).map((p) => p._id), ["703"], "stops at a gone post");
    byId.delete("703");
    assert.deepStrictEqual(threadAbove(byId.get("704"), byId), [], "stops at a post not stored");
  }
  assert.strictEqual(L.hrefFor(L.parseQuery({ show: "done", kind: "reply", sort: "closest" })), "/?show=done&sort=closest", "every view is a URL; defaults (and the old kind filter) left out");
  // Every match at once (Mark all done asks with size Infinity): all of them, not none ((1 - 1) × Infinity is NaN).
  const everything = L.listRows(rows, L.parseQuery({}), Infinity);
  assert.deepStrictEqual([everything.rows.map((g) => g.key), everything.from, everything.to], [["c2", "c1"], 1, 2], "size Infinity returns every match");
  // The rail (inbox.railOf): who in the view still has a like or a reply coming from you, and how many (each of their
  // messages owes a like you haven't given and a reply you haven't written), closest first; a name narrows the list
  // (`person`, any X id; anything else is ignored and stays out of the URL). Here no likes are given: c1's 74 and 75
  // owe both; c2's 76 both; c0 and c3 are done, and done owes nothing, in any tab.
  const inbox = require("../services/inbox");
  const rail = (rs) => inbox.railOf(rs).people.map((p) => [p.id, p.n]);
  assert.deepStrictEqual(rail(L.listRows(rows, L.parseQuery({ show: "all" }), Infinity).rows), [[T, 2], [P, 4]], "every like and reply owed, closest first (T ranks 1); the done cards add nothing");
  assert.deepStrictEqual([rail(everything.rows), inbox.railOf(everything.rows).total], [[[T, 2], [P, 4]], 6], "Everyone is the sum");
  assert.deepStrictEqual(inbox.railOf(rows, { limit: 1 }).more, 1, "past the limit, how many more");
  assert.deepStrictEqual([view({ person: P, show: "all" }), view({ person: T })], [["c1"], ["c2"]], "a person's cards: where they're owed");
  assert.deepStrictEqual([L.parseQuery({ person: "x'><b" }).person, L.hrefFor(L.parseQuery({ person: P }))], ["", `/?person=${P}`], "only an X id is a person");
  const c1o = (extra) => inboxRows(box, ME, { ...opts, ...extra }).find((g) => g.key === "c1");
  assert.deepStrictEqual(c1o({ likers: new Map([["74", [ME]]]) }).owed.map((w) => w.n), [3], "a message you liked still owes a reply");
  assert.deepStrictEqual(c1o({ likesKnown: false }).owed.map((w) => w.n), [2], "your likes unknown (no People or Liking): only replies count");
  assert.deepStrictEqual(c1o({}).dialogue.map((m) => m.owes), [{ like: true, reply: true }, { like: true, reply: true }], "each message says what it owes (the page moves the rail by it)");
  // A reopened card counts only what's new, not the messages folded away as handled; someone you've liked and answered
  // owes nothing and isn't on the rail.
  const twoWrote = [tp("91", "mention", T, "c9", { to: ME, day: 4 }), tp("92", "mention", P, "c9", { to: ME, day: 5 })];
  const r9 = (mark, extra = {}) => inboxRows([...twoWrote, ...(extra.posts || [])], ME, { ...opts, startId: "0", marks: new Map(mark ? [["c9", mark]] : []), ...extra })[0];
  assert.deepStrictEqual([r9("91").owed.map((w) => w.id), r9(null).owed.map((w) => w.id), r9("92").owed.map((w) => w.id)], [[P], [T, P], []], "reopened: only who's new; unmarked: everyone; done: nobody");
  assert.deepStrictEqual(L.listRows([r9("91")], L.parseQuery({ person: T })).matched, 0, "filtering by someone already handled finds no waiting card");
  const handled = r9(null, { likers: new Map([["91", [ME]]]), posts: [tp("93", "own", ME, "c9", { to: T, parent: "91", day: 5 })] });
  assert.deepStrictEqual(handled.owed.map((w) => [w.id, w.n]), [[P, 2]], "liked and answered: off the rail");
  // Seen through one person (inbox.focusOn): only their messages still owed stay in view; the rest, other people's
  // owed ones and your answers included, fold as "other messages".
  const focused = inbox.focusOn(handled, P);
  assert.deepStrictEqual([focused.dialogue.map((m) => m.id), focused.earlier.map((m) => m.id), focused.fold.word, focused.dialogue[0].runStart], [["92"], ["91", "93"], "earlier", true], "only theirs still owed; the rest folded");
  assert.deepStrictEqual(inbox.focusOn(r9(null), T).earlier.map((m) => m.id), ["92"], "someone else's still-owed message folds too");
  // ...but what their live message directly answers stays (someone's question under your reply), and when that's a
  // post of yours, the message it answered too (your words need theirs): P answers your 93 (itself an answer to T's
  // 91). P's view shows 91, 93, 94; anything further up the chain still folds (T's 90 that 91 answered).
  const answers = inbox.focusOn(r9(null, { likers: new Map([["91", [ME]]]), posts: [tp("93", "own", ME, "c9", { to: T, parent: "91", day: 5 }), tp("94", "mention", P, "c9", { to: ME, parent: "93", day: 6 })] }), P);
  assert.deepStrictEqual([answers.dialogue.map((m) => m.id).sort(), answers.earlier.map((m) => m.id)], [["91", "92", "93", "94"], []], "the post a live message answers stays in view, with the message that post answered");
  // One step past your post, no further: T's 80 ← your 81 ← T's 82 ← your 83 ← P's live 84. P's view: 82, 83, 84.
  const chain = [
    tp("80", "mention", T, "c8", { to: ME, day: 1 }),
    tp("81", "own", ME, "c8", { to: T, parent: "80", day: 2 }),
    tp("82", "mention", T, "c8", { to: ME, parent: "81", day: 3 }),
    tp("83", "own", ME, "c8", { to: T, parent: "82", day: 4 }),
    tp("84", "mention", P, "c8", { to: ME, parent: "83", day: 5 }),
  ];
  const deeper = inbox.focusOn(inboxRows(chain, ME, { ...opts, startId: "0", likers: new Map([["80", [ME]], ["82", [ME]]]) })[0], P);
  assert.deepStrictEqual([deeper.dialogue.map((m) => m.id).sort(), deeper.earlier.map((m) => m.id).sort()], [["82", "83", "84"], ["80", "81"]], "one step past your post, no further");
  // ...and your answer to their live message stays under it (answered on X, still owed a like).
  // P's 92 is answered by your 96 but not liked; T's 91 (liked, answered by 93) isn't live, so 93 still folds.
  const yours = inbox.focusOn(r9(null, { likers: new Map([["91", [ME]]]), posts: [tp("93", "own", ME, "c9", { to: T, parent: "91", day: 5 }), tp("96", "own", ME, "c9", { to: P, parent: "92", day: 6 })] }), P);
  assert.deepStrictEqual([yours.dialogue.map((m) => m.id).sort(), yours.earlier.map((m) => m.id)], [["92", "96"], ["91", "93"]], "your answer to their still-owed message stays under it");
  // Done at two levels, ONE rule (inbox.isHandled; models/InboxMark.js): the thread through a message, or single
  // messages. The case that asked for it: in T's view you answer T and press "Done with T" while P's reply in the same
  // thread is folded. Only T's message is marked; the card stays waiting, on P's reply alone; P stays on the rail.
  const tView = inbox.focusOn(r9(null), T).focus;
  assert.deepStrictEqual([tView.ids, tView.othersWaiting, tView.who.id], [["91"], true, T], "Done with T marks T's message only, says P is still waiting");
  const withMark = (mark) => inboxRows(twoWrote, ME, { ...opts, startId: "0", marks: new Map([["c9", mark]]) })[0];
  const afterT = withMark({ through: null, handled: ["91"] });
  assert.deepStrictEqual([afterT.status, afterT.dialogue.map((m) => m.id), afterT.earlier.map((m) => m.id), afterT.owed.map((w) => w.id)], ["waiting", ["92"], ["91"], [P]], "the card waits on P's reply alone; T's folds as done; only P is owed");
  assert.deepStrictEqual(inbox.owedCount(twoWrote, ME, { marks: new Map([["c9", { handled: ["91"] }]]) }), 2, "the red count agrees: P's reply still owes a like and a reply");
  assert.deepStrictEqual([withMark({ handled: ["91", "92"] }).status, withMark({ through: "91", handled: ["92"] }).status], ["done", "done"], "every message done, by either level: the card is done");
  const tAgain = inboxRows([...twoWrote, tp("95", "mention", T, "c9", { to: ME, day: 6 })], ME, { ...opts, startId: "0", marks: new Map([["c9", { handled: ["91", "92"] }]]) })[0];
  assert.deepStrictEqual([tAgain.status, tAgain.dialogue.map((m) => m.id)], ["waiting", ["95"]], "T writes again: waiting, showing just that");
  assert.strictEqual(inbox.focusOn(withMark("92"), T).focus, null, "a done card's button reopens the whole thread");
  // A POST'S PAGE's rail (inbox.railOfCard, `focusOn` with `every`): a FINISHED card still lists everyone who wrote
  // in it (owing nothing), the most replies first; picking one shows all of theirs, though none is owed.
  const finished = inboxRows([...twoWrote, tp("97", "mention", P, "c9", { to: ME, parent: "92", day: 7 })], ME, { ...opts, startId: "0", marks: new Map([["c9", { through: "97" }]]) })[0];
  assert.deepStrictEqual([finished.status, inbox.railOfCard(finished).people.map((p) => [p.id, p.wrote, p.like, p.reply])], ["done", [[P, 2, 0, 0], [T, 1, 0, 0]]], "a finished post's rail: everyone who wrote, most replies first, nothing owed");
  const pView = inbox.focusOn(finished, P, { every: true });
  assert.deepStrictEqual([pView.dialogue.map((m) => m.id).sort(), pView.earlier.map((m) => m.id), pView.focus], [["92", "97"], ["91"], null], "every one of theirs in view, owed or not; the rest folded; no Done of theirs");
  assert.deepStrictEqual(inbox.focusOn(finished, P).dialogue.map((m) => m.id), [], "without `every` (the Inbox): only what's still owed");
  // THE HEAD'S BREAKDOWN (inbox.owedTotals): every card's likes and replies owed, together the red count. c1's 74 and
  // 75 and c2's 76 each owe both.
  const totals = inbox.owedTotals(rows);
  assert.deepStrictEqual([totals, totals.like + totals.reply], [{ like: 3, reply: 3 }, owedCount(box, ME, opts)], "likes + replies owed = the red count");
  // THE RAIL BY POST (inbox.railOfPosts): each card still owing something, the most owed first; `post` is that card alone.
  const byPost = inbox.railOfPosts(rows);
  assert.deepStrictEqual([byPost.posts.map((p) => [p.id, p.n]), byPost.total], [[["c1", 4], ["c2", 2]], 6], "the most owed first; the same total as Everyone");
  const numbered = rows.map((g) => ({ ...g, conversationId: g.key === "c1" ? "123" : g.conversationId })); // real ones are X ids
  assert.deepStrictEqual([L.listRows(numbered, L.parseQuery({ post: "123", show: "all" })).rows.map((g) => g.key), L.parseQuery({ post: "c1'>" }).post, L.hrefFor(L.parseQuery({ by: "posts" }))], [["c1"], "", "/?by=posts"], "a post's view is its card alone; only an id is a post; the rail's mode stays in the URL");
  // A LONG CARD folds after its first CARD_SHOWS messages of theirs (inbox.capCard), cut only before one of theirs, so
  // your answer stays under what it answers; a short card is left alone.
  const long = [...Array(8)].map((_, k) => tp(String(200 + k), "mention", P, "c20", { to: ME, day: 4 }));
  const longRow = (extra = []) => inboxRows([...long, ...extra], ME, { ...opts, startId: "0", marks: new Map() })[0];
  const capped = inbox.capCard(longRow([tp("210", "own", ME, "c20", { to: P, parent: "205", day: 4 })]), "/?by=posts&post=c20");
  assert.deepStrictEqual([capped.dialogue.map((m) => m.id), capped.rest.map((m) => m.id), capped.rest[0].runStart, capped.drill], [["200", "201", "202", "203", "204", "205", "210"], ["206", "207"], true, "/?by=posts&post=c20"], "six of theirs, your answer kept with the sixth, the rest folded beside a link to the card alone");
  const short = rows.find((g) => g.key === "c1");
  assert.strictEqual(inbox.capCard(short, "/x"), short, "a short card isn't touched");
  // BULK LIKE's targets (inbox.likeTargets): what the view still owes a like, top of the list first, none newer than the
  // page (upTo), only the picked person's in their view, and never one you can't like (Liking off).
  const likeRows = (extra = {}) => L.listRows(inboxRows(box, ME, { ...opts, canLike: true, ...extra }), L.parseQuery({}), Infinity).rows;
  assert.deepStrictEqual(
    [inbox.likeTargets(likeRows()), inbox.likeTargets(likeRows(), { upTo: 75n }), inbox.likeTargets(likeRows(), { person: T }), inbox.likeTargets(likeRows({ likers: new Map([["74", [ME]]]) })), inbox.likeTargets(likeRows({ canLike: false }))],
    [["76", "74", "75"], ["74", "75"], ["76"], ["76", "75"], []],
    "the list's order; nothing newer than the page; their view, theirs; liked already, skipped; no Liking, nothing"
  );
  // THE OWED TABLE (inbox.owedModel → partials/owed-model.hbs → post-actions.js recount): the page computes the rail,
  // the head and every bulk ♥'s messages from it, so summed the way the page sums it, it must say exactly what the
  // server's own functions say (a rule changed in services/inbox.js and not carried by the table fails here).
  {
    const all = likeRows();
    const model = inbox.owedModel(all, new Set(all.map((r) => r.conversationId)));
    const sum = (test) => model.filter(([, p, c, f]) => (f & 8) && test(p, c)).reduce((s, [, , , f]) => ({ like: s.like + (f & 1 ? 1 : 0), reply: s.reply + (f & 2 ? 1 : 0) }), { like: 0, reply: 0 });
    const targets = (person) => model.filter(([, p, , f]) => (f & 13) === 13 && (!person || p === person)).map(([id]) => id);
    const byPerson = inbox.railOf(all);
    assert.deepStrictEqual(
      [sum(() => true), byPerson.people.map((w) => [w.id, w.like, w.reply]), inbox.railOfPosts(all).posts.map((x) => [x.id, x.like, x.reply]), targets(), targets(T)],
      [inbox.owedTotals(all), byPerson.people.map((w) => [w.id, sum((p) => p === w.id).like, sum((p) => p === w.id).reply]), inbox.railOfPosts(all).posts.map((x) => [x.id, sum((p, c) => c === x.id).like, sum((p, c) => c === x.id).reply]), inbox.likeTargets(all), inbox.likeTargets(all, { person: T })],
      "the owed table sums to the head, the rail by person and by post, and gives the bulk like's messages in its order"
    );
    assert.deepStrictEqual(inbox.owedModel(all, new Set()).filter(([, , , f]) => f & 8), [], "a card outside the view (another tab or search) isn't in the rail's sums");
  }
  // FOLLOW A THREAD's people (inbox.followTargets): who wrote in it and isn't followed; of them, who follows you.
  const c9 = r9(null); // T and P wrote
  assert.deepStrictEqual(
    [inbox.followTargets(c9, { following: new Set(), followers: new Set([P]) }), inbox.followTargets(c9, { following: new Set([T]), followers: new Set([T]) })],
    [{ all: [T, P], back: [P] }, { all: [P], back: [] }],
    "everyone not followed, and the ones following you; someone you follow already is left out"
  );
  // A mark covers through their latest message when you pressed it: they write twice (91, 92) and you mark it done
  // through 92 → done; they write again (95) → waiting again.
  const at = { startId: "0" }; // from the beginning: nothing in these is before the start
  // Where an Inbox starts: the later of the oldest mention X gave and a week before joining, as an X id (nothing
  // after it expires; a rolling 7 days once dropped unanswered cards out of Waiting on day 8).
  const { inboxStart } = require("../services/inbox");
  const joined = "2026-11-14T16:05:55Z";
  const weekBefore = BigInt(inboxStart({ joinedAt: joined }));
  assert.ok(Math.abs(Number(weekBefore >> 22n) + 1288834974657 - (Date.parse(joined) - 7 * 864e5)) < 1, "a week before joining, as a snowflake");
  assert.strictEqual(inboxStart({ joinedAt: joined, oldestMentionId: String(weekBefore + 99n) }), String(weekBefore + 99n), "X's 800 mentions reach less than a week: start there");
  assert.strictEqual(inboxStart({ joinedAt: joined, oldestMentionId: "1000" }), String(weekBefore), "a quiet account's mentions reach back years: start a week before joining");
  assert.strictEqual(inboxStart({}), "0", "nothing known: everything");
  // A NEW Inbox opens with its newest 20 replies, and "Load earlier replies" adds 20 more (services/inboxStart.js startAt:
  // the ids newest first; the n-th is the start, so it and the newer ones are in; n or fewer: everything to the reach).
  const { startAt } = require("../services/inboxStart");
  const desc = Array.from({ length: 45 }, (_, i) => String(1000 - i));
  assert.strictEqual(startAt(desc, 20, "5"), "981", "the 20th newest is the start: exactly 20 in");
  assert.strictEqual(desc.filter((id) => BigInt(id) >= BigInt(startAt(desc, 20, "5"))).length, 20, "20 replies in, not 19 or 21");
  assert.strictEqual(startAt(desc.slice(0, 20), 20, "5"), "5", "exactly 20: all of them, from the reach");
  assert.strictEqual(startAt([], 20, "0"), "0", "none at all: from the reach");
  const twice = [tp("91", "mention", P, "c5", { to: ME, day: 3 }), tp("92", "mention", P, "c5", { to: ME, day: 4 })];
  const status = (posts, through) => inboxRows(posts, ME, { ...at, marks: new Map([["c5", through]]) })[0].status;
  assert.strictEqual(status(twice, "92"), "done", "marked done through their latest");
  assert.strictEqual(status([...twice, tp("95", "mention", P, "c5", { to: ME, day: 5 })], "92"), "waiting", "a new message after your mark waits again");

  // Two people answer one post of yours (a long post with two replies once showed twice): ONE card, the
  // post once on top, both replies in the chat, each with its own ↩ Reply. T also answers a follow-up of yours further
  // down (99): it joins the chat, and T's answer sits right under it, X's way (it used to come last, by time).
  const thread = [
    tp("100", "own", ME, "c6", { day: 1 }),
    tp("99", "own", ME, "c6", { to: ME, parent: "100", day: 1 }), // your own follow-up under it
    tp("101", "mention", P, "c6", { to: ME, parent: "100", day: 2 }),
    tp("102", "mention", T, "c6", { to: ME, parent: "100", day: 3 }),
    tp("106", "mention", T, "c6", { to: ME, parent: "99", day: 4 }),
  ];
  const cards = inboxRows(thread, ME, { ...at, byId: new Map(thread.map((p) => [p._id, p])) });
  assert.strictEqual(cards.length, 1, "one card for the conversation, however many people answered");
  const [c6] = cards;
  assert.deepStrictEqual([c6.topic.map((p) => p.id), c6.dialogue.map((p) => p.id), c6.people], [["100"], ["99", "106", "101", "102"], [P, T]]);
  assert.deepStrictEqual([c6.replyId, c6.dialogue.map((p) => [!!p.replyTo, p.replyOf])], ["106", [[true, "100"], [true, "99"], [true, "100"], [true, "100"]]], "every post offers ↩ Reply, yours too; Open on X / Done go by the latest");
  assert.strictEqual(c6.dialogue[0].replyTo, "yourself", "your own post's ↩ Reply answers yourself (a follow-up, X's way)");
  // You answer all three, newest first (107 → 106, 108 → 102, 109 → 101): each answer sits right under its message.
  const all = [...thread, tp("107", "own", ME, "c6", { to: T, parent: "106", day: 5 }), tp("108", "own", ME, "c6", { to: T, parent: "102", day: 5 }), tp("109", "own", ME, "c6", { to: P, parent: "101", day: 5 })];
  const answered = inboxRows(all, ME, { ...at, byId: new Map(all.map((p) => [p._id, p])) })[0];
  assert.deepStrictEqual(answered.dialogue.map((p) => p.id), ["99", "106", "107", "101", "109", "102", "108"], "every answer right under the message it answers (106 answers your 99)");
  assert.deepStrictEqual(c6.dialogue.filter((p) => p.side === "them").map((p) => p.likesPerson), [T, P, T], "each post's like line names its own author (106, 101, 102)");
  // Your post they both answered names whoever liked it among them, not "1 other".
  const bothLiked = inboxRows(thread, ME, { ...at, byId: new Map(thread.map((p) => [p._id, p])), likers: new Map([["100", [T, P]]]) })[0].topic[0];
  assert.deepStrictEqual([bothLiked.likesPerson, bothLiked.liked], [`${P},${T}`, `id ${P} and id ${T}`], "everyone in the card who liked your post, by name");
  // Reopened (marked done, someone new writes, and everything used to come back): marked done through 102,
  // then T's 106 arrives. Only the new shows; what you'd handled (P's 101, T's 102) folds into `earlier`. 106 answers
  // your 99, which stays in view as its context. Never marked, or done: nothing folds.
  const reopened = inboxRows(thread, ME, { ...at, byId: new Map(thread.map((p) => [p._id, p])), marks: new Map([["c6", "102"]]) })[0];
  assert.deepStrictEqual([reopened.status, reopened.earlier.map((p) => p.id), reopened.dialogue.map((p) => p.id)], ["waiting", ["101", "102"], ["99", "106"]]);
  assert.deepStrictEqual([reopened.earlier[0].runStart, reopened.dialogue[0].runStart, reopened.dialogue[0].ruleBefore], [true, true, false], "each part opens with who and when");
  // A back and forth stays whole: P's 201 (liked and answered: done), your
  // 202 answering it, P's 203 answering 202. 203 keeps its whole chain in view, no fold and no line; P's unrelated 204
  // (done) on the seed is a different exchange and still folds.
  const bf = [
    tp("200", "own", ME, "c9", { day: 1 }),
    tp("201", "mention", P, "c9", { to: ME, parent: "200", day: 2 }),
    tp("202", "own", ME, "c9", { to: P, parent: "201", day: 3 }),
    tp("203", "mention", P, "c9", { to: ME, parent: "202", day: 4 }),
  ];
  const bfRow = (posts, likedIds) => inboxRows(posts, ME, { ...at, byId: new Map(posts.map((p) => [p._id, p])), likers: new Map(likedIds.map((id) => [id, [ME]])) })[0];
  const whole = bfRow(bf, ["201"]);
  assert.deepStrictEqual([whole.status, whole.earlier.map((p) => p.id), whole.dialogue.map((p) => p.id), whole.dialogue.map((p) => p.ruleBefore)], ["waiting", [], ["201", "202", "203"], [false, false, false]], "the open message's chain stays in view: nothing folds, no line");
  const bf2 = [...bf, tp("204", "mention", P, "c9", { to: ME, parent: "200", day: 2 }), tp("205", "own", ME, "c9", { to: P, parent: "204", day: 3 })];
  const other = bfRow(bf2, ["201", "204"]);
  assert.deepStrictEqual([other.earlier.map((p) => p.id), other.dialogue.map((p) => p.id)], [["204", "205"], ["201", "202", "203"]], "a done exchange the open one doesn't answer still folds");
  // Past what you MARKED done the chain stops (someone answering again in a thread marked done shows the new reply,
  // your post it answers and the message of theirs your post answered): marked through 203, then your 207 answering
  // 203 and P's new 208 answering 207 → 203, 207 and 208 show; the marked 201–202 fold. Never marked (201 and 203 done
  // by a like and a reply) → the whole chain still shows. Either way no line inside the back and forth.
  const more = [...bf, tp("207", "own", ME, "c9", { to: P, parent: "203", day: 5 }), tp("208", "mention", P, "c9", { to: ME, parent: "207", day: 6 })];
  const markedRow = inboxRows(more, ME, { ...at, byId: new Map(more.map((p) => [p._id, p])), marks: new Map([["c9", "203"]]) })[0];
  assert.deepStrictEqual([markedRow.status, markedRow.earlier.map((p) => p.id), markedRow.dialogue.map((p) => p.id), markedRow.dialogue.map((p) => p.ruleBefore)], ["waiting", ["201", "202"], ["203", "207", "208"], [false, false, false]], "reopened after a mark: the new message, your post it answers and what that answered, no more");
  // Marked through 201 only, and 203 (after the mark) liked and answered: done all the same, so it stops there too
  // (shown, as what your 207 answered; nothing above it).
  const lateRow = inboxRows(more, ME, { ...at, byId: new Map(more.map((p) => [p._id, p])), marks: new Map([["c9", "201"]]), likers: new Map([["203", [ME]]]) })[0];
  assert.deepStrictEqual(lateRow.dialogue.map((p) => p.id), ["203", "207", "208"], "a marked card: any done message of theirs stops the chain");
  // Your posts kept as context sit right above the reply they explain, under the message they answered (the tree's
  // order): marked card, P's 301 and T's 302 (done) each answered by you (303 → 301, 304 → 302), then new 305 from P
  // answering 303 and 306 from T answering 304. Shown: 301, 303, 305, then 302, 304, 306, never your two first and
  // their replies after (which read as a card of only your own responses).
  const two = [
    tp("300", "own", ME, "c10", { day: 1 }),
    tp("301", "mention", P, "c10", { to: ME, parent: "300", day: 2 }),
    tp("302", "mention", T, "c10", { to: ME, parent: "300", day: 2 }),
    tp("303", "own", ME, "c10", { to: P, parent: "301", day: 3 }),
    tp("304", "own", ME, "c10", { to: T, parent: "302", day: 3 }),
    tp("305", "mention", P, "c10", { to: ME, parent: "303", day: 4 }),
    tp("306", "mention", T, "c10", { to: ME, parent: "304", day: 4 }),
  ];
  const twoRow = inboxRows(two, ME, { ...at, byId: new Map(two.map((p) => [p._id, p])), marks: new Map([["c10", "302"]]) })[0];
  assert.deepStrictEqual([twoRow.dialogue.map((p) => p.id), twoRow.earlier.map((p) => p.id)], [["301", "303", "305", "302", "304", "306"], []], "each context post of yours right above the reply it explains, under what it answered");
  // A reply deleted on X since (`gone`, extras.goneCheck: X refused a like on it and won't serve it) leaves the Inbox, as
  // X drops it: not in the card, owing nothing, in no count; a card of only deleted replies goes.
  const deleted = [tp("500", "mention", P, "c40", { to: ME, day: 1 }), { ...tp("501", "mention", T, "c40", { to: ME, day: 2 }), gone: { title: "Not Found Error", detail: "Could not find tweet" } }];
  const delRow = inboxRows(deleted, ME, { ...at, byId: new Map(deleted.map((p) => [p._id, p])) })[0];
  assert.deepStrictEqual([delRow.status, delRow.owed.map((w) => w.id), delRow.waitingReplies, delRow.chat.map((v) => v.id)], ["waiting", [P], 1, ["500"]], "a deleted reply leaves the card; the live one still waits");
  assert.strictEqual(inboxRows([deleted[1]], ME, { ...at, byId: new Map([[deleted[1]._id, deleted[1]]]) }).length, 0, "a card of only deleted replies goes");
  assert.strictEqual(require("../services/inbox").owedCount(deleted, ME, {}), 2, "the red count: P's like and reply, nothing for the deleted one");
  // The case that found the in-place fold: a card marked done through T's reply; then someone new answers
  // P's (done) picture post. Shut: the picture post and the new reply (what it directly answers stays, theirs or not).
  // Open: everything where it belongs, the new reply under the picture post AFTER T's earlier reply to it, as X shows.
  const picPost = [
    tp("399", "own", ME, "c30", { day: 1 }),
    tp("400", "mention", P, "c30", { to: ME, parent: "399", day: 2 }),
    tp("401", "mention", T, "c30", { to: P, parent: "400", day: 3 }),
    tp("402", "mention", "88", "c30", { to: P, parent: "400", day: 4 }),
  ];
  const picRow = inboxRows(picPost, ME, { ...at, byId: new Map(picPost.map((p) => [p._id, p])), marks: new Map([["c30", "401"]]) })[0];
  assert.deepStrictEqual(
    [picRow.dialogue.map((p) => p.id), picRow.chat.map((p) => [p.id, !!p.folded]), picRow.fold],
    [["400", "402"], [["400", false], ["401", true], ["402", false]], { n: 1, word: "other", top: true }],
    "folded in place: shut, the reply under what it answers; open, it follows the earlier reply to the same post"
  );
  const unmarked = bfRow(more, ["201", "203"]);
  assert.deepStrictEqual([unmarked.dialogue.map((p) => p.id), unmarked.dialogue.map((p) => p.ruleBefore)], [["201", "202", "203", "207", "208"], [false, false, false, false, false]], "never marked: the whole chain, no line");
  // The chat is X's tree (people.chatOrder): every message under what it answers, whoever wrote either; the thin line
  // opens a branch. P, your answer, P answering you → no line; P answering your answer AGAIN, written after T's, sits
  // under your answer too; then T on the seed → a line.
  const msg = (id, who, replyOf) => ({ id, author: { id: who }, fromMe: who === ME, replyOf });
  const lines = require("../services/people").chatOrder([msg("1", P, "0"), msg("2", ME, "1"), msg("3", P, "2"), msg("4", T, "0"), msg("5", P, "2")]).map((v) => [v.id, v.ruleBefore]);
  assert.deepStrictEqual(lines, [["1", false], ["2", false], ["3", false], ["5", false], ["4", true]], "each under what it answers; a line opens a branch");
  // The case that found it: your post A (the seed), T on A, your follow-up B in A's thread, then L and K
  // on B, P on A. B starts its own branch (a line: it isn't an answer to T), and both questions sit right under B, in
  // one block; P's opens another.
  const tree = require("../services/people").chatOrder([msg("10", T, "A"), msg("11", ME, "A"), msg("12", P, "A"), msg("13", "lee", "11"), msg("14", "kim", "11")]);
  assert.deepStrictEqual(tree.map((v) => [v.id, v.ruleBefore, v.runStart]), [["10", false, true], ["11", true, true], ["13", false, true], ["14", false, true], ["12", true, true]], "replies to your follow-up sit under it, X's way");
  // THE THREAD LINE: drawn only into a direct answer. L answers your 11 (joined); K answers 11 too, not L (a line from
  // L would say K answered L); the last never joins anything.
  assert.deepStrictEqual(tree.map((v) => [v.id, v.joinsNext]), [["10", false], ["11", true], ["13", false], ["14", false], ["12", false]], "the thread line joins only a message to its direct answer");
  // The case that found it: R on your post A, you answer R, S answers R, then S answers A itself. S's
  // second is NOT more of the first: its own header and a line (a new branch under your post). Two in a row to the
  // same thing, or one answering their own, stay one run.
  const branch = require("../services/people").chatOrder([msg("20", "rae", "A"), msg("21", ME, "20"), msg("22", "sam", "A"), msg("23", "sam", "20")]);
  assert.deepStrictEqual(branch.map((v) => [v.id, v.runStart, v.ruleBefore]), [["20", true, false], ["21", true, false], ["23", true, false], ["22", true, true]], "the same author answering something else starts its own run and branch");
  // And S's first answers R under YOUR answer to R: it says whom ("Replying to"); nothing else needs to.
  assert.deepStrictEqual(branch.map((v) => [v.id, v.answering && v.answering.id]), [["20", null], ["21", null], ["23", "rae"], ["22", null]], "Replying to only where the message above isn't what it answers");
  const oneRun = require("../services/people").runsOf([msg("30", P, "A"), msg("31", P, "A"), msg("32", P, "31")]);
  assert.deepStrictEqual(oneRun.map((v) => v.runStart), [true, false, false], "twice to the same thing, or answering their own, is one run");
  // But twice to a message IN the chat (you answered Maya's message twice): the second says "Replying to
  // Maya", so it gets its own header to sit under.
  const twiceToMaya = require("../services/people").runsOf([msg("40", "maya", "A"), msg("41", ME, "40"), msg("42", ME, "40")]);
  assert.deepStrictEqual(twiceToMaya.map((v) => [v.id, v.runStart, v.ruleBefore, v.answering && v.answering.id]), [["40", true, false, null], ["41", true, false, null], ["42", true, false, "maya"]], "a second answer to a message in the chat: its own header, then Replying to, no line");
  // The lines are for what's shown together: with T's 4 folded away, P's 5 answering your 2 is one back and forth.
  const shownLines = require("../services/people").runsOf([msg("1", P, "0"), msg("2", ME, "1"), msg("5", P, "2")]).map((v) => v.ruleBefore);
  assert.deepStrictEqual(shownLines, [false, false, false], "lines recomputed on what's shown");
  assert.deepStrictEqual([c6.earlier.length, inboxRows(thread, ME, { ...at, byId: new Map(thread.map((p) => [p._id, p])), marks: new Map([["c6", "106"]]) })[0].earlier.length], [0, 0], "never marked, or done: nothing folds");
  const c6status = (through) => inboxRows(thread, ME, { ...at, marks: new Map([["c6", through]]) })[0].status;
  assert.deepStrictEqual([c6status("102"), c6status("106")], ["waiting", "done"], "done only through the latest from anyone");
}

// Likes and Follows extras: counts and follow flags land on the person's row.
const likes = { byYou: new Map([[P, 3]]), ofYou: new Map([[P, 2]]) };
const follows = { followers: new Set([P]), following: new Set() };
const pRow = leaderboard(tposts, ME, new Map(), { likes, follows }).find((r) => r.id === P);
assert.deepStrictEqual([pRow.likedByYou, pRow.likedYou, pRow.followsYou, pRow.youFollow], [3, 2, true, false]);
assert.ok(!("yourMove" in pRow) && !("yourMove" in a), "\"your move\" is gone from both surfaces");

// Your likes come newest-like first: the new ones are everything before the first one already stored.
assert.deepStrictEqual(untilKnown([{ id: "9" }, { id: "8" }, { id: "5" }, { id: "4" }], new Set(["5"])), { fresh: [{ id: "9" }, { id: "8" }], reachedKnown: true });
assert.deepStrictEqual(untilKnown([{ id: "9" }], new Set()).reachedKnown, false);
// Every extra has its path in the Account schema: strict mode silently drops the $set that turns on one without it
// (Liking once shipped that way, and could never be switched on).
{
  const { MODULES } = require("../services/features");
  const AccountModel = require("../models/Account");
  for (const key of MODULES) assert.ok(AccountModel.schema.path(`features.${key}`), `Account.features.${key} is in the schema`);
}
// A profile's connection_status is the READING account's relationship (models/Follow.js), never kept on the shared
// Person, raw copy included.
{
  const PersonModel = require("../models/Person");
  const doc = PersonModel.fromApi({ id: "9", username: "p", connection_status: ["followed_by"] }, new Date());
  assert.ok(!("connection_status" in doc.raw) && !("connection_status" in doc), "Person never stores connection_status");
}

// The look back through your likes (it used to stop forever at the first run's cap).
// The new-likes check starts with X's smallest page (it found 1-2 new likes per run while asking for 100 every time),
// and only goes to full pages after a page that was all new.
assert.deepStrictEqual([0, 1, 2].map(newLikesPageSize), [10, 100, 100]);
// Not begun: no forward pass (the look back starts at the top and reads the new ones itself).
assert.deepStrictEqual(likesPlan({}), { forward: false, backfill: true, from: undefined });
// Mid-way: new likes first, then resume from the saved token.
assert.deepStrictEqual(likesPlan({ backfillToken: "T2", backfillRead: 200 }), { forward: true, backfill: true, from: "T2" });
// Done: new likes only.
assert.deepStrictEqual(likesPlan({ backfillDone: true, backfillRead: 2994 }), { forward: true, backfill: false, from: undefined });
// Without the look back (Liking alone, no People): new likes only, from the first run, never backwards.
assert.deepStrictEqual(likesPlan({}, { lookBack: false }), { forward: true, backfill: false, from: undefined });
// After a page: the place moves to X's next token and the count grows; no next token = X has nothing older.
assert.deepStrictEqual(afterBackfillPage({ backfillRead: 100 }, { posts: new Array(100), nextToken: "T3" }), { backfillToken: "T3", backfillRead: 200, backfillDone: false });
assert.deepStrictEqual(afterBackfillPage({ backfillRead: 2900 }, { posts: new Array(94) }), { backfillToken: undefined, backfillRead: 2994, backfillDone: true });

// YOUR LIKES RECONCILE EXACTLY TO YOUR HISTORY (the Inbox once showed likes as owed that had been given, since
// only the newest 1,000 were read; and "if its a day of posts its a day of likes"): the look back ends at the
// history's start, once a whole page is of posts older than it, or X has nothing older; a first read is held until then.
{
  const { pastFloor, LIKES_FIRST_READ_MAX } = require("../services/extras");
  const page = (ids, nextToken = "T") => ({ posts: ids.map((id) => ({ id })), nextToken });
  assert.strictEqual(pastFloor(page(["90", "80"]), "100"), true, "every liked post older than the history's start: past it");
  assert.strictEqual(pastFloor(page(["190", "80"]), "100"), false, "one inside it: not yet");
  assert.strictEqual(pastFloor(page(["190"], null), "100"), true, "X has nothing older: as far as it goes");
  assert.strictEqual(pastFloor(page([]), "100"), false, "an empty page with more behind it says nothing");
  assert.strictEqual(pastFloor(page(["2071000000000000001"]), "2121000000000000001"), true, "real-size ids compare as numbers, not strings");
  assert.strictEqual(pastFloor(page(["90"]), null), false, "no history read yet: only X's end stops it");
  const inside = afterBackfillPage({ backfillRead: 0, reconciled: false }, page(["190", "150"]), "100");
  assert.ok(inside.reconciled === false && inside.backfillDone === false && inside.backfillToken === "T", "a page inside the history: held, and the look back goes on");
  const past = afterBackfillPage({ reconciled: false }, page(["90"]), "100");
  assert.ok(past.reconciled === true && past.backfillDone === true && past.backfillToken === "T", "the page past it: reconciled, the look back over, and its place KEPT (reading further back reopens it there)");
  assert.strictEqual(afterBackfillPage({}, page(["90"], null), "100").backfillToken, undefined, "X's end: no place to keep");
  assert.strictEqual(afterBackfillPage({ reconciled: true }, page(["190"]), "100").reconciled, true, "reconciled stays reconciled");
  const legacy = afterBackfillPage({ backfillRead: 5 }, page(["90"]), "100");
  assert.ok(!("reconciled" in legacy) && legacy.backfillDone === true, "an account from before is never held, and its look back stops at the history too");
  assert.ok(LIKES_FIRST_READ_MAX > 1000, "a first read may read past the per-run limit");
  // Its price, per option, the same rule for "how far back?", the front page and Settings.
  const { firstReadLikes, pullCost, historyOptions } = require("../services/history");
  const { LIKES_PER_POST_READ } = require("../lib/pricing");
  assert.strictEqual(firstReadLikes({ budget: 1000 }), (Math.ceil(Math.ceil(1000 * LIKES_PER_POST_READ) / 100) + 2) * 100, "likes over the same stretch, in X's whole pages of 100, plus the two the look back reads past its end");
  assert.strictEqual(firstReadLikes({ budget: 57 }), 300, "a short read: a real one, 57 posts and mentions, read 299 of its likes (it was quoted 65)");
  assert.strictEqual(firstReadLikes({ budget: 0 }), 0, "nothing read back, no likes");
  assert.ok(firstReadLikes({ budget: 3000 }) > firstReadLikes({ budget: 1000 }), "a longer stretch, more likes");
  assert.strictEqual(firstReadLikes({ budget: 3000, likeCount: 450 }), 450, "never more than the account has");
  assert.ok(pullCost(1000, 1000) > pullCost(1000, 0) && pullCost(1000, 1000, { owned: true }) < pullCost(1000, 1000), "likes are in the cost; the owner's at the owned rate");
  const opts = historyOptions(3000, { likeCount: 2000 });
  assert.ok(opts.every((o) => o.likes === firstReadLikes({ budget: o.budget, likeCount: 2000 }) && o.estimate === pullCost(o.budget, o.likes) && o.detail.includes("of your likes")), "every option carries its own stretch's likes, in its price and its words");
  const { firstReadGoing } = require("../services/features");
  const on = { features: { inbox: { on: true, since: new Date(0) } }, createdAt: new Date(0) };
  assert.strictEqual(firstReadGoing(on, { lastRunAt: new Date(), likes: { reconciled: false } }), true, "a run that finished with likes unreconciled still holds the Inbox");
  assert.strictEqual(firstReadGoing(on, { lastRunAt: new Date(), likes: { reconciled: true } }), false, "reconciled: the Inbox opens");
  assert.strictEqual(firstReadGoing(on, { lastRunAt: new Date(), likes: {} }), false, "an account from before: never held");
}

// ── the leaderboard list: search, sort, page ──
const mk = (id, name, mutual, followers) => ({ id, username: name, profile: { name: name.toUpperCase(), followers }, mutual, total: mutual * 2, last: null });
const board10 = [mk("a", "ann", 9, 50), mk("b", "bob", 8, 500), mk("c", "cat", 7, 5), mk("d", "dan", 6, 5000), mk("e", "eve", 5, 0)];
const q0 = listing.parseQuery({});
assert.deepStrictEqual([q0.sort, q0.dir, q0.page], ["mutual", "desc", 1], "defaults: back and forth, most first (the arrow points the way the numbers run)");
let l = listing.listRows(board10, q0, 2);
assert.deepStrictEqual([l.rows.map((r) => r.id), l.pages, l.from, l.to, l.matched], [["a", "b"], 3, 1, 2, 5]);
l = listing.listRows(board10, listing.parseQuery({ sort: "followers" }), 10);
assert.deepStrictEqual(l.rows.map((r) => r.id), ["d", "b", "a", "c", "e"], "followers sorts its natural way (most first); ties keep rank");
assert.deepStrictEqual(l.rows.map((r) => r.rank), [4, 2, 1, 3, 5], "each row keeps its real rank");
assert.deepStrictEqual(listing.listRows(board10, listing.parseQuery({ q: "@BO" }), 10).rows.map((r) => r.id), ["b"], "search: name or handle, case-insensitive, @ ignored");
assert.strictEqual(listing.listRows(board10, listing.parseQuery({ page: "99" }), 2).page, 3, "a page past the end clamps to the last");
assert.strictEqual(listing.parseQuery({ sort: "nope", dir: "sideways" }).sort, "mutual", "unknown sort falls back");
// A key every object inherits is no sort: ?sort=constructor once reached listRows as sorts.constructor (Object) and
// every list page answered 500.
for (const sort of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
  assert.strictEqual(listing.parseQuery({ sort }).sort, "mutual", `?sort=${sort} falls back`);
  assert.doesNotThrow(() => listing.listRows(board10, listing.parseQuery({ sort }), 10), `?sort=${sort} draws the list`);
}
assert.deepStrictEqual(listing.listRows(board10, q0, 10).rows.map((r) => r.rank), [1, 2, 3, 4, 5], "the default view is exactly the ranking");
assert.strictEqual(listing.hrefFor(q0), "/people", "default view = bare URL");
assert.strictEqual(listing.sortHref(q0, "followers"), "/people?sort=followers", "first click: natural direction, not written out");
assert.strictEqual(listing.sortHref(listing.parseQuery({ sort: "followers" }), "followers"), "/people?sort=followers&dir=asc", "clicking the active column flips it");
assert.deepStrictEqual(listing.pager({ ...q0, page: 6, pages: 12 }).links.map((p) => (p.gap ? "…" : p.page)), [1, "…", 4, 5, 6, 7, 8, "…", 12]);

// What counts is what a post says, not which feed brought it: P's reply to YOU that arrived only as thread
// context (X's mentions feed reaches back just ~800 mentions) counts as theirs-to-you; P's reply to T in the
// same context doesn't, and T (who never wrote to you) never appears.
const oldReply = tp("150", "context", P, "149", { parent: "149", to: ME, day: 1 });
const mentionsMe = { ...tp("151", "context", T, "151"), mentions: [{ id: ME, username: "me" }] };
const withOld = leaderboard([...tposts, oldReply, mentionsMe], ME);
assert.strictEqual(withOld.find((r) => r.id === P).in, 3, "a context post replying to you counts (was 2 before it)");
assert.strictEqual(withOld.find((r) => r.id === T).in, 1, "so does one that mentions you");
assert.strictEqual(leaderboard([{ ...oldReply, gone: { title: "Not Found" } }], ME).length, 0, "a gone placeholder never counts");

// Context posts not addressed to you never count: T never appears, P counts only what's addressed to you.
const tboard = leaderboard(tposts, ME);
assert.deepStrictEqual(tboard.map((r) => r.id), [P]);
assert.deepStrictEqual([tboard[0].out, tboard[0].in], [3, 2]);

// ── post text ──
// A reply loses X's @-prefix (located by X's mention offsets), keeps a
// mention later in the text, and keeps everything if it's only mentions.
// Every mention left in the text links to that person on X.
const m = (start, end, username) => ({ id: "x", username, start, end });
const at = (name) => ({ text: `@${name}`, href: `https://x.com/${name}` });
assert.deepStrictEqual(segments({ text: "@ann @bob hello @cat", mentions: [m(0, 4, "ann"), m(5, 9, "bob"), m(16, 20, "cat")] }, { isReply: true }), [{ text: "hello " }, at("cat")]);
assert.deepStrictEqual(segments({ text: "@ann hello", mentions: [m(0, 4, "ann")] }), [at("ann"), { text: " hello" }], "not a reply: prefix kept, and linked");
assert.deepStrictEqual(segments({ text: "@ann ", mentions: [m(0, 4, "ann")] }, { isReply: true }), [at("ann")], "only mentions: kept");
// X's own boundary wins when stored: an @name TYPED at the start stays (the guess hid it).
assert.deepStrictEqual(segments({ text: "@ann @bob is the one", mentions: [m(0, 4, "ann"), m(5, 9, "bob")], raw: { display_text_range: [5, 20] } }, { isReply: true }), [at("bob"), { text: " is the one" }], "a typed @name at the start is kept");
// Found by "@username" in entity order, so emoji before them don't matter; as typed (any case) but linked by X's own
// username; never inside a longer handle; a mention X didn't tag stays text.
assert.deepStrictEqual(
  segments({ text: "🙏 thanks @Annie_K @dev_lab and @dev_labs, @nobody", mentions: [m(10, 18, "annie_k"), m(19, 27, "dev_lab")] }),
  [{ text: "🙏 thanks " }, { text: "@Annie_K", href: "https://x.com/annie_k" }, { text: " " }, at("dev_lab"), { text: " and @dev_labs, @nobody" }]
);
// Links: real domain, quote link dropped, media marked; found by t.co string,
// so an emoji before them (offsets drift) doesn't matter.
const u = (id, expanded, display, start, media = false) => ({ url: `https://t.co/${id}`, expanded, display, start, media });
assert.deepStrictEqual(
  segments(
    {
      text: "🔥🔥 see https://t.co/A and https://t.co/M https://t.co/Q",
      urls: [u("Q", "https://x.com/u/status/400", "x.com/u/status/400", 40), u("A", "https://example.com", "example.com", 7), u("M", "https://x.com/u/status/1/photo/1", "pic.x.com/M", 34, true)],
    },
    { quotedId: "400" }
  ),
  [{ text: "🔥🔥 see " }, { text: "example.com", href: "https://example.com" }, { text: " and " }, { media: true }]
);

// What the context pass fetches next: what every DRAWN post (in the account's conversations) answers and quotes,
// context posts included (a quote in a context post used to go unread); a post outside them (fetched as a quote,
// a card) walks nothing; stored ids skipped; newest referencing post first.
const refs = (id, stream, parent, quote, conv = "c") => ({
  _id: id,
  stream,
  conversationId: conv,
  referenced: [{ type: "replied_to", id: parent }, ...(quote ? [{ type: "quoted", id: quote }] : [])],
});
const round = [refs("10", "own", "5", "6"), refs("11", "context", "7", "8"), refs("12", "mention", "10"), refs("13", "context", "3", "4", "elsewhere")];
const drawnHere = (p) => p.conversationId === "c";
assert.deepStrictEqual(contextToFetch(round, new Set(["10", "11", "12"]), drawnHere), ["7", "8", "5", "6"], "a context post's quote is read; a quote card (another conversation) walks nothing");

// What the header shows about you, from X's user object (sign-in and the profile pass share this).
const Account = require("../models/Account");
assert.deepStrictEqual(
  Account.selfFields({ id: "1", name: "Maya", profile_image_url: "https://pbs.twimg.com/a_normal.jpg", public_metrics: { followers_count: 120, following_count: 85 } }),
  { name: "Maya", image: "https://pbs.twimg.com/a_bigger.jpg", followers: 120, following: 85 }
);

// One shared post, seen by two accounts: A's own post that mentions B is "own"
// to A, "mention" to B, and "context" to anyone else.
const shared = { _id: "900", accounts: [{ id: "A", kind: "own" }, { id: "B", kind: "mention" }] };
assert.deepStrictEqual(["A", "B", "C"].map((id) => Post.streamFor(shared, id)), ["own", "mention", "context"]);

// X escapes exactly &, < and >; a literal "&lt;" someone typed survives.
assert.strictEqual(Post.unescapeX("a &amp;lt; b &gt; c &amp; d"), "a &lt; b > c & d");

// A long post (over 280): X's `text` is cut and carries the reply prefix; note_tweet.text is whole and doesn't.
// The shape seen in a spike (invented words). Stored whole WITH the prefix, so text.js shows it like any reply.
const longReply = Post.fromApi({
  id: "2000000000000000001",
  author_id: ME,
  in_reply_to_user_id: "77",
  referenced_tweets: [{ type: "replied_to", id: "1" }],
  entities: { mentions: [{ start: 0, end: 12, id: "77", username: "maya_sample" }] },
  text: "@maya_sample ha yes, each clip takes a while to make and goes like this:\n\n1. Sketch the idea on paper first\n4. Then cut the clips to the music and",
  note_tweet: { text: "ha yes, each clip takes a while to make and goes like this:\n\n1. Sketch the idea on paper first\n4. Then cut the clips to the music and also “line up the transitions to the beat”" },
});
assert.ok(longReply.text.startsWith("@maya_sample ha yes") && longReply.text.endsWith("to the beat”"), "whole text, prefix kept");
assert.strictEqual(segments(longReply, { isReply: true }).map((s) => s.text).join(""), longReply.text.slice(13), "shown without the prefix, all of it");
// The tail's own mention and link live only in note_tweet.entities (offsets into the note): shifted by the prefix
// and merged; what `text` already had isn't doubled.
const tailEntities = Post.fromApi({
  id: "2",
  author_id: ME,
  entities: { mentions: [{ start: 0, end: 2, id: "77", username: "a" }, { start: 7, end: 9, id: "88", username: "b" }] },
  text: "@a hi, @b cut",
  note_tweet: {
    text: "hi, @b cut short here, then @c and https://t.co/x",
    entities: {
      mentions: [{ start: 4, end: 6, id: "88", username: "b" }, { start: 28, end: 30, id: "99", username: "c" }],
      urls: [{ start: 35, end: 49, url: "https://t.co/x", expanded_url: "https://example.com", display_url: "example.com" }],
    },
  },
});
assert.strictEqual(tailEntities.text, "@a hi, @b cut short here, then @c and https://t.co/x");
assert.deepStrictEqual(tailEntities.mentions.map((m) => [m.id, m.start]), [["77", 0], ["88", 7], ["99", 31]], "tail mention found, shifted, b not doubled");
assert.deepStrictEqual(tailEntities.urls.map((u) => [u.display, u.start]), [["example.com", 38]]);
// Media (lib/x.js attaches X's media objects as `media`): a photo keeps its url, a video its preview frame; only X's
// image host survives. The post's pic.x.com link is dropped when its pictures show, a marker otherwise (quotes).
const withPics = Post.fromApi({
  id: "4",
  text: "look https://t.co/p",
  entities: { urls: [{ start: 5, end: 19, url: "https://t.co/p", expanded_url: "https://x.com/u/status/4/photo/1", display_url: "pic.x.com/p", media_key: "3_1" }] },
  media: [
    { media_key: "3_1", type: "photo", url: "https://pbs.twimg.com/media/A.jpg", width: 800, height: 600 },
    { media_key: "13_2", type: "video", preview_image_url: "https://pbs.twimg.com/amplify_video_thumb/2/img/B.jpg", duration_ms: 62717 },
    { media_key: "3_3", type: "photo", url: "https://evil.example/x.jpg" },
  ],
});
assert.deepStrictEqual(withPics.media.map((m) => [m.type, m.url]), [["photo", "https://pbs.twimg.com/media/A.jpg"], ["video", "https://pbs.twimg.com/amplify_video_thumb/2/img/B.jpg"]]);
assert.strictEqual(Post.fromApi({ id: "5", text: "no pics" }).media, undefined);
assert.deepStrictEqual(segments(withPics, { mediaShown: true }), [{ text: "look" }], "pictures shown: the link goes");
assert.deepStrictEqual(segments(withPics), [{ text: "look " }, { media: true }], "no pictures to show: the marker stays");
const picThread = threads([{ ...withPics, _id: "4", authorId: P, inReplyToUserId: ME, conversationId: "4", createdAt: "2026-01-02" }], ME, P);
assert.deepStrictEqual(picThread[0].dialogue[0].media.map((m) => [m.thumb, m.badge]), [["https://pbs.twimg.com/media/A.jpg?name=small", null], ["https://pbs.twimg.com/amplify_video_thumb/2/img/B.jpg?name=small", "▶ 1:02"]]);
assert.deepStrictEqual(picThread[0].dialogue[0].segments, [{ text: "look" }], "its pictures show, so the link leaves the text");
// SAVED MEDIA (services/mediaLibrary.js save): on someone else's post, a photo that could go in a reply offers "+ Save"
// (saved or not); a video doesn't; nothing does without a media library (no `mediaSaved`) or on your own post.
const savable = (authorId, mediaSaved) => threads([{ ...withPics, _id: "4", authorId, inReplyToUserId: authorId === ME ? P : ME, conversationId: "4", createdAt: "2026-01-02" }], ME, P, new Map(), { mediaSaved })[0];
assert.deepStrictEqual(savable(P, new Set(["3_A"])).dialogue[0].media.map((m) => m.save), [{ saved: false, kind: "photo" }, null], "their photo: + Save; their video: none");
assert.deepStrictEqual(savable(P, null).dialogue[0].media.map((m) => m.save), [null, null], "no media library: nothing to save into");
// A quote of a post with pictures (someone quoting your photo): the quote card carries them too.
const quoting = { _id: "6", authorId: P, inReplyToUserId: ME, conversationId: "6", createdAt: "2026-01-03", text: "fixing it https://t.co/q", referenced: [{ type: "quoted", id: "4" }], urls: [{ url: "https://t.co/q", expanded: "https://x.com/me/status/4", start: 10 }] };
const quoteCard = threads([quoting, { ...withPics, _id: "4", authorId: ME, conversationId: "4" }], ME, P).find((t) => t.id === "6").dialogue[0].quoted;
assert.deepStrictEqual([quoteCard.segments, quoteCard.media.length], [[{ text: "look" }], 2]);

// A post that isn't long is untouched.
assert.strictEqual(Post.fromApi({ id: "3", text: "@a short &amp; sweet" }).text, "@a short & sweet");

// ── profiles ──
// A fetched profile names bob (never @mentioned) and wins over a stale
// @mention username (ann renamed); people without one keep the fallback.
const profiles = new Map([
  ["20", { _id: "20", username: "bob", name: "Bob B" }],
  ["10", { _id: "10", username: "ann_new", name: "Ann" }],
]);
const named = leaderboard(posts, ME, profiles);
assert.strictEqual(named.find((r) => r.id === "20").username, "bob");
assert.strictEqual(named.find((r) => r.id === "10").username, "ann_new", "profile beats an old @mention");
assert.strictEqual(named.find((r) => r.id === "30").username, "cat", "no profile: @mention fallback");
assert.strictEqual(named.find((r) => r.id === "30").profile, null);

// Which profiles a run looks up: missing or stale, in rank order.
const DAY = 24 * 3600 * 1000;
const now = Date.UTC(2026, 10, 12);
const fetched = new Map([
  ["a", new Date(now - 2 * DAY)],
  ["b", new Date(now - 40 * DAY)],
]);
assert.deepStrictEqual(profilesToFetch(["c", "a", "b"], fetched, now), ["c", "b"], "new + stale, order kept");
// Freshness by who it is: you (index 0) every run, your top 50 weekly, everyone else monthly.
const HOUR = 3600 * 1000;
const ranked = Array.from({ length: 61 }, (_, i) => `u${i}`);
const ages = new Map(ranked.map((id) => [id, new Date(now - 8 * DAY)])); // everyone 8 days old...
ages.set("u0", new Date(now - 60000)); // ...except you: a minute
const due = profilesToFetch(ranked, ages, now);
assert.ok(due.includes("u0"), "your own profile: every run, however fresh (X bills it once a day)");
assert.ok(due.includes("u1") && due.includes("u50"), "top 50: due after a week");
assert.ok(!due.includes("u51") && !due.includes("u60"), "everyone else: not due until a month");

// ── the profile policy and the month's estimate (services/syncPrefs.js: ONE policy, the front page's assumptions) ──
{
  const sp = require("../services/syncPrefs");
  const d = sp.PROFILES;
  assert.deepStrictEqual({ ...d }, { topN: 50, topDays: 7, restDays: 30 }, "the policy: your top 50 weekly, everyone else monthly (the front page's estimate assumes the same)");
  // profileTtlMs on other values (LOOKED_UP_ONCE is one): top 25 daily, everyone else never again.
  const custom = { ...d, topN: 25, topDays: 1, restDays: 0 };
  const twoDays = new Map(ranked.map((id) => [id, new Date(now - 2 * DAY)]));
  const dueC = profilesToFetch(ranked, twoDays, now, { prefs: custom });
  assert.ok(dueC.includes("u1") && dueC.includes("u25") && !dueC.includes("u26") && !dueC.includes("u60"), "top 25 daily; after them, never again once looked up");
  assert.ok(profilesToFetch(["u0", "u1"], new Map(), now, { prefs: custom }).length === 2, "never-looked-up people are always fetched");
  assert.ok(profilesToFetch(["u0", "u1"], new Map([["u0", new Date(now - 60000)], ["u1", new Date(now - 60000)]]), now, { prefs: { ...d, topDays: 0 } }).length === 2, "a 0-day tier: due whatever the age");
  // THE month's estimate (estimateMonth; the front page and Settings both): 10 written + 10 received a day = 600 posts;
  // X bills a profile once a day, so the top 50 weekly is 50 × $0.01 × 30/7; its parts add up to its total.
  const est = sp.estimateMonth({ written: 10, received: 10 }, d);
  const part = Object.fromEntries(est.parts.map((p) => [p.key, p]));
  assert.strictEqual(part.posts.count, 600, "a month of posts: (written + received) × 30");
  assert.ok(Math.abs(part.top.usd - 50 * 0.01 * 30 / 7) < 1e-9 && part.top.count === 50, "the top 50, weekly");
  assert.ok(Math.abs(part.rest.usd - part.rest.count * 0.01) < 1e-9, "everyone else, monthly");
  assert.ok(part.top.count + part.rest.count === part.people.count, "the month's people split into the two tiers (the account itself isn't one)");
  assert.ok(Math.abs(est.usd - est.parts.reduce((s, p) => s + p.usd, 0)) < 1e-9 && Math.abs(part.self.usd - sp.SELF_MONTHLY_USD) < 1e-9, "the parts add up to the total");
  assert.ok(sp.estimateMonth({}, d).parts.every((p) => p.key === "self" || p.usd === 0), "nothing posted: only your own profile");
}

// Person.fromApi: X's 48px image upgraded to 73px, absent fields left out
// (so a replace never writes nulls, and clears an old `gone`).
const doc = Person.fromApi(
  { id: "9", username: "z", name: "Zed", profile_image_url: "https://pbs.twimg.com/profile_images/1/a_normal.jpg", public_metrics: { followers_count: 5 } },
  new Date(now)
);
assert.strictEqual(doc.image, "https://pbs.twimg.com/profile_images/1/a_bigger.jpg");
assert.strictEqual(doc.followers, 5);
assert.ok(!("bio" in doc) && !("gone" in doc) && !("location" in doc) && !("website" in doc));

// A bio's t.co links and the profile website come back expanded from X's entities, and render as real domains.
const withLinks = Person.fromApi(
  {
    id: "9",
    description: "building nook!\nhttps://t.co/A8O8",
    entities: {
      description: { urls: [{ start: 15, end: 31, url: "https://t.co/A8O8", expanded_url: "https://nook.example", display_url: "nook.example" }] },
      url: { urls: [{ url: "https://t.co/zz", expanded_url: "https://maya.example/", display_url: "maya.example" }] },
    },
  },
  new Date(now)
);
assert.deepStrictEqual(withLinks.website, { url: "https://maya.example/", display: "maya.example" });
assert.deepStrictEqual(bioSegments(withLinks), [{ text: "building nook!\n" }, { text: "nook.example", href: "https://nook.example" }]);
assert.deepStrictEqual(bioSegments({}), []);

// ── sync paging ──
// A fake X: 12 posts (ids 100..111), pages of 5, newest first.
function fakeX(all) {
  return (req) => {
    let list = all.filter((p) => (!req.sinceId || BigInt(p.id) > BigInt(req.sinceId)) && (!req.untilId || BigInt(p.id) < BigInt(req.untilId)));
    list.sort((a, b) => Number(BigInt(b.id) - BigInt(a.id)));
    const start = req.paginationToken ? Number(req.paginationToken) : 0;
    const page = list.slice(start, start + 5);
    return { posts: page, nextToken: start + 5 < list.length ? String(start + 5) : undefined };
  };
}
function run(state, serve, maxPages = Infinity) {
  const steps = streamSteps(null, state, "own", "tweets");
  let step = steps.next();
  let pages = 0;
  while (!step.done && pages < maxPages) {
    step = steps.next(serve(step.value));
    pages++;
  }
  return pages;
}
let all = Array.from({ length: 12 }, (_, i) => ({ id: String(100 + i) }));
const state = { own: {} };

// Cap hit after 2 pages: progress kept, backfill not done.
run(state, fakeX(all), 2);
assert.strictEqual(state.own.newestId, "111");
assert.strictEqual(state.own.oldestId, "102");
assert.strictEqual(state.own.backfillDone, undefined);

// Next run resumes below 102 and finishes history.
run(state, fakeX(all));
assert.strictEqual(state.own.oldestId, "100");
assert.strictEqual(state.own.backfillDone, true);

// New posts arrive: a run reads only those.
all = all.concat([{ id: "112" }, { id: "113" }]);
const seen = [];
run(state, (req) => {
  const page = fakeX(all)(req);
  seen.push(...page.posts.map((p) => p.id));
  return page;
});
assert.deepStrictEqual(seen, ["113", "112"], "forward pass reads only new posts");
assert.strictEqual(state.own.newestId, "113");

// THE RESUME READ (services/pause.js): paused with the bookmark at 113, posts 114..125 arrived meanwhile. Resuming to a
// moment (as an id) reads EXACTLY what came after it, nothing before; "everything since" (no moment) reads it all; a
// moment older than the bookmark changes nothing.
{
  const pause = require("../services/pause");
  const missed = all.concat(Array.from({ length: 12 }, (_, i) => ({ id: String(114 + i) })));
  const resumedTo = (floorId) => {
    const s = { own: { ...state.own } };
    for (const [k, v] of Object.entries(pause.bookmarksFor(s, floorId))) {
      const [, field] = k.split(".");
      if (v === undefined) delete s.own[field];
      else s.own[field] = v;
    }
    const read = [];
    run(s, (req) => {
      const page = fakeX(missed)(req);
      if (req.phase === "forward") read.push(...page.posts.map((p) => p.id));
      return page;
    });
    return read.sort();
  };
  assert.deepStrictEqual(resumedTo("119"), ["120", "121", "122", "123", "124", "125"], "resumed to a moment: exactly what came after it");
  assert.deepStrictEqual(resumedTo(null).length, 12, "everything since the pause: all of it");
  assert.deepStrictEqual(resumedTo("100").length, 12, "a moment before the bookmark: from the bookmark, nothing re-read");
  assert.deepStrictEqual(pause.bookmarksFor({ own: {} }, "119"), {}, "a stream never read keeps no bookmark");

  // Who's held: you paused it, or it's back with money after a long stop. At $0 the gate holds it (and wakes
  // auto-refill); a short stop just ends.
  const day = 864e5;
  const at = (ms, why) => ({ pause: { at: new Date(Date.now() - ms), why } });
  assert.deepStrictEqual(
    [pause.held({}, false), pause.held(at(60e3, "you"), false), pause.held(at(3 * day, "balance"), true), pause.held(at(3 * day, "balance"), false), pause.held(at(3600e3, "balance"), false)],
    [false, true, false, true, false],
    "held: by you; back with money after more than a day; not at $0 (the gate), not after a short stop"
  );
  assert.deepStrictEqual([pause.asks(at(3600e3, "you")), pause.asks(at(2 * day, "you"))], [false, true], "only more than a day away asks how far back");

  // KEEP SYNCING LIVE off (services/away.js): an hour without xtoolio open pauses it ("away", held like "you"); on (the
  // default), a pause or no module never does; "away" asks Catch up or Skip, its label "since you left".
  {
    const away = require("../services/away");
    const now = Date.now();
    const off = (seenMs, extra = {}) => ({ keepLive: false, features: { inbox: { on: true } }, seenAt: new Date(now - seenMs), ...extra });
    assert.deepStrictEqual(
      [
        !!away.awaySince(off(61 * 60e3), null, now),
        !!away.awaySince(off(30 * 60e3), null, now),
        !!away.awaySince(off(3 * 3600e3), new Date(now - 10 * 60e3), now), // a tab open until 10 minutes ago: present then
        !!away.awaySince({ ...off(3 * 3600e3), keepLive: undefined }, null, now), // the default: keeps syncing
        !!away.awaySince(off(3 * 3600e3, { pause: { at: new Date(), why: "you" } }), null, now),
        !!away.awaySince(off(3 * 3600e3, { features: {} }), null, now),
        !!away.awaySince(off(3 * 3600e3, { seenAt: undefined }), null, now), // never seen: nothing to measure from
      ],
      [true, false, false, false, false, false, false],
      "away: off and an hour since xtoolio was last open, measured from the later of seenAt and the open tab"
    );
    assert.strictEqual(away.awaySince(off(3 * 3600e3), new Date(now - 2 * 3600e3), now).getTime(), now - 2 * 3600e3, "it left when the tab last was");
    assert.ok(pause.held(at(3 * 3600e3, "away"), false), "away is held");
    assert.deepStrictEqual([pause.awayFor(at(3 * 3600e3, "away")), pause.awayFor(at(2 * day, "away")), pause.awayFor(at(61 * 60e3, "away"))], ["3 hours", "2 days", "1 hour"], "how long, in words");
    assert.deepStrictEqual(pause.resumeOptions(at(3 * 3600e3, "away"), { perDay: 48 }).map((o) => [o.key, o.label]), [["now", "From now"], ["since", "Everything since you left (3 hours)"]], "back the same day: Catch up or Skip");
    const { firstReadLikes } = require("../services/history");
    assert.deepStrictEqual([firstReadLikes({ budget: 6 }), firstReadLikes({ budget: 6, overrun: 0 })], [300, 100], "a resume's likes stop at the first one kept: no overrun pages (a first read's 300 likes for a few posts is a resume's one page)");
  }

  // THE QUESTION: the first read's stretches that fit inside the time away, everything since, and From now; sized
  // from the pace, priced like the first read.
  const opts = pause.resumeOptions(at(10 * day, "you"), { perDay: 50 });
  assert.deepStrictEqual(opts.map((o) => [o.key, o.days, o.budget]), [["now", 0, 0], ["day", 1, 50], ["week", 7, 350], ["since", null, 500]], "10 days away: From now, 1 day, 1 week, everything since (no month)");
  assert.ok(opts[0].estimate === 0 && opts[0].detail === "Skip what you missed" && opts[3].label === "Everything since you paused (10 days)" && opts[3].estimate > opts[2].estimate, "priced: nothing for From now, more for more");
  assert.strictEqual(pause.resumeOptions(at(400 * day, "you"), { perDay: 50 }).find((o) => o.key === "since").budget, 4000, "capped at what X serves");
  {
    // Likes read (People on): even From now reads one page of them to mark the moment, and is priced for it; the
    // others carry their stretch's likes. Without, no likes in any price.
    const withPeople = { ...at(10 * day, "you"), features: { people: { on: true } }, tokens: { scope: "tweet.read users.read like.read" } };
    const [now, day1] = pause.resumeOptions(withPeople, { perDay: 50, likeCount: 40 });
    assert.ok(now.likes === 40 && now.estimate > 0 && now.detail === "Skip what you missed", "From now with likes read: one page (at most the likes you have), priced");
    assert.ok(day1.likes > 0 && opts[1].likes === 0 && day1.estimate > opts[1].estimate, "a stretch's likes are priced only when they're read");
  }

  // READ FURTHER BACK (services/further.js): after a 1-day first read, the longer stretches, each priced for the rest;
  // then the stages through the REAL stream steps (a fake X): the stream that stopped at the depth reads on from where
  // it stopped, the one X ran out on stays done, and only then do your likes reopen, from their kept place.
  {
    const further = require("../services/further");
    const { likesPlan } = require("../services/extras");
    const acct = { _id: "me", history: { budget: 50 }, postCount: 3000, likeCount: 5000 };
    const stopped = () => ({ own: { newestId: "111", oldestId: "105", backfillDone: true, budgetReached: true }, mention: { backfillDone: true }, likes: { backfillDone: true, backfillToken: "T", backfillRead: 300 }, backfillRead: 50 });
    const choices = further.options(acct, stopped(), { perDay: 50 });
    assert.deepStrictEqual(choices.map((o) => [o.key, o.budget]), [["week", 350], ["month", 1500], ["all", 3050]], "past a 1-day read (50): 1 week, 1 month and everything X serves (capped at what's left: 3,000 posts, the mentions X ran out on), the day itself dropped");
    // WHAT'S LEFT, counted: every post read and the mentions X ran out on → nothing offered (the depth arithmetic alone
    // offered hundreds "more").
    const allRead = { ...stopped(), likes: { backfillDone: true, backfillRead: 2500 } };
    assert.deepStrictEqual(further.options({ ...acct, postCount: 2000, history: { budget: 2800 } }, allRead, { perDay: 50, stored: { own: 1980, mention: 800 } }), [], "20 posts left: nothing offered");
    assert.strictEqual(further.leftToRead({ postCount: 5000 }, { own: { budgetReached: true }, mention: { budgetReached: true } }, { own: 156, mention: 139 }), 3200 - 156 + 800 - 139, "left: X's limit of your posts minus those stored, and of mentions while that stream stopped at the depth");
    const near = further.options({ ...acct, history: { budget: 50 } }, stopped(), { perDay: 50, stored: { own: 2700 } });
    assert.deepStrictEqual(near.map((o) => [o.key, o.budget]), [["all", 350]], "300 left: the week reaches it, so it's everything, and nothing longer");
    assert.deepStrictEqual(further.options({ ...acct, history: { budget: 2000 } }, stopped(), { perDay: 50 }).map((o) => o.key), ["all"], "deeper than a month already: the rest X serves is still offered");
    assert.ok(choices[0].detail.startsWith("Up to 300 more posts and mentions") && choices[0].estimate > 0 && choices[1].estimate > choices[0].estimate, "each priced for the rest beyond what's read");
    const lost = further.options(acct, { ...stopped(), likes: { backfillDone: true, backfillRead: 300 } }, { perDay: 50 });
    assert.strictEqual(lost[0].likes, choices[0].likes + 300, "a look back that finished before its place was kept reads its likes again: in the price");
    assert.deepStrictEqual(further.options(acct, { own: { backfillDone: true }, mention: { backfillDone: true } }, { perDay: 50 }), [], "X had nothing older: nothing more to offer");
    assert.deepStrictEqual(further.options({ ...acct, history: {} }, stopped(), { perDay: 50 }), [], "no history chosen: nothing to deepen");

    const st = stopped();
    assert.deepStrictEqual(further.begin(st), ["own"], "begin: only the stream that stopped at the depth reopens");
    further.afterPosts(st, { lookBack: true });
    assert.strictEqual(st.furtherStage, "posts", "the likes wait while the posts are still to read");
    run(st, fakeX(Array.from({ length: 12 }, (_, i) => ({ id: String(100 + i) }))));
    assert.ok(st.own.oldestId === "100" && st.own.backfillDone && !st.own.budgetReached, "the stream read on from 105 to X's oldest");
    further.afterPosts(st, { lookBack: true });
    assert.ok(st.furtherStage === "likes" && st.likes.backfillDone === false, "posts in: your likes' look back reopens");
    assert.deepStrictEqual(likesPlan(st.likes), { forward: true, backfill: true, from: "T" }, "…from its kept place, not your newest like");
    further.afterLikes(st);
    assert.strictEqual(st.furtherStage, "likes", "not done until the likes reach the new start");
    st.likes.backfillDone = true;
    further.afterLikes(st);
    assert.strictEqual(st.furtherStage, "done", "likes in: done");
    const noLook = stopped();
    further.begin(noLook);
    noLook.own.backfillDone = true;
    further.afterPosts(noLook, { lookBack: false });
    assert.strictEqual(noLook.furtherStage, "done", "no look back (People off): done once the posts are in");
    assert.deepStrictEqual(further.progress({ history: { budget: 350, further: { from: 50, inbox: true } } }, { backfillRead: 170, furtherStage: "likes" }), { read: 120, of: 300, likes: true, inbox: true }, "how far it has got, for Your circle");
  }

  // The Inbox waits behind the progress page while it reads, as for a first read; and the run is sized to it.
  const { firstReadGoing } = require("../services/features");
  assert.deepStrictEqual([firstReadGoing({}, { lastRunAt: new Date(), resume: { budget: 50 } }), firstReadGoing({}, { lastRunAt: new Date() })], [true, false], "a resume read holds the Inbox until done");
  assert.strictEqual(runReadCap(100, 0, { resume: { budget: 350 } }), 450, "the run reads the resume's budget on top");
}

// More new posts than one run can read: 12 arrive (114..125), runs are capped
// at 1 page (5 posts). Each run must continue BELOW what the last one read,
// never re-read the top, and newestId only moves once the gap is closed.
all = all.concat(Array.from({ length: 12 }, (_, i) => ({ id: String(114 + i) })));
const reads = [];
const capped = (req) => {
  const page = fakeX(all)(req);
  reads.push(...page.posts.map((p) => p.id));
  return page;
};
run(state, capped, 1);
assert.deepStrictEqual(reads, ["125", "124", "123", "122", "121"], "run 1: the newest page");
assert.strictEqual(state.own.newestId, "113", "gap still open: newestId holds");
assert.deepStrictEqual([state.own.gapTop, state.own.gapUntil], ["125", "121"]);
run(state, capped, 1);
assert.deepStrictEqual(reads.slice(5), ["120", "119", "118", "117", "116"], "run 2 resumes below 121, no re-reads");
run(state, capped);
assert.deepStrictEqual(reads.slice(10), ["115", "114"], "run 3 closes the gap");
assert.strictEqual(state.own.newestId, "125", "newestId jumps to the top once the gap is closed");
assert.strictEqual(state.own.gapUntil, undefined);

// Every step says which way it reads, so the depth limit only ever applies to reading backwards.
const fresh = { own: {} };
assert.strictEqual(streamSteps(null, fresh, "own", "tweets").next().value.phase, "backfill", "a new stream starts by reading back");
assert.strictEqual(streamSteps(null, { own: { newestId: "5" } }, "own", "tweets").next().value.phase, "forward", "a synced stream reads forward first");
// The Inbox without People reads back only to its floor (since_id), and a stream that stopped there reopens once
// there's no floor (People turned on), going on below what it has.
{
  const st = { own: {} };
  const steps = streamSteps(null, st, "own", "tweets", { floorId: "100" });
  assert.strictEqual(steps.next().value.sinceId, "100", "the floor rides the backward read as since_id");
  assert.strictEqual(steps.next({ posts: [{ id: "300" }, { id: "200" }] }).done, true);
  assert.deepStrictEqual([st.own.backfillDone, st.own.floorReached, st.own.oldestId], [true, true, "200"]);
  assert.strictEqual(streamSteps(null, { own: { ...st.own } }, "own", "tweets", { floorId: "100" }).next().value.phase, "forward", "still the Inbox alone: it stays stopped");
  const reopened = streamSteps(null, { own: { ...st.own, newestId: undefined } }, "own", "tweets").next().value;
  assert.deepStrictEqual([reopened.phase, reopened.untilId, reopened.sinceId], ["backfill", "200", undefined], "People on: back on down from the oldest, no floor");
  assert.strictEqual(runReadCap(100, 3010, { backfillRead: 900, own: { backfillDone: true, floorReached: true }, mention: { backfillDone: true } }), 2210, "a floor-stopped stream with People's depth left: a full-speed pull");
  assert.strictEqual(runReadCap(100, 4000, { backfillRead: 900, own: { backfillDone: true, floorReached: true }, mention: { backfillDone: true, floorReached: true } }, { floorId: "100" }), 100, "at the floor, still the Inbox alone: top-ups only");
}

// The mentions check (sync.js checkMentions) reads FORWARD only: what's new, with the gap rules, and never the history
// still left to read (that's the sync's), saving the stream's state after each page.
(async () => {
  const mentions = Array.from({ length: 20 }, (_, i) => ({ id: String(200 + i) }));
  const st = { mention: { newestId: "207", oldestId: "205" } }; // history not done: a sync would read back next
  const asked = [];
  let saves = 0;
  await readForward(
    streamSteps(null, st, "mention", "mentions"),
    async (req) => {
      asked.push(req.phase);
      return fakeX(mentions)(req);
    },
    async () => saves++
  );
  assert.deepStrictEqual(asked, ["forward", "forward", "forward"], "12 new mentions, 3 pages of 5, nothing backwards");
  assert.strictEqual(st.mention.newestId, "219", "newestId moves to the newest read");
  assert.strictEqual(st.mention.oldestId, "205", "the history's place is untouched");
  assert.strictEqual(saves, 3, "state saved after every page");
  const quiet = [];
  await readForward(streamSteps(null, st, "mention", "mentions"), async (req) => (quiet.push(req.phase), fakeX(mentions)(req)), async () => {});
  assert.deepStrictEqual(quiet, ["forward"], "nothing new: one request");
  const never = [];
  await readForward(streamSteps(null, { mention: {} }, "mention", "mentions"), async (req) => (never.push(req), fakeX(mentions)(req)), async () => {});
  assert.deepStrictEqual(never, [], "a stream never read: nothing (its first read is the sync's)");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

// ── how far back ──
// Depth left → a backward page's size, or 0 = stop reading back.
assert.strictEqual(backfillPageSize(50, 1000), 50, "plenty left: the normal share");
assert.strictEqual(backfillPageSize(50, 30), 30, "near the end: only what's left");
assert.strictEqual(backfillPageSize(50, 4), 0, "under X's 5-post page minimum: stop");
assert.strictEqual(backfillPageSize(50, 0), 0, "reached: stop");
// The options fit the account: a heavy poster gets three, everything capped at X's limits (3,200 posts +
// 800 mentions: ~4,000 however much they've posted, even 100,000); a lighter one loses a tier that would reach no
// further than everything; unknown counts assume the most.
assert.deepStrictEqual(historyOptions(100000).map((o) => [o.key, o.budget]), [["1000", 1000], ["2500", 2500], ["all", 4000]]);
assert.deepStrictEqual(historyOptions(1500).map((o) => [o.key, o.budget]), [["1000", 1000], ["all", 2300]]);
assert.deepStrictEqual(historyOptions(150).map((o) => [o.key, o.budget]), [["all", 950]], "a light poster: just everything");
assert.deepStrictEqual(historyOptions(undefined).map((o) => o.budget), [1000, 2500, 4000]);
// "Everything" names its parts: a real post count, and mentions only as a ceiling.
assert.ok(historyOptions(2210).pop().detail.startsWith("Your 2,210 posts and up to 800 mentions · about "));
assert.ok(historyOptions(12000).pop().detail.startsWith("Your latest 3,200 posts (X's limit) and up to 800 mentions · about "));
const opts = historyOptions(12000);
assert.ok(opts[0].estimate < opts[1].estimate && opts[1].estimate < opts[2].estimate, "deeper costs more");
// With a pace (posts + replies to you a day): stretches of time, each capped at what X serves; the first that reaches
// it becomes "everything", and nothing longer is offered.
assert.deepStrictEqual(historyOptions(100000, { perDay: 20 }).map((o) => [o.key, o.budget]), [["day", 20], ["week", 140], ["month", 600]], "a quiet account: a day, a week, a month");
assert.deepStrictEqual(historyOptions(100000, { perDay: 348 }).map((o) => [o.key, o.budget]), [["day", 348], ["week", 2436], ["all", 4000]], "a busy one: its month reaches past X's 4,000, so it's everything X serves");
assert.deepStrictEqual(historyOptions(2433, { perDay: 600 }).map((o) => o.key), ["day", "all"], "a week already past X's limit: day, then everything");
assert.match(historyOptions(100000, { perDay: 348 })[2].label, /^1 month, as far as X serves$/);
// A run's post cap: while chosen history is unread, sized to finish it (so an interrupted pull resumes at full
// speed); once read (depth reached, or X has nothing older), the normal top-up cap.
assert.strictEqual(runReadCap(100, 3010, { backfillRead: 2741, own: {}, mention: { backfillDone: true } }), 369, "the rest of the pull + top-up room, not 100");
assert.strictEqual(runReadCap(100, 3010, { backfillRead: 3010, own: {}, mention: {} }), 100, "depth reached: top-ups only");
assert.strictEqual(runReadCap(100, 3010, { backfillRead: 900, own: { backfillDone: true }, mention: { backfillDone: true } }), 100, "X ran out first: top-ups only");

// A pull costs more than its posts alone (context + profiles); the app owner's own timeline is an Owned Read.
assert.ok(estimatePull(1000) > costOf({ post: 1000 }));
assert.ok(estimatePull(1000, { owned: true }) < estimatePull(1000), "owner: timeline posts at $0.001, not $0.005");

// ── what X charges (lib/pricing.js, docs.x.com pricing) ──
const { classOf, PRICE } = require("../lib/pricing");
assert.strictEqual(classOf("post", { endpoint: "tweets", userId: "1", ownerId: "1" }), "owned", "the owner's own timeline: Owned Read");
assert.strictEqual(classOf("user", { endpoint: "followers", userId: "1", ownerId: "1" }), "owned", "the owner's own followers: Owned Read");
assert.strictEqual(classOf("post", { endpoint: "tweets", userId: "2", ownerId: "1" }), "post", "anyone else's timeline: a post read");
assert.strictEqual(classOf("post", { endpoint: "tweets", userId: "1", ownerId: null }), "post", "no owner configured: standard prices");
assert.strictEqual(costOf({ owned: 1000 }), 1000 * PRICE.owned, "a Follows refresh of 1,000 for the owner ≈ $1.00, not $10.00");

// ── the usage ledger's pure rules (services/usage.js) ──
const { moveOf, describeReads } = require("../services/usage");
// X's real money (the balance clock's readings; never per unit): each reading stores its move since the
// one before, positive = spent, negative = a top-up; the first reading ever has none. A day's spend is the sum of its
// positive moves (the database's sum: usage.usageSummary).
assert.deepStrictEqual([moveOf(null, 80), moveOf({ usd: 80 }, 79.5), moveOf({ usd: 79.5 }, 179.5), moveOf({ usd: 0.3 }, 0.1)], [undefined, 0.5, -100, 0.2], "a reading's move: spent, a top-up, none for the first, no float dust");

// ── THE USAGE CHART (services/spendChart.js): fixed windows ending today, the buckets summed, the current one named ──
{
  const { spendChart, chartSince } = require("../services/spendChart");
  const c = spendChart([{ day: "2026-11-16", micros: 5e6 }, { day: "2026-11-15", micros: 2e6, estimated: true }, { day: "2026-11-10", micros: 1e6 }, { day: "2026-10-31", micros: 4e6 }, { day: "2026-11-17", micros: 9e6 }], "2026-11-16");
  const [day, week, month] = c.panels;
  assert.deepStrictEqual([day.bars.length, week.bars.length, month.bars.length], [30, 13, 12], "30 days, 13 weeks, 12 months");
  assert.deepStrictEqual([day.now.label, day.now.micros, day.span.micros], ["Today", 5e6, 12e6], "today, and the 30 days (Oct 31 in, tomorrow never)");
  assert.strictEqual(day.bars[29].h, 100, "the peak bar fills the plot");
  assert.ok(day.bars[28].estimated && day.bars[28].h === 40, "an estimate is marked, its height in proportion");
  assert.deepStrictEqual([week.now.label, week.now.micros, week.bars[12].label, week.bars[11].micros], ["This week", 5e6, "Week of Nov 16", 3e6], "weeks start on Monday (Nov 16, 2026 is one): the 10th and 15th share the week before");
  assert.deepStrictEqual([month.now.label, month.now.micros, month.bars[10].micros, month.bars[11].axis], ["November", 8e6, 4e6, "Nov"], "months: this one by name, October apart");
  assert.ok(day.bars[29].axis && !day.bars[28].axis && day.bars[24].axis, "the axis labels count from today");
  assert.strictEqual(chartSince("2026-11-16"), "2025-12-01", "the database is asked from the month view's oldest month");
  assert.ok(spendChart([], "2026-11-16").empty, "nothing spent: an empty chart (the page leaves it out)");
}
// What a run read, in words: each kind (price classes summed), in the order a run reads them, saying what X had
// already charged for earlier that day; nothing read → [] ("Nothing new").
assert.deepStrictEqual(
  describeReads({ "profiles:user": { returned: 3, billed: 3 }, "timeline:owned": { returned: 20, billed: 18 }, "timeline:post": { returned: 1, billed: 1 }, "follows:owned": { returned: 5, billed: 0 }, "self:user": { returned: 1, billed: 0 } }),
  [
    { text: "21 of your posts", note: "2 already paid" },
    { text: "your profile", note: "already paid" },
    { text: "3 people's profiles", note: null },
    { text: "5 accounts you follow", note: "already paid" },
  ]
);
assert.deepStrictEqual(describeReads({ "mentions:post": { returned: 1, billed: 1 }, "context:post": { returned: 1, billed: 1 } }).map((p) => p.text), ["1 mention of you", "1 post in your conversations"], "singular words for one");
assert.deepStrictEqual([describeReads({}), describeReads(undefined), describeReads({ "timeline:post": { returned: 0, billed: 0 } })], [[], [], []], "nothing read: no parts");
const { cost, rel } = require("express-handlebars").create(require("../lib/hbs")).helpers;
{
  const ago = (ms) => new Date(Date.now() - ms);
  const always = { hash: { always: true }, data: {} };
  assert.deepStrictEqual([rel(ago(5 * 3600e3), always), rel(ago(3 * 864e5), always), rel(ago(20 * 864e5), always), rel(ago(120 * 864e5), always), rel(ago(800 * 864e5), always)], ["5h", "3d", "2w", "4mo", "2y"], "always relative: hours, days, weeks, months, years");
  assert.ok(!/w|mo|y$/.test(rel(ago(20 * 864e5), { hash: {}, data: {} })), "without it, past a week it's a date (chat bubbles)");
}
assert.deepStrictEqual([cost(0, { hash: { dash: true } }), cost(undefined, { hash: { dash: true } }), cost(0, { hash: {} }), cost(0.0123, { hash: { dash: true } })], ["–", "–", "$0", "$0.012"], "a $0 table cell is a dash; elsewhere $0");

// ── cap split ──
// A 100 cap with both streams running must reach the second stream.
assert.strictEqual(pageShare(100, 2), 50, "default cap splits evenly");
assert.strictEqual(pageShare(50, 1), 50, "a lone stream gets the rest");
assert.strictEqual(pageShare(4000, 2), 100, "never above X's max page");
assert.strictEqual(pageShare(7, 2), 5, "never below X's min page");

// ── dates in the viewer's time zone ──
// The helpers read the zone off the render's root, so it reaches inside #each (and partials) with no argument.
// 03:00 UTC on Dec 31 is still Dec 30, 10pm in New York.
const { zoneFor, ZONES } = require("../lib/timezone");
assert.strictEqual(zoneFor("America/New_York"), "America/New_York");
assert.strictEqual(zoneFor("asia/kolkata"), zoneFor("Asia/Calcutta"), "an alias resolves to the one name the picker lists");
assert.ok(ZONES.includes(zoneFor("Asia/Kolkata")) && ZONES.includes("UTC"));
for (const bad of ["Nope/Zone", "+05:00", "", 5, undefined, "x".repeat(65)]) assert.strictEqual(zoneFor(bad), null, `refused: ${bad}`);
const { handlebars: Handlebars, helpers } = require("express-handlebars").create(require("../lib/hbs"));
// A partial called alone on an indented line must not indent its lines: a post's text keeps its line breaks, and
// `{{> thread}}` on its own line once indented every paragraph after the first (lib/hbs.js compilerOptions).
{
  const eh = require("express-handlebars").create(require("../lib/hbs"));
  eh.handlebars.registerPartial("indentProbe", "one\ntwo");
  const out = eh.handlebars.compile("<p>\n      {{> indentProbe}}\n</p>", eh.compilerOptions)({});
  assert.ok(!out.includes("\n      two"), `a standalone partial's lines aren't indented (${JSON.stringify(out)})`);
}
const datesTpl = Handlebars.compile("{{#each at}}{{shortDate this}}{{/each}}");
const dates = (ctx) => datesTpl(ctx, { helpers }); // as express-handlebars renders: helpers per render
const lateNight = [new Date(Date.UTC(2025, 11, 31, 3))];
assert.match(dates({ at: lateNight, timeZone: "America/New_York" }), /^Dec 30, 2025$/u);
assert.match(dates({ at: lateNight }), /^Dec 31, 2025$/u, "no zone (an offline render): UTC");

// ── Live (services/liveRules.js): what an account subscribes to, how X is made to match, like events into Likes ──
{
  const { EVENTS, desiredSubs, diffSubs, likeOpFor, repostOpFor } = require("../services/liveRules");
  const { eventContents } = require("../lib/x");
  const POSTS = ["post.reply.create", "post.mention.create", "post.quote.create", "post.create"];
  const LIKES = ["like.create", "post.repost.create"]; // the Likes module: likes AND plain reposts of your posts
  // Post events come with the Inbox (Replies, live has no switch of its own: services/features.js), like events with
  // Likes (granted), follow events with Follows.
  const base = { _id: "1", features: { inbox: { on: true } }, tokens: { scope: "tweet.read users.read offline.access" } };
  const likes = { ...base, tokens: { scope: `${base.tokens.scope} like.read` }, features: { ...base.features, likes: { on: true } } };
  assert.deepStrictEqual(desiredSubs(base), POSTS, "the Inbox: replies, mentions, quotes, its own posts, pushed");
  assert.deepStrictEqual(desiredSubs({ ...likes, features: { likes: { on: true } } }), LIKES, "no Inbox: no reply / mention / quote / own-post events");
  assert.deepStrictEqual(desiredSubs(likes), [...POSTS, ...LIKES], "likes and reposts only with Likes on AND granted");
  assert.deepStrictEqual(desiredSubs({ ...likes, features: { ...base.features, likes: { on: false } } }), POSTS, "granted but off: no likes");
  assert.deepStrictEqual(desiredSubs({ ...base, features: { ...base.features, likes: { on: true } } }), POSTS, "on but not granted: no likes");
  assert.deepStrictEqual(desiredSubs({ ...likes, features: { likes: { on: true } } }), LIKES, "the Likes module alone: like and repost events alone");
  const followsOnly = { _id: "1", features: { follows: { on: true } }, tokens: { scope: "tweet.read users.read follows.read" } };
  assert.deepStrictEqual(desiredSubs(followsOnly), ["follow.follow", "follow.unfollow"], "the Follows module alone: follow events alone");
  for (const [why, a] of [["no module picked", { ...likes, features: {} }], ["X refused its token", { ...likes, needsReauth: true }]]) {
    assert.deepStrictEqual(desiredSubs(a), [], `nothing when ${why}`);
  }
  assert.deepStrictEqual(desiredSubs(likes, { paused: true }), [], "nothing while the gate refuses it");
  // X has two post.create (one extra) and a like.create no longer wanted: keep one, create the missing type, remove two.
  const have = [{ event_type: "post.create", subscription_id: "a" }, { event_type: "post.create", subscription_id: "b" }, { event_type: "like.create", subscription_id: "c" }];
  const d = diffSubs(have, ["post.create", "post.reply.create"]);
  assert.deepStrictEqual([d.keep.map((s) => s.subscription_id), d.create, d.remove.map((s) => s.subscription_id)], [["a"], ["post.reply.create"], ["b", "c"]]);
  // FOLLOWS OF YOU ONLY: a follow subscription without the inbound filter is made again with it, once; one made with
  // it is kept, whether X's list says the direction or only our record does.
  {
    const F = ["follow.follow"];
    const old = diffSubs([{ subscription_id: "f1", event_type: "follow.follow", filter: { user_id: "1" } }], F, [{ id: "f1" }]);
    const listed = diffSubs([{ subscription_id: "f2", event_type: "follow.follow", filter: { user_id: "1", direction: "inbound" } }], F);
    const recorded = diffSubs([{ subscription_id: "f3", event_type: "follow.follow", filter: { user_id: "1" } }], F, [{ id: "f3", direction: "inbound" }]);
    assert.deepStrictEqual([old.remove.length, old.create, listed.keep.length, recorded.keep.length], [1, F, 1, 1], "follows: inbound only, migrated once, never churned");
    assert.strictEqual(EVENTS.filter((e) => e.direction).map((e) => `${e.type}:${e.direction}`).join(","), "follow.follow:inbound,follow.unfollow:inbound", "only follow events are filtered; likes keep both ways (your own likes on X keep the ♥ right)");
  }
  // A like event: the account's own like, a like on its post, or neither (stored as the likes pass / likers check do).
  const mine = likeOpFor({ liking_user_id: "1", liked_tweet_id: "p9", liked_tweet_author_id: "7" }, "1").updateOne;
  assert.deepStrictEqual([mine.filter, mine.update.$setOnInsert.authorId, "fromApp" in mine.update.$unset], [{ accountId: "1", postId: "p9", likerId: "1" }, "7", true], "your like clears fromApp, like the likes pass");
  const theirs = likeOpFor({ liking_user_id: "7", liked_tweet_id: "p1", liked_tweet_author_id: "1" }, "1").updateOne;
  assert.deepStrictEqual([theirs.filter, theirs.update.$setOnInsert.authorId], [{ accountId: "1", postId: "p1", likerId: "7" }, "1"], "a like on your post: who liked it");
  assert.strictEqual(likeOpFor({ liking_user_id: "7", liked_tweet_id: "p2", liked_tweet_author_id: "8" }, "1"), null);
  // A repost event (its payload taken to be the repost, the original in includes: INFERRED until one arrives): someone
  // reposting your post is a Repost for you; your own repost, or theirs of someone else's post, isn't.
  const rp = (author, of, ofAuthor) => ({ payload: { id: "r1", author_id: author, created_at: "2026-11-18T19:00:00.000Z", referenced_tweets: [{ type: "retweeted", id: of }] }, includes: { tweets: [{ id: of, author_id: ofAuthor }] } });
  const reposted = repostOpFor(rp("7", "p1", "1"), "1").updateOne;
  assert.deepStrictEqual([reposted.filter, reposted.update.$setOnInsert.authorId, reposted.update.$set.repostedAt.toISOString()], [{ accountId: "1", postId: "p1", reposterId: "7" }, "1", "2026-11-18T19:00:00.000Z"], "a repost of your post: who and when");
  assert.strictEqual(repostOpFor(rp("1", "p1", "1"), "1"), null, "your own repost isn't one of yours being reposted");
  assert.strictEqual(repostOpFor(rp("7", "p2", "8"), "1"), null, "a repost of someone else's post");
  assert.strictEqual(repostOpFor({ payload: { id: "r2", author_id: "7" } }, "1"), null, "no retweeted reference: unreadable, not stored");
  // Every event type has its words on the ledger and a price class.
  const { describeReads } = require("../services/usage");
  const { PRICE } = require("../lib/pricing");
  for (const e of EVENTS) {
    assert.ok(e.cls in PRICE, `${e.type}: a price class`);
    // Its own words (READ_WORDS), not the fallback "2 live-likes", and no ", live": the row's title ("Live") says it.
    const words = describeReads({ [`${e.what}:${e.cls}`]: { returned: 2, billed: 2 } })[0].text;
    assert.ok(/^2 [a-z]/.test(words) && words !== `2 ${e.what}` && !/live/.test(words), `${e.type}: ledger words ("${words}")`);
  }
  // What an event brings, in the stores' shapes: a reply event's post first (with its media), then what it replies to.
  const ev = eventContents({
    payload: { id: "50", author_id: "7", text: "hi", attachments: { media_keys: ["m1"] } },
    includes: { tweets: [{ id: "49", author_id: "1" }, { id: "50", author_id: "7" }], users: [{ id: "7" }], media: [{ media_key: "m1", type: "photo" }] },
  });
  assert.deepStrictEqual([ev.posts.map((p) => p.id), ev.posts[0].media.length, ev.users.length], [["50", "49"], 1, 1]);
  const like = eventContents({ payload: { id: "e1", liking_user_id: "7", liked_tweet_id: "49" }, includes: { tweets: [{ id: "49", author_id: "1" }] } });
  assert.deepStrictEqual(like.posts.map((p) => p.id), ["49"], "a like event's payload isn't a post; the liked post is");
}

// ── X's hiccups ──
// A 503 (what killed the first real pull) is retried; one that persists comes back marked transient, so the
// sync stops cleanly with progress saved. A 4xx is never retried. (fetch is swapped for a scripted fake.)
(async () => {
  // extras.goneCheck (a like or reply X refused on a post deleted since) asks X about the post only on a refusal with a
  // reason (never X's limit or X failing), and marks nothing when X still serves it (the database write is only on the
  // "X won't serve it" path, not reached here).
  {
    const { goneCheck } = require("../services/extras");
    let asked = 0;
    const xServes = { postsByIds: async () => (asked++, { posts: [{ id: "9" }], missing: [] }) };
    const results = [await goneCheck(xServes, "9", { status: 429 }), await goneCheck(xServes, "9", { status: 503 }), await goneCheck(xServes, "9", { status: 403, paced: true }), await goneCheck(xServes, "9", { status: 403 })];
    assert.deepStrictEqual([results, asked], [[false, false, false, false], 1], "only a reasoned refusal asks X, and a post X still serves isn't gone");
  }
  // WHAT PEOPLE WRITE IS TEXT, never markup: a reply you send and a post
  // someone sends you render escaped through THE bubble (views/reply-bubble.hbs, what POST /posts/:id/reply returns),
  // and an address from X becomes a link only when it's http(s) (services/text.js webHref).
  {
    const path = require("path");
    const { webHref } = require("../services/text");
    const people = require("../services/people");
    const eh = require("express-handlebars").create(require("../lib/hbs"));
    const viewsDir = path.join(__dirname, "..", "views");
    const bubble = async (post) => (await eh.render(path.join(viewsDir, "reply-bubble.hbs"), { ...people.postView(post, { meId: "1", profiles: new Map() }), side: "me", runStart: true, settings: { views: viewsDir } })).replace(/\s+/g, " ");
    const base = { createdAt: new Date(), conversationId: "100", referenced: [], mentions: [] };
    const mine = await bubble({ ...base, _id: "100", authorId: "1", text: `<img src=x onerror=alert(1)> & <script>alert(2)</script>` });
    assert.ok(!/<img src=x|<script>/i.test(mine) && mine.includes("&lt;script&gt;alert(2)&lt;/script&gt;"), "a reply's text renders escaped");
    const theirs = await bubble({ ...base, _id: "101", authorId: "2", text: "see https://t.co/a and https://t.co/b", urls: [{ url: "https://t.co/a", expanded: "javascript:alert(4)", display: "evil.example" }, { url: "https://t.co/b", expanded: "https://ok.example/x", display: "ok.example/x" }] });
    assert.ok(!/href="javascript:/i.test(theirs) && theirs.includes('href="https://ok.example/x"'), "a javascript: link is text, an https one a link");
    // A DRAFT an agent wrote (models/Draft.js) is text too: its words in the line and in the box, and its On X link.
    {
      const evil = `"><img src=x onerror=alert(5)> <script>alert(6)</script>`;
      const view = { ...people.postView({ ...base, _id: "102", authorId: "2", text: "hi" }, { meId: "1", profiles: new Map() }), draft: require("../services/inbox").draftOf("102", { text: evil, by: "<b>agent</b>" }) };
      const reply = { linkPrice: 0.2, pictures: "" };
      const html = (await eh.render(path.join(viewsDir, "reply-bubble.hbs"), { ...view, side: "them", runStart: true, reply, settings: { views: viewsDir } })).replace(/\s+/g, " ");
      assert.ok(html.includes('class="msg-draft"') && !/<img src=x|<script>|<b>agent/i.test(html), "a draft's words and its agent's name render escaped");
      assert.ok(html.includes("&lt;script&gt;alert(6)&lt;/script&gt;</textarea>") && html.includes('href="https://x.com/intent/post?in_reply_to&#x3D;102&amp;text&#x3D;%22%3E%3Cimg'), "the draft fills the box as text, and its On X link carries it encoded");
    }
    assert.deepStrictEqual(["https://a.b", "HTTP://a.b", " javascript:x", "data:text/html,x", "//a.b", "", null].map(webHref), ["https://a.b", "HTTP://a.b", null, null, null, null, null]);
    // THE POST FOOT (partials/post-foot.hbs): ♥ · ↻ · Reply · On X. The ♥ and ↻ write from here; Reply opens the composer
    // with Replying, else X's reply window in a small window; On X is the post's own page (data-on-x), its ONE way to X:
    // THE CORNER holds only Mark done, no arrow. The seed (partials/topic-post.hbs) has the same foot.
    const theirPost = people.postView({ ...base, _id: "102", authorId: "2", text: "hi" }, { meId: "1", profiles: new Map(), canLike: true, canRepost: true });
    const view = (more) => eh.render(path.join(viewsDir, "reply-bubble.hbs"), { ...theirPost, side: "them", runStart: true, replyTo: "Maya", ...more, settings: { views: viewsDir } });
    const replying = await view({ reply: { linkPrice: 0.2 }, doneIn: "100" });
    const noReplying = await view({});
    const onX = /<a class="reply-to on-x" href="https:\/\/x\.com\/i\/status\/102"[^>]*data-on-x>/;
    assert.ok(/<form class="like-form"[^>]*action="\/posts\/102\/like"/.test(replying) && /action="\/posts\/102\/repost"/.test(replying) && replying.includes('<dialog class="reply-here"') && !/in_reply_to=102"[^>]*data-on-x/.test(replying), "with Replying: the ♥ and ↻ write from here, Reply opens the composer");
    assert.ok(!noReplying.includes("reply-here") && /href="https:\/\/x\.com\/intent\/post\?in_reply_to=102"[^>]*data-on-x/.test(noReplying), "without Replying: Reply is X's reply window, in a small window");
    assert.ok(onX.test(replying) && onX.test(noReplying) && !replying.includes("post-exit") && /<div class="post-corner">[^]*?Mark done<\/button><\/form><\/div>/.test(replying), "On X in the foot, no arrow in the corner: Mark done alone there");
    assert.ok(!(await view({ doneIn: null, finished: false })).includes("post-corner"), "nothing to do here: no corner at all");
    const yours = await eh.render(path.join(viewsDir, "reply-bubble.hbs"), { ...people.postView({ ...base, _id: "103", authorId: "1", text: "mine" }, { meId: "1", profiles: new Map() }), side: "me", runStart: true, reply: { linkPrice: 0.2 }, settings: { views: viewsDir } });
    assert.ok(/href="https:\/\/x\.com\/i\/status\/103"[^>]*data-on-x/.test(yours) && yours.includes(">Reply<") && yours.includes('action="/posts/103/reply"') && yours.includes('placeholder="Reply to yourself"') && !/action="\/posts\/103\/(like|repost)"/.test(yours), "your own post: Reply (a follow-up to yourself) and On X; no ♥ or ↻ of your own");
    // THE LIKE LINE's faces (partials/liked.hbs): each its own link, their People page when they have one, else X, never
    // inside the ♥ button (a link can't sit in a button); the ♥ alone presses.
    {
      const liked = people.postView({ ...base, _id: "104", authorId: "2", text: "hi" }, { meId: "1", profiles: new Map([["3", { username: "maya" }], ["4", { username: "dev" }]]), likers: new Map([["104", ["3", "4"]]]), canLike: true, known: new Set(["3"]) });
      const line = (await eh.render(path.join(viewsDir, "likes-line.hbs"), { ...liked, settings: { views: viewsDir } })).replace(/\s+/g, " ");
      assert.ok(/<span class="like-line liked">/.test(line) && /<a class="who-av" href="\/people\/3"/.test(line) && /<a class="who-av" href="https:\/\/x\.com\/dev"/.test(line), "the like line's faces: their People page, else X");
      assert.ok(!/<button[^>]*>(?:(?!<\/button>).)*<a /.test(line) && /<button type="submit" class="like-btn"[^>]*aria-label="Like on X">/.test(line), "no face inside the ♥ button; the ♥ alone likes");
      const theirsOnly = (await eh.render(path.join(viewsDir, "likes-line.hbs"), { ...people.postView({ ...base, _id: "105", authorId: "1", text: "mine" }, { meId: "1", profiles: new Map([["3", { username: "maya" }]]), likers: new Map([["105", ["3"]]]), known: new Set(["3"]) }), settings: { views: viewsDir } })).replace(/\s+/g, " ");
      assert.ok(/<div class="liked">.*<a class="who-av" href="\/people\/3"/.test(theirsOnly), "under your own post: the pill, its faces links too");
    }
    {
      const partials = await eh.getPartials();
      const seed = eh.handlebars.compile("{{> topic-post}}", eh.compilerOptions)({ ...theirPost, replyTo: "Maya" }, { partials, helpers: eh.helpers });
      assert.ok(onX.test(seed) && !seed.includes("post-exit") && !seed.includes("post-corner"), "the seed: On X in its foot, no corner without the card's presses");
    }
    // THE START PAGE's wizard (views/start.hbs, routes/pages.js startView): step 1 is the amounts as top-up links, each
    // with the history it buys; step 2 the options in Get started's form. A field named like a helper (`usd`, `add`)
    // once drew "$" with no number: the amount must be in the tile.
    {
      const start = (step, more = {}) => eh.render(path.join(viewsDir, "start.hbs"), { settings: { views: viewsDir }, brandName: "xtoolio", csrfToken: "t", priced: true, funds: { balance: step === "money" ? 0 : 20, payable: true }, options: [{ key: "all", label: "Everything X serves", price: 10.2, affordable: true, selected: true, detail: "Your 2 posts" }], start: { steps: true, step, handle: "maya", ready: true, amounts: [{ whole: 20, covers: "1 week" }, { whole: 100, covers: "everything X serves" }] }, ...more });
      const money = (await start("money")).replace(/\s+/g, " ");
      assert.ok(/<a class="amount" href="\/billing\/topup\?amount=20&amp;back=\/"><b>\$20<\/b><span>History: <i>1 week<\/i><\/span><\/a>/.test(money) && money.includes("<b>$100</b>") && !money.includes("start-form"), "step 1: each amount a top-up link with what it buys, no Get started yet");
      const hist = (await start("history")).replace(/\s+/g, " ");
      assert.ok(hist.includes('form="start-form"') && /<button type="submit" class="signin">Get started<\/button>/.test(hist) && !hist.includes('class="amount"') && hist.includes("Balance $20.00"), "step 2: the options in Get started's form, the balance as step 1 done");
      assert.ok(money.includes("Welcome to xtoolio") && money.includes("homescreen-tip"), "the welcome, and the Home Screen tip (CSS shows it on a phone)");
    }
    // QUOTE (the ↻'s menu): X's API quotes are Enterprise only, so it's X's own compose window on the post's link,
    // never a form here.
    const quote = /<a class="repost-item" href="https:\/\/x\.com\/intent\/post\?url=https%3A%2F%2Fx\.com%2F[^"]*%2Fstatus%2F102"[^>]*data-on-x>/;
    assert.ok(quote.test(replying) && !/action="\/posts\/102\/quote"/.test(replying), "Quote opens X's compose window on the post");

    // THE VIEWER (partials/lightbox.hbs): what a press on each kind of picture opens, big; every post picture is the
    // button that opens it.
    const pics = people.postView({ ...base, _id: "120", authorId: "2", text: "pics", media: [
      { key: "3_1", type: "photo", url: "https://pbs.twimg.com/media/AbC.jpg" },
      { key: "16_2", type: "animated_gif", url: "https://pbs.twimg.com/tweet_video_thumb/GiF.jpg" },
      { key: "7_3", type: "video", url: "https://pbs.twimg.com/ext_tw_video_thumb/9/pu/img/ViD.jpg", durationMs: 131000 },
    ] }, { meId: "1", profiles: new Map() }).media.map((x) => x.view);
    assert.deepStrictEqual(pics, [
      { src: "https://pbs.twimg.com/media/AbC.jpg?name=orig", kind: "photo" },
      { src: "https://video.twimg.com/tweet_video/GiF.mp4", kind: "gif" },
      { src: "https://pbs.twimg.com/ext_tw_video_thumb/9/pu/img/ViD.jpg?name=large", kind: "video" },
    ], "a photo opens at its original size, a GIF as its MP4, a video as its large frame");
    const picHtml = (await eh.render(path.join(viewsDir, "reply-bubble.hbs"), { ...people.postView({ ...base, _id: "120", authorId: "2", text: "pics", media: [{ key: "3_1", type: "photo", url: "https://pbs.twimg.com/media/AbC.jpg" }] }, { meId: "1", profiles: new Map() }), side: "them", runStart: true, settings: { views: viewsDir } })).replace(/\s+/g, " ");
    assert.ok(picHtml.includes('<button type="button" class="pm-open" data-view="https://pbs.twimg.com/media/AbC.jpg?name&#x3D;orig" data-view-kind="photo" data-post="120" aria-label="View picture larger">'), "a post's picture is the button that opens the viewer");

    // "REPLYING TO" (people.addressees / replyingView): whom X tags in your reply, its author then everyone the post
    // mentions anywhere, in order, never you, each once (checked on real replies sent through xtoolio).
    const m = (id, username, start) => ({ id, username, start, end: start + username.length + 1 });
    const mayas = { ...base, _id: "110", authorId: "20", text: "@dev @me I followed Dev", mentions: [m("1", "me", 5), m("30", "dev", 0)] };
    assert.deepStrictEqual(people.addressees(mayas, "1", "maya"), ["maya", "dev"], "a reply to Maya's answer to Dev goes to Maya and Dev, never you");
    const named = { ...base, _id: "111", authorId: "20", text: "thanks @a @b @Maya @c", mentions: [m("21", "a", 7), m("22", "b", 10), m("20", "Maya", 13), m("23", "c", 19)] };
    assert.deepStrictEqual(people.addressees(named, "1", "maya"), ["maya", "a", "b", "c"], "handles typed later count too, in order; the author once, whatever the case");
    assert.deepStrictEqual(people.replyingView(["a", "b", "c"]), { shown: ["@a", "@b", "@c"], more: 0, all: "@a @b @c" }, "three are named");
    assert.deepStrictEqual(people.replyingView(["a", "b", "c", "d", "e"]).shown.concat(people.replyingView(["a", "b", "c", "d", "e"]).more), ["@a", "@b", 3], "more than three: two and how many more");
    assert.strictEqual(people.replyingView([]), null, "nobody to tag (an author with no known handle): no line");
    const box = async (post) => (await eh.render(path.join(viewsDir, "reply-bubble.hbs"), { ...people.postView(post, { meId: "1", profiles: new Map(), names: new Map([["20", "maya"]]) }), side: "them", runStart: true, reply: { linkPrice: 0.2 }, settings: { views: viewsDir } })).replace(/\s+/g, " ");
    assert.ok((await box(mayas)).includes('<p class="replying-to" data-reply-to-line>Replying to <b>@maya</b> <b>@dev</b></p>'), "the box says whom, X's way");
    const many = await box({ ...named, mentions: [...named.mentions, m("24", "d", 30), m("25", "e<script>", 33)] });
    assert.ok(many.includes("Replying to <b>@maya</b> <b>@a</b> and <b") && many.includes(">4 others</b>") && many.includes('data-tip="@maya @a @b @c @d @e&lt;script&gt;"') && !many.includes("<script>"), "past three: two, then 'N others' with all of them in the tooltip, escaped");
  }
  const realFetch = global.fetch;
  const script = (statuses) => {
    let i = 0;
    global.fetch = async () => {
      const status = statuses[Math.min(i++, statuses.length - 1)];
      return { ok: status < 400, status, json: async () => (status < 400 ? { data: [{ id: "1" }] } : { title: "Service Unavailable" }), headers: { get: () => null } };
    };
    return () => i;
  };
  // Every read records into a meter (services/usage.js); here one that just remembers what it was told.
  const recorded = [];
  const meter = { record: async (what, cls, type, ids) => recorded.push([what, cls, type, ids.length]) };
  const client = () => createClient({ token: "t", meter, readCap: 100, contextCap: 100, userCap: 10, retryWaitsMs: [0, 0, 0] });
  try {
    // No meter, no client: nothing can read from X unrecorded.
    assert.throws(() => createClient({ token: "t", readCap: 1, userCap: 1 }), /needs a meter/);
    let calls = script([503, 503, 200]);
    assert.deepStrictEqual((await client().postsByIds(["1"])).posts, [{ id: "1" }], "two 503s, then the read succeeds");
    assert.strictEqual(calls(), 3);

    calls = script([503]);
    await assert.rejects(client().postsByIds(["1"]), (e) => e.transient === true && e.status === 503, "a 503 that persists is transient");
    assert.strictEqual(calls(), 4, "tried once + 3 retries");

    calls = script([400]);
    await assert.rejects(client().postsByIds(["1"]), (e) => !e.transient && e.status === 400);
    assert.strictEqual(calls(), 1, "a client error is not retried");
    // Context and timeline reads draw on separate ceilings; usage.posts is their billed sum.
    script([200]);
    const c = createClient({ token: "t", meter, ownerId: "me", readCap: 5, contextCap: 1, userCap: 1, retryWaitsMs: [] });
    recorded.length = 0;
    await c.postsByIds(["1"]);
    assert.strictEqual(c.remainingPosts(), 5, "a context read doesn't spend the timeline cap");
    await assert.rejects(c.postsByIds(["2"]), /context cap of 1/, "the context cap is its own ceiling");
    await c.timelinePage("me", "tweets");
    assert.deepStrictEqual([c.usage.timelinePosts, c.usage.contextPosts, c.usage.posts], [1, 1, 2]);
    // Each response is recorded as it arrives, with its price class: the owner's own timeline is an Owned Read,
    // a post read by id (context) is not, and a read refused by the cap records nothing.
    assert.deepStrictEqual(recorded, [["context", "post", "post", 1], ["timeline", "owned", "post", 1]]);
    recorded.length = 0;
    await createClient({ token: "t", meter, ownerId: "me", readCap: 5, userCap: 0, retryWaitsMs: [] }).timelinePage("someone-else", "tweets");
    assert.deepStrictEqual(recorded, [["timeline", "post", "post", 1]], "someone else's timeline: a post read");
    // Media arrives once per response (includes.media); each post gets its own, by key. Media isn't a post:
    // it doesn't count against the cap.
    let asked;
    global.fetch = async (url) => {
      asked = new URL(url);
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({
        data: [{ id: "1", attachments: { media_keys: ["k2"] } }, { id: "2" }],
        includes: { media: [{ media_key: "k1", type: "photo" }, { media_key: "k2", type: "video" }] },
      }) };
    };
    const mc = createClient({ token: "t", meter, readCap: 10, contextCap: 10, userCap: 0, retryWaitsMs: [] });
    const got = await mc.postsByIds(["1", "2"]);
    assert.strictEqual(asked.searchParams.get("expansions"), "attachments.media_keys");
    assert.deepStrictEqual(got.posts.map((p) => (p.media || []).map((m) => m.media_key)), [["k2"], []]);
    assert.strictEqual(mc.usage.posts, 2);

    // Quotes of a post: only someone else's real quote comes back, marked with whose post it quotes; a repost of a
    // quote and the author quoting themselves are billed (recorded) but not kept (a one-off backfill once stored both).
    global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({
      data: [{ id: "q1", author_id: "them" }, { id: "q2", author_id: "me" }, { id: "q3", author_id: "x", referenced_tweets: [{ type: "retweeted", id: "q2" }] }],
    }) });
    recorded.length = 0;
    const quotes = await createClient({ token: "t", meter, readCap: 100, userCap: 0, retryWaitsMs: [] }).quotesOf("post1", "me");
    assert.deepStrictEqual([quotes.map((q) => [q.id, q.quoted_author_id]), recorded], [[["q1", "me"]], [["quotes", "post", "post", 3]]]);

    // Rate limits are paced by X's own headers: once an endpoint's window is down to the reserve, the next request
    // isn't sent (a clean 429-shaped stop with the reset time), and other endpoints are unaffected.
    const { endpointOf, RATE_RESERVE } = require("../lib/x");
    assert.strictEqual(endpointOf("/tweets/1000000000000000777/liking_users"), "/tweets/:id/liking_users");
    assert.strictEqual(endpointOf("/users/12345/tweets"), "/users/:id/tweets");
    // THE FIRST-READ QUEUE (services/pullQueue.js): first come first served by when each asked; where one stands and
    // about when it's ready (slots at a time, each about the median of recent reads; a free slot starts it now); a stale
    // or missing queue says nothing.
    const pq = require("../services/pullQueue");
    const tNow = Date.UTC(2026, 10, 17, 12);
    const askedWhen = { a: 3, b: 1, c: 2 };
    assert.deepStrictEqual([{ _id: "a" }, { _id: "b" }, { _id: "c" }].sort(pq.byAsked((x) => askedWhen[x._id])).map((x) => x._id), ["b", "c", "a"], "the line: whoever asked first");
    const q = (extra) => ({ waiting: ["w1", "w2", "w3", "w4", "w5", "w6"], running: ["r1", "r2"], slots: 2, durations: [60e3, 120e3, 180e3], at: new Date(tNow - 5e3), ...extra });
    assert.deepStrictEqual([pq.standing(q(), "w1", tNow), pq.standing(q(), "w4", tNow)], [{ place: 1, ahead: 0, readyMs: 60e3 + 120e3 }, { place: 4, ahead: 3, readyMs: 1.5 * 120e3 + 120e3 }], "slots full: the rounds ahead (the first half done), then its own read");
    assert.deepStrictEqual(pq.standing(q({ running: [] }), "w2", tNow), { place: 2, ahead: 1, readyMs: 120e3 }, "a slot free: it starts now");
    assert.deepStrictEqual([pq.standing(q({ durations: [] }), "w1", tNow).readyMs, pq.standing(q(), "nobody", tNow), pq.standing(q({ at: new Date(tNow - pq.STALE_MS - 1) }), "w1", tNow)], [null, null, null], "no durations: no estimate; not in line or a stale queue: nothing");
    assert.deepStrictEqual(pq.keepDuration([...Array(pq.KEEP_DURATIONS)].map((_, i) => i), 999).slice(-2), [pq.KEEP_DURATIONS - 1, 999], "the last durations, newest last");
    // The pool itself: one slot busy, then a pass's account and three first reads queue: the first reads go in the
    // order they came (not newest first), all before the pass; `waiting` lists them in that order.
    const pool = pq.createPool(1);
    const order = [];
    let open;
    const blocker = pool.run(() => new Promise((r) => (open = r)));
    const queued = [pool.run(async () => order.push("pass")), ...["f1", "f2", "f3"].map((id) => pool.run(async () => order.push(id), { first: true, id }))];
    assert.deepStrictEqual(pool.waiting(), ["f1", "f2", "f3"], "the line, in the order they came");
    await new Promise((r) => setImmediate(r)); // the busy run starts a tick after its turn
    open();
    await blocker;
    await Promise.all(queued);
    assert.deepStrictEqual([order, pool.idle()], [["f1", "f2", "f3", "pass"], true], "first reads first come first served, ahead of the pass");
    const ord = require("../lib/hbs").helpers.ordinal;
    assert.deepStrictEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111, 1000].map(ord), ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "101st", "111th", "1,000th"], "ordinals");
    // THE COUNTDOWN's rules (lib/writeLimits.js): a window shows until it resets when it's spent, or for a bulk one
    // (likes, follows, unfollows) as soon as any is used; what the account keeps becomes the header's list, the ended,
    // unknown and old-shape ones left out, soonest first; and its format.
    const wl = require("../lib/writeLimits");
    const now0 = Date.UTC(2026, 10, 17, 12, 0, 0);
    assert.deepStrictEqual([wl.RESERVE, require("../lib/x").reserveFor("GET")], [0, RATE_RESERVE], "a write keeps no reserve (50 means 50); a read keeps its own");
    const W = wl.WRITE_LIMITS, soon = now0 + 1;
    assert.deepStrictEqual(
      [wl.shows(W.like, { remaining: 4, reset: soon }, now0), wl.shows(W.like, { remaining: 50, reset: soon }, now0), wl.shows(W.like, { remaining: 4, reset: now0 }, now0),
        wl.shows(W.reply, { remaining: 99, reset: soon }, now0), wl.shows(W.reply, { remaining: 0, reset: soon }, now0), wl.shows(undefined, { remaining: 0, reset: soon }, now0)],
      [true, false, false, false, true, false],
      "a bulk window shows once used, a full one doesn't; any shows once spent; none after its reset; unknown never");
    const kept = new Map([[W.follow.window, { left: 0, ends: new Date(now0 + 90e3) }], [W.like.window, { left: 4, ends: new Date(now0 + 30e3) }], [W.reply.window, { left: 0, ends: new Date(now0 - 1) }], [W.unfollow.window, new Date(now0 + 60e3)], ["GET /somewhere", { left: 0, ends: new Date(now0 + 60e3) }]]);
    assert.deepStrictEqual(wl.limitsFrom(kept, now0).map((l) => [l.key, l.words, l.left, l.max]), [["like", "Likes", 4, 50], ["follow", "Follows", 0, 50]], "soonest first, with what's left of X's window; ended, unknown and old-shape (a bare Date) left out");
    assert.deepStrictEqual(wl.limitsFrom(Object.fromEntries(kept), now0).length, 2, "a lean account's plain object reads the same");
    // The header draws it (a field named `clock` once, like a helper, rendered the helper and threw on every page
    // while a window was open; nothing drew the partial with an entry).
    {
      const partial = (name) => require("fs").readFileSync(require("path").join(__dirname, "..", "views", "partials", `${name}.hbs`), "utf8");
      Handlebars.registerPartial("icon-timer", partial("icon-timer"));
      const tpl = Handlebars.compile(partial("limits"));
      const drawn = tpl({ limitsSpent: true, limits: [{ words: "Likes", left: 4, max: 50, ends: now0 + 754e3, resetIn: "12:34" }, { words: "Follows", left: 0, max: 50, ends: now0 + 9e5, resetIn: "15:00" }] }, { helpers });
      assert.ok(drawn.includes("Likes <b>4</b>/50 · resets in <b data-clock>12:34</b>") && /class="limit spent"[^>]*>Follows <b>0<\/b>/.test(drawn) && drawn.includes('class="limits spent"'), `the header's countdown draws, folded, its stopwatch amber while one is spent (${drawn})`);
    }
    assert.deepStrictEqual([wl.countdown(now0 + 754e3, now0), wl.countdown(now0 + 3723e3, now0), wl.countdown(now0 - 5, now0), wl.countdown(now0 + 1, now0)], ["12:34", "1:02:03", "0:00", "0:01"], "the countdown's format");
    const { windowKey } = require("../lib/x");
    assert.deepStrictEqual([windowKey("GET", "/users/1/following"), windowKey("POST", "/users/1/following")], ["/users/:id/following", "POST /users/:id/following"], "reading who you follow and following someone spend different windows");
    let sent = 0;
    const resetAt = Math.floor(Date.now() / 1000) + 600;
    global.fetch = async (url) => {
      sent++;
      const left = new URL(url).pathname.includes("liking_users") ? RATE_RESERVE : 50;
      return { ok: true, status: 200, json: async () => ({ data: [] }), headers: { get: (h) => (h === "x-rate-limit-remaining" ? String(left) : h === "x-rate-limit-reset" ? String(resetAt) : null) } };
    };
    const rc = createClient({ token: "t", meter, readCap: 100, userCap: 100, retryWaitsMs: [] });
    await rc.likingUsers("111");
    await assert.rejects(rc.likingUsers("222"), (e) => e.status === 429 && e.paced && e.rateLimitReset.getTime() === resetAt * 1000, "window at the reserve: stopped before asking");
    assert.strictEqual(sent, 1, "the refused request was never sent");
    await rc.timelinePage("me", "tweets");
    assert.strictEqual(sent, 2, "another endpoint's window is its own");
    // The window belongs to the account's token, not the client: the next client on the same token (the next run,
    // a Sync now press) knows it before asking; another account's token doesn't.
    const next = createClient({ token: "t", meter, readCap: 100, userCap: 100, retryWaitsMs: [] });
    await assert.rejects(next.likingUsers("333"), (e) => e.paced);
    assert.strictEqual(sent, 2, "a new client on the same token didn't ask either");
    await createClient({ token: "other-account", meter, readCap: 100, userCap: 100, retryWaitsMs: [] }).likingUsers("444");
    assert.strictEqual(sent, 3, "another account's window is its own");
    // With the meter's store (services/ratelimits.js, per account in the database), the window lives THERE: a client
    // on a brand-new token for the same account (the token rotated, another process) still knows it.
    const shared = new Map();
    const accountMeter = { record: async () => {}, windows: { get: async (ep) => shared.get(ep) || null, set: async (ep, w) => shared.set(ep, w) } };
    await createClient({ token: "token-1", meter: accountMeter, readCap: 100, userCap: 100, retryWaitsMs: [] }).likingUsers("555");
    assert.deepStrictEqual(shared.get("/tweets/:id/liking_users"), { remaining: RATE_RESERVE, reset: resetAt * 1000 });
    await assert.rejects(createClient({ token: "token-2-rotated", meter: accountMeter, readCap: 100, userCap: 100, retryWaitsMs: [] }).likingUsers("666"), (e) => e.paced);
    assert.strictEqual(sent, 4, "the rotated token's client didn't ask: the account's window said no");
  } finally {
    global.fetch = realFetch;
  }

  // A reply's library picks: more than the reply has room for is refused BEFORE any lookup or fetch (a urlencoded form
  // can carry ~1,000 `library` fields, each a whole picture in memory). No database here: a lookup would hang, so the
  // refusal must come first, within the race.
  {
    const { fetchPicked } = require("../services/mediaLibrary");
    const keys = (n) => Array.from({ length: n }, (_, i) => `3_${1000 + i}`);
    const within = (p) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error("looked something up first")), 500))]);
    await assert.rejects(within(fetchPicked("me", keys(900))), (e) => e.notice === "media-many", "900 picks refused at once");
    await assert.rejects(within(fetchPicked("me", keys(5))), (e) => e.notice === "media-many", "5 picks: X takes 4");
    await assert.rejects(within(fetchPicked("me", keys(2), 1)), (e) => e.notice === "media-many", "2 picks beside 3 uploads");
    assert.deepStrictEqual(await fetchPicked("me", []), [], "none picked, nothing to do");
  }

  // YOUR OWN FOLLOW-UPS in an Inbox card (services/inbox.js inboxRows), as X's thread shows them: a reply of yours to a
  // post of yours in the chat, down the chain, and one under your seed posted once they'd answered (yours with a picture,
  // under your own post in someone's thread, was missing); what you wrote under the seed before anyone answered (your
  // thread's 2/n) stays out.
  {
    const { inboxRows } = require("../services/inbox");
    const box = [
      tp("4100", "own", ME, "c9", { day: 1 }), // your post: the seed
      tp("4110", "own", ME, "c9", { to: ME, parent: "4100", day: 1 }), // your thread's 2/n, before anyone answered
      tp("4200", "mention", P, "c9", { to: ME, parent: "4100", day: 2 }), // they answered the seed
      tp("4300", "own", ME, "c9", { to: P, parent: "4200", day: 2 }), // you answered them
      tp("4400", "own", ME, "c9", { to: ME, parent: "4300", day: 3 }), // your follow-up to your own answer
      tp("4500", "own", ME, "c9", { to: ME, parent: "4400", day: 3 }), // and its follow-up
      tp("4600", "own", ME, "c9", { to: ME, parent: "4100", day: 3 }), // under your seed, once they'd answered
    ];
    const [row] = inboxRows(box, ME, { byId: new Map(box.map((p) => [p._id, p])), startId: "4000" });
    assert.deepStrictEqual(row.dialogue.map((v) => v.id).sort(), ["4200", "4300", "4400", "4500", "4600"], "your follow-ups join the card; your thread written before anyone answered doesn't");
  }

  // A card you MARKED done, someone answering again: their new reply, the post of yours it answers, AND the done message
  // of theirs your post was answering ("free ones?" needs the "want a sticker pack?" it answered),
  // words or a GIF alike; above that, the back and forth folds.
  {
    const { inboxRows } = require("../services/inbox");
    const card = (yours) => {
      const box = [
        tp("5100", "own", ME, "c8", { day: 1 }), // your post: the seed
        tp("5150", "mention", P, "c8", { to: ME, parent: "5100", day: 1 }), // their first reply (done)
        tp("5170", "own", ME, "c8", { to: P, parent: "5150", day: 1 }), // your answer to it
        tp("5200", "mention", P, "c8", { to: ME, parent: "5170", day: 2 }), // "want a sticker pack?" (done)
        { ...tp("5300", "own", ME, "c8", { to: P, parent: "5200", day: 2 }), ...yours }, // "free ones?"
        tp("5400", "mention", P, "c8", { to: ME, parent: "5300", day: 3 }), // "always": new, waiting
      ];
      const [row] = inboxRows(box, ME, { byId: new Map(box.map((p) => [p._id, p])), startId: "5000", marks: new Map([["c8", "5200"]]) });
      return row.dialogue.map((v) => v.id);
    };
    const gif = { text: "", media: [{ key: "3_1", type: "animated_gif", url: "https://pbs.twimg.com/tweet_video_thumb/abc.jpg", width: 480, height: 270 }] };
    assert.deepStrictEqual(card({ text: "free ones?" }), ["5200", "5300", "5400"], "your post keeps the message it answered in view");
    assert.deepStrictEqual(card(gif), ["5200", "5300", "5400"], "a reaction GIF the same");
  }

  // THE SEARCH (services/listing.js, every list's box and the agent's `q`): plain letters on both sides, every word in
  // any order, a handle with or without @, a pasted profile link as its handle; and the Inbox searches what a card
  // SHOWS, never a reply's hidden @-prefix (every reply to you starts with your handle: searching it matched them all).
  {
    const { searchTerms, matches } = require("../services/listing");
    const hit = (hay, q) => matches(hay, searchTerms(q));
    assert.ok(hit("Léa Dubé leadube", "lea dube"), "accents fold: lea finds Léa");
    assert.ok(hit("Ana Petrović", "PETROVIC"), "and case");
    assert.ok(hit("𝓜𝓪𝔂𝓪 Okafor maya", "maya okafor"), "a fancy-font name is its plain letters");
    assert.ok(hit("Dev Raman devships the launch went well", "launch dev"), "every word, in any order");
    assert.ok(!hit("Dev Raman devships", "dev launch"), "every word must appear");
    assert.ok(hit("Dev Raman devships", "@DevShips"), "a @handle");
    for (const link of ["https://x.com/devships", "x.com/devships/status/123", "https://twitter.com/@devships?s=21", "www.x.com/devships"]) {
      assert.deepStrictEqual(searchTerms(link), ["devships"], `a profile link is its handle: ${link}`);
    }
    assert.deepStrictEqual(searchTerms("   "), [], "blank is no search");

    const { inboxRows, listing: L } = require("../services/inbox");
    const mine = tp("6100", "own", ME, "c7", { day: 1 });
    const reply = { ...tp("6200", "mention", P, "c7", { to: ME, parent: "6100", day: 2 }), text: "@you thinking about the launch", mentions: [{ id: ME, username: "you", start: 0, end: 4 }] };
    const rows = inboxRows([mine, reply], ME, { byId: new Map([[mine._id, mine], [reply._id, reply]]), startId: "6000", names: new Map([[P, "mayabuilds"]]) });
    const found = (q) => L.listRows(rows, L.parseQuery({ q, show: "all" })).rows.length;
    assert.strictEqual(found("@you"), 0, "your own handle in a reply's hidden prefix matches nothing");
    assert.strictEqual(found("launch"), 1, "the words a card shows match");
    assert.strictEqual(found("@mayabuilds launch"), 1, "a writer's handle and a word of theirs");
  }

  // WHO THEY TAG (services/tagged.js): who a set of posts @-tags, once per post, never the author, most-tagged first
  // (ties: the most recent); the rows say where you stand from the pairs and leave you out; the list hides the people
  // you follow unless asked; a typed handle is cleaned or refused.
  {
    const tagged = require("../services/tagged");
    const post = (id, at, ...mentions) => ({ id, created_at: at, entities: { mentions: mentions.map(([mid, username]) => ({ id: mid, username })) } });
    const found = tagged.taggedIn(
      [
        post("1", "2026-11-01T00:00:00Z", ["10", "maya"], ["10", "maya"], ["99", "harry"]), // twice in one post counts once; the author never
        post("2", "2026-11-03T00:00:00Z", ["20", "dev"], ["10", "maya"]),
        post("3", "2026-11-02T00:00:00Z", ["30", "em"]),
        post("4", "2026-11-04T00:00:00Z"), // tags nobody
      ],
      "99"
    );
    assert.deepStrictEqual(found.map((p) => [p.id, p.n]), [["10", 2], ["20", 1], ["30", 1]], "most tagged first, ties by the newest");
    assert.strictEqual(found[0].lastAt.toISOString(), "2026-11-03T00:00:00.000Z", "lastAt is the newest post tagging them");
    const rows = tagged.rowsOf({ people: [...found, { id: "me", username: "you", n: 5 }] }, { youFollow: new Map([["10", true]]), followsYou: new Map([["20", true], ["30", false]]), meId: "me" });
    assert.deepStrictEqual(rows.map((r) => r.id), ["10", "20", "30"], "you're never on your own list");
    assert.deepStrictEqual(rows.map((r) => [r.youFollow, r.followsYou]), [[true, false], [false, true], [false, false]], "where you stand comes from the pairs, an explicit true only");
    const L = tagged.listing;
    assert.deepStrictEqual(L.listRows(rows, L.parseQuery({ handle: "harry" })).rows.map((r) => r.id), ["20", "30"], "by default, people you already follow are left out");
    assert.strictEqual(L.listRows(rows, L.parseQuery({ handle: "harry", who: "all" })).rows.length, 3, "who=all shows everyone");
    assert.strictEqual(L.hrefFor(L.parseQuery({ handle: "harry" }), { page: 2 }), "/follows/tags?handle=harry&page=2", "the handle rides in every link");
  }
  // THE ACCOUNT SWITCHER's session (lib/sessionAccounts.js): accounts added by signing in, one active, a switch only to
  // one already here, signing out of one hands over to the next.
  {
    const sa = require("../lib/sessionAccounts");
    assert.deepStrictEqual(sa.listOf({ accountId: "1" }), ["1"], "a session from before the switcher holds its one account");
    const s = {};
    sa.signedIn(s, [], "1");
    sa.signedIn(s, sa.listOf(s), "2");
    assert.deepStrictEqual([s.accounts, s.accountId], [["1", "2"], "2"], "a sign-in while signed in adds the account and makes it active");
    sa.signedIn(s, sa.listOf(s), "1");
    assert.deepStrictEqual([s.accounts, s.accountId], [["2", "1"], "1"], "signing in again as one already here: no copy, it's active");
    assert.deepStrictEqual([sa.switchTo(s, "9"), s.accountId, sa.switchTo(s, "2"), s.accountId], [false, "1", true, "2"], "a switch only to an account already signed in here");
    assert.deepStrictEqual([sa.forget(s, "2"), s.accounts], ["1", ["1"]], "out of the active one: the next takes over");
    assert.deepStrictEqual([sa.forget(s, "1"), s.accountId, s.accounts], [null, undefined, []], "out of the last: none left");
    const full = {};
    for (const id of ["1", "2", "3", "4", "5", "6"]) sa.signedIn(full, sa.listOf(full), id);
    assert.deepStrictEqual(full.accounts, ["2", "3", "4", "5", "6"], `at most ${sa.MAX_ACCOUNTS}, the oldest dropping off`);
  }
  // LIKE THEIR LATEST POSTS (services/likeLatest.js toLike): newest first, none you've liked, never yours, at most n.
  {
    const { toLike, quoteUsd, READ_MAX } = require("../services/likeLatest");
    const posts = [{ id: "9", author_id: "7" }, { id: "8", author_id: "7" }, { id: "6", author_id: "1" }, { id: "5", author_id: "7" }, { id: "4", author_id: "7" }];
    assert.deepStrictEqual(toLike(posts, new Set(["8"]), 2, "1"), ["9", "5"], "skips a post you liked and your own, keeps their order, stops at n");
    assert.deepStrictEqual(toLike(posts, new Set(["9", "8", "5", "4"]), 50, "1"), [], "nothing left to like");
    assert.ok(Math.abs(quoteUsd(50) - (READ_MAX * 0.005 + 50 * 0.015)) < 1e-9, "the quote: the posts read and the likes, at X's prices");
  }
  console.log("verify-people: all checks pass");
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
