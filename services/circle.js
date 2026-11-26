// YOUR CIRCLE (the app's social side): you in the middle, the
// people closest to you (your back and forth, and their likes of your posts) around you in rings, shareable as a public page whose preview on X is a
// picture of it. Pure: who's in it, where every seat is, and the stylesheet that places them.
//
// WHO: CLOSENESS (`ranked`) = the back and forth (services/people.js leaderboard's `mutual`: the smaller of your
// replies to them and theirs to you) + the likes they gave your posts × LIKE_WEIGHT (a third: three likes count as one
// back and forth), then the total of replies, then recency. Someone who only ever likes your posts is in it too (as
// many likes as one back and forth gets them in), and so is anyone at closeness 1 or more; one-way mentions alone never
// make it. The likes are the ones xtoolio knows (Live's and the likers check's: services/extras.js signalsFor), never a
// new read. Counted on the public page too: a face there never says why it's there (it was replies alone, since likes
// are private on X).
//
// THREE SIZES, picked on the circle page (Account.circle.size: the big ring circle was added as an option
// beside the original, which stays exactly as it was at 50). Each is a GEOMETRY and how many of its rings:
//   50  → THE CLASSIC: 48 seats in rings of 8 / 16 / 24, packed so neighbours kiss or overlap a little,
//         each seat nudged by a fixed wobble, over the rings' faint lines (a looser, livelier look). The default.
//   100 → THE RINGS, three: 20 + 38 + 42 = 100.
//   250 → THE RINGS, six: 20 + 36 + 41 + 46 + 51 + 56 = 250. From a reference picture (~300 faces in tight
//         concentric rings): you big with a count pill, your 20 closest accent-ringed, then rings of smaller faces,
//         evenly spaced, nothing overlapping.
// A full circle holds exactly its size's number (the classic its 48, unchanged).
//
// WHERE: each geometry is ONE set of seats in a board x board square. The page draws each seat as THE avatar inside a
// link with THE tooltip, placed by `circleCss()` (served as /circle.css, generated once like /look.css: percentages of
// the board times its zoom, so it scales); the share image (services/circleImage.js) draws the same seats as SVG. A
// ring is drawn only when it's full, so the picture never has a gap (the inner ring takes any 1..n). THE RINGS ZOOM: a
// circle with fewer rings is enlarged so its last one reaches the edge.
"use strict";

// One geometry. `rings` [{ n, r, a }] (a = the picture's radius), `center` { a }, `phase(k)` the fraction of a step
// ring k starts turned by, `wobble` the per-seat nudges (or none), `maxZoom` (1 = never zoomed), `pill` (you wear the
// count), `pictures(ring)` the X picture size a ring needs (ring 0 = you; null = the stored 73px).
function geometry({ key, board, center, rings, phase, wobble = null, maxZoom = 1, pill = false, pictures }) {
  const C = { x: board / 2, y: board / 2, a: center.a };
  // The nudges: fixed per seat (a hash of ring and index, not random), so /circle.css, the share image and every load
  // agree.
  const nudge = (k, i, salt) => {
    const v = Math.sin((k + 1) * 12.9898 + (i + 1) * 78.233 + salt * 37.719) * 43758.5453;
    return (v - Math.floor(v)) * 2 - 1; // -1..1
  };
  function seat(k, i, m) {
    const ring = rings[k];
    const w = (salt) => (wobble ? nudge(k, i, salt) : 0);
    const t = -Math.PI / 2 + ((i + phase(k)) * 2 * Math.PI) / m + w(1) * (wobble ? wobble.turn : 0);
    const r = ring.r + w(2) * (wobble ? wobble.out : 0);
    const a = ring.a * (1 + w(3) * (wobble ? wobble.size : 0));
    return { ring: k + 1, i, m, x: C.x + r * Math.cos(t), y: C.y + r * Math.sin(t), a };
  }
  // Rings fill in order, so the drawn ones are the first `ringsDrawn`; the zoom brings the last to the board's edge.
  const EDGE = 12;
  function zoomForRings(k) {
    if (maxZoom === 1) return 1; // never zoomed: drawn at the board's own scale, as it always was
    const reach = k === 0 ? C.a + EDGE : rings[k - 1].r + rings[k - 1].a + EDGE;
    return Math.min(maxZoom, +(board / 2 / reach).toFixed(3));
  }
  return { key, BOARD: board, CENTER: C, RINGS: rings, seat, zoomForRings, pill, pictures, lines: !!wobble };
}

const CLASSIC = geometry({
  key: "classic",
  board: 760,
  center: { a: 70 },
  // Sized so neighbours just kiss (a ring's spacing ≈ its pictures' width) and the wobble tips some into a small overlap.
  rings: [
    { n: 8, r: 132, a: 55 },
    { n: 16, r: 236, a: 48 },
    { n: 24, r: 326, a: 44.5 },
  ],
  phase: (k) => (k % 2 ? 0.5 : 0),
  // Each seat's picture up to ±4% in size, ±1° around the ring and ±5 in or out (±2.5° opened gaps of up to 25).
  wobble: { size: 0.04, turn: Math.PI / 180, out: 5 },
  pictures: () => 200,
});

// THE RINGS: the inner ring's faces bigger; the outer rings' one size, 4.5 apart ring to ring, at the radii prototyped as
// discs against the reference. How many sit on each ring is the SIZE's, so a full circle holds
// exactly what its tab says (the pill once read 107 and 274 under tabs saying 100 and 250, when each ring had
// as many as fit, 22 + 40 + 45 + 50 + 56 + 61): a little under the most that fit, each ring
// as airy as the next (~14-19 between faces around a ring).
const RADII = [
  { r: 240, a: 28 },
  { r: 300, a: 18 },
  { r: 340.5, a: 18 },
  { r: 381, a: 18 },
  { r: 421.5, a: 18 },
  { r: 462, a: 18 },
];
const rings = (key, counts) =>
  geometry({
    key,
    board: 1000,
    center: { a: 150 },
    rings: counts.map((n, k) => ({ n, ...RADII[k] })),
    // Each ring a golden-ratio fraction of a step round: rings with nearly the same step otherwise line up into spokes.
    phase: (k) => (k * 0.618) % 1,
    maxZoom: 1.4,
    pill: true,
    // You are drawn up to ~430px in a zoomed share image, the inner ring ~80; an outer face ~20px on the page.
    pictures: (ring) => (ring === 0 ? 400 : ring === 1 ? 200 : null),
  });
const RINGS_100 = rings("r100", [20, 38, 42]);
const RINGS_250 = rings("r250", [20, 36, 41, 46, 51, 56]);

// THE SIZES, in the order the page offers them; `rings` = how many of the geometry's rings it may fill.
const SIZES = [
  { key: "50", geo: CLASSIC, rings: 3 },
  { key: "100", geo: RINGS_100, rings: 3 },
  { key: "250", geo: RINGS_250, rings: 6 },
];
const DEFAULT_SIZE = "50";
const sizeOf = (key) => SIZES.find((s) => s.key === String(key)) || SIZES.find((s) => s.key === DEFAULT_SIZE);
const capacityOf = (size) => size.geo.RINGS.slice(0, size.rings).reduce((s, r) => s + r.n, 0);

// How many seats each ring gets for `count` people: the inner ring any 1..n, an outer ring only when it fills, and
// none past the size's rings.
function ringCounts(count, size = sizeOf()) {
  const counts = [];
  let left = count;
  for (const [k, ring] of size.geo.RINGS.slice(0, size.rings).entries()) {
    if (k === 0) counts.push(Math.min(ring.n, left));
    else if (left >= ring.n) counts.push(ring.n);
    else counts.push(0);
    left -= counts[k];
  }
  return counts;
}
const ringsDrawn = (count, size) => ringCounts(count, size).filter(Boolean).length;

// THE CLOSENESS ORDER (see WHO above): the leaderboard's rows and `likesOfYou` (Map person → how many of your posts they
// liked; signalsFor's likes.ofYou), anyone at closeness 1 or more, closest first. Someone who only liked is a row of
// their own (`id`, no username or profile: the caller fills those). → rows with `likedYou` and `closeness`. Pure.
const LIKE_WEIGHT = 1 / 3;
function ranked(rows, likesOfYou = new Map()) {
  const have = new Set(rows.map((r) => r.id));
  const onlyLiked = [...likesOfYou].filter(([id]) => !have.has(id)).map(([id]) => ({ id, username: null, profile: null, mutual: 0, total: 0, last: null }));
  return [...rows, ...onlyLiked]
    .map((r) => {
      const likedYou = likesOfYou.get(r.id) || 0;
      return { ...r, likedYou, closeness: (r.mutual || 0) + likedYou * LIKE_WEIGHT };
    })
    .filter((r) => r.closeness >= 1 - 1e-9) // three likes: 3 × ⅓ in floating point
    .sort((a, b) => b.closeness - a.closeness || (b.total || 0) - (a.total || 0) || (b.last || 0) - (a.last || 0));
}

// Who's in the circle, in order: THE CLOSENESS ORDER, exactly as many as the rings draw (people past the last full ring
// aren't in it: not drawn, not on its public page). Pure.
function members(rows, sizeKey, likesOfYou) {
  const eligible = ranked(rows, likesOfYou);
  return eligible.slice(0, ringCounts(eligible.length, sizeOf(sizeKey)).reduce((s, n) => s + n, 0));
}

// The class for seat i of m in ring k. The inner ring has a set of seats for every m (1..n); the outer rings one set.
// Scoped by the geometry's board class (g-<key>), so the two geometries' seats never collide.
const slotClass = (k, i, m) => (k === 0 ? `cs-1-${m}-${i}` : `cs-${k + 1}-${i}`);

// The circle for these people (ranked) at `sizeKey`: [{ person, ring, i, m, x, y, a, slot }].
function layout(people, sizeKey) {
  const size = sizeOf(sizeKey);
  const out = [];
  let p = 0;
  ringCounts(people.length, size).forEach((m, k) => {
    for (let i = 0; i < m; i++) out.push({ person: people[p++], ...size.geo.seat(k, i, m), slot: slotClass(k, i, m) });
  });
  return out;
}

// How much a circle of `count` at `sizeKey` is enlarged (the stylesheet's --z, the share image's scale).
const zoomOf = (count, sizeKey) => {
  const size = sizeOf(sizeKey);
  return size.geo.zoomForRings(ringsDrawn(count, size));
};

// /circle.css: for each geometry, every seat as a class, its offset from the centre in percentages of the board times
// the board's zoom (--z: one class per number of rings drawn, cz-<k>; 1 for the classic, which never zooms), plus the
// classic's rings' faint lines (the board's ::before, a radial gradient: 100% is half the board).
function circleCss() {
  const rules = [];
  for (const geo of [CLASSIC, RINGS_100, RINGS_250]) {
    const B = geo.BOARD;
    const C = geo.CENTER;
    const pct = (v) => `${+((v / B) * 100).toFixed(3)}%`;
    const scope = `.circle-board.g-${geo.key}`;
    const rule = (cls, s) => `${scope} .${cls} { left: calc(50% + ${pct(s.x - s.a - C.x)} * var(--z)); top: calc(50% + ${pct(s.y - s.a - C.y)} * var(--z)); width: calc(${pct(2 * s.a)} * var(--z)); height: calc(${pct(2 * s.a)} * var(--z)); }`;
    rules.push(rule("cs-0", C));
    const R = geo.RINGS;
    for (let m = 1; m <= R[0].n; m++) for (let i = 0; i < m; i++) rules.push(rule(slotClass(0, i, m), geo.seat(0, i, m)));
    for (let k = 1; k < R.length; k++) for (let i = 0; i < R[k].n; i++) rules.push(rule(slotClass(k, i, R[k].n), geo.seat(k, i, R[k].n)));
    for (let k = 0; k <= R.length; k++) rules.push(`${scope}.cz-${k} { --z: ${geo.zoomForRings(k)}; }`);
    if (geo.lines) {
      const line = (r) => {
        const at = +((r / (B / 2)) * 100).toFixed(3);
        return `transparent calc(${at}% - 1px), var(--line) ${at}%, transparent calc(${at}% + 1px)`;
      };
      rules.push(`${scope}::before { background: radial-gradient(circle closest-side, ${R.map((r) => line(r.r)).join(", ")}, transparent); }`);
    }
  }
  return `/* Generated from services/circle.js: the seats of the circle (views/partials/circle.hbs). */\n${rules.join("\n")}\n`;
}

// A profile picture at a size the circle can show sharply: X's `size`px rendition of the same file (Person.image is the
// 73px "_bigger"). Only pbs.twimg.com addresses are ever stored (Person.fromApi), so nothing else passes through.
const bigImage = (url, size = 200) => (url ? url.replace(/_(?:bigger|normal)(\.\w+)$/, `_${size}x${size}$1`) : url);
// The picture for a seat in ring `ring` (0 = you) of `sizeKey`'s geometry.
const pictureFor = (url, ring, sizeKey) => {
  const px = sizeOf(sizeKey).geo.pictures(ring);
  return px && url ? bigImage(url, px) : url;
};

// THE circle partial's context (views/partials/circle.hbs), for your circle page, a public one and the front page's
// drawn tour alike: `me` ({ id, username, profile }) and `people` (members(), ranked); `hrefOf(person)` where a face
// opens (null: nowhere), `external` when that's X (also any face whose address is X's: on your own circle someone in it
// only by liking has no People page, so theirs opens on X).
function boardView(me, people, sizeKey, { hrefOf = () => null, external = false } = {}) {
  const size = sizeOf(sizeKey);
  const sized = (p, ring) => (p.profile && p.profile.image ? { ...p, profile: { ...p.profile, image: pictureFor(p.profile.image, ring, size.key) } } : p);
  const seats = layout(people, size.key);
  return {
    me: sized(me, 0),
    // The look's class (g-classic / g-rings, app.css) and the seats' (g-<key>, /circle.css), then the zoom's.
    board: `${size.geo.pill ? "g-rings " : ""}g-${size.geo.key} cz-${ringsDrawn(people.length, size)}`,
    around: size.geo.pill && seats.length ? seats.length : null,
    dots: seats.map((s) => {
      const href = hrefOf(s.person);
      return { person: sized(s.person, s.ring), slot: s.slot, ring: s.ring, href, external: external || /^https:\/\/x\.com\//.test(href || "") };
    }),
  };
}

// "Copy the handles" copies at most the closest 50: never all 250, a post tagging 250 people.
const HANDLES_MAX = 50;

module.exports = { CLASSIC, RINGS_100, RINGS_250, SIZES, DEFAULT_SIZE, HANDLES_MAX, sizeOf, capacityOf, LIKE_WEIGHT, ranked, members, ringCounts, layout, zoomOf, circleCss, bigImage, pictureFor, boardView };
