// THE SHARE IMAGE of a circle, in two shapes (SHAPES below): the square to download and post as a picture, and the
// wide card that's the public page's og:image (so a link posted on X shows the circle). Drawn as SVG from
// services/circle.js's seats (the page's own geometry) and turned into a PNG by resvg (@resvg/resvg-js: no browser, no
// native canvas).
//
// - Colours are the light theme's tokens, read from public/app.css's first :root block (one source; the image has no
//   theme to follow).
// - Text is Bricolage Grotesque, the mark's face (formerly the app's default), from assets/fonts (a TTF made once from the self-hosted woff2,
//   which resvg can't read; OFL 1.1, see assets/fonts/LICENSE.md). It has Latin only, so the image says the @handle,
//   never a display name that might need other scripts.
// - Pictures are fetched from X's image server (pbs.twimg.com only: Person.image never holds anything else, and
//   `fetchPicture` refuses any other host) and embedded; one that fails or is too big becomes the initial on a disc,
//   as on the page.
"use strict";

const fs = require("fs");
const path = require("path");
const { Resvg } = require("@resvg/resvg-js");
const circle = require("./circle");

const FONT_FILE = path.join(__dirname, "..", "assets", "fonts", "bricolage-grotesque-latin-wght-normal.ttf");
const FONT = "Bricolage Grotesque";

// The light theme's tokens from app.css (`--name: value;` inside the first `:root {` block).
function lightTokens(css) {
  const start = css.indexOf(":root {");
  const block = css.slice(start, css.indexOf("\n}", start));
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}
const T = lightTokens(fs.readFileSync(path.join(__dirname, "..", "public", "app.css"), "utf8"));

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const PICTURE_MAX = 300 * 1024;
// One picture as a data: URI, or null (refused host, X's error, too big, too slow). `url` already at the size its
// ring needs (circle.pictureFor).
async function fetchPicture(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.hostname !== "pbs.twimg.com") return null;
    const res = await fetch(u, { redirect: "error", signal: AbortSignal.timeout(5000) }); // the host check holds only without redirects
    const type = res.headers.get("content-type") || "";
    if (!res.ok || !/^image\/(jpeg|png|webp|gif)$/.test(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > PICTURE_MAX ? null : `data:${type};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

// The initial a picture-less seat shows (as the avatar partial's data-initial: the first letter of the name or handle).
const initialOf = (p) => (((p.profile && p.profile.name) || p.username || "?").trim()[0] || "?").toUpperCase();

// The edges, by geometry, as the page draws them (app.css .circle-dot): THE CLASSIC a cut-out in the background's colour
// so overlapping faces read as two, the inner ring in the accent, you in ink; THE RINGS you and the inner ring in the
// accent, the outer rings a hairline.
const HALOS = {
  classic: (disc, ring, me) => (me ? disc(10, T.bg) + disc(7, T.ink) + disc(4, T.bg) : ring === 1 ? disc(7, T.bg) + disc(5, T.accent) + disc(3, T.bg) : disc(3, T.bg)),
  rings: (disc, ring, me) => (me ? disc(6, T.accent) : ring === 1 ? disc(3.5, T.accent) : disc(1.5, T.line)),
};

// One seat: the picture clipped to a disc (or the initial), edged as its look's (HALOS).
function seatSvg(s, picture, id, initial, { look, ring = 0, me = false }) {
  const disc = (out, fill) => `<circle cx="${s.x}" cy="${s.y}" r="${s.a + out}" fill="${fill}"/>`;
  const halo = HALOS[look](disc, ring, me);
  const base = `<circle cx="${s.x}" cy="${s.y}" r="${s.a}" fill="${T.them}"/>`;
  const body = picture
    ? `<clipPath id="c${id}"><circle cx="${s.x}" cy="${s.y}" r="${s.a}"/></clipPath><image href="${picture}" x="${s.x - s.a}" y="${s.y - s.a}" width="${2 * s.a}" height="${2 * s.a}" clip-path="url(#c${id})" preserveAspectRatio="xMidYMid slice"/>`
    : `<text x="${s.x}" y="${s.y}" dy="0.35em" text-anchor="middle" font-family="${FONT}" font-size="${Math.round(s.a * 0.8)}" fill="${T.muted}">${esc(initial)}</text>`;
  return halo + base + body;
}

// THE TWO SHAPES of one design (the first had a headline beside the circle): the circle is the picture,
// centred and as big as the shape allows; the only words are the SITE's, small: its domain bottom-left and its own X
// account (SITE_X) bottom-right (the owner's @handle used to be bottom-left: they're the face in the middle, and
// the post carries their name). `square` (1080 x 1080) is the one to download and post as a picture; `card`
// (1200 x 630) is the link's preview (og:image): X shows that card wide and would crop a square one.
const SHAPES = {
  square: { w: 1080, h: 1080, pad: 36, label: 30 },
  card: { w: 1200, h: 630, pad: 20, label: 24 },
};

// The pictures are fetched FETCHES_AT_ONCE at a time (up to 275 for a full 250 circle; all at once, each draw held
// that many sockets and their bytes together). → `fn` of each item, in order
const FETCHES_AT_ONCE = 16;
async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// The PNG for `owner` ({ username, image, profile? }) and `people` (ranked, each { id, username, profile }), in `shape`,
// drawn at the circle's size (services/circle.js SIZES: its geometry and rings).
async function circlePng({ owner, people, size, siteDomain, siteX = null, shape = "card" }) {
  const { w, h, pad, label } = SHAPES[shape] || SHAPES.card;
  const { geo } = circle.sizeOf(size);
  const seats = circle.layout(people, size);
  const wanted = [{ url: owner.image, ring: 0 }, ...seats.map((s) => ({ url: s.person.profile && s.person.profile.image, ring: s.ring }))];
  const pictures = await mapLimited(wanted, FETCHES_AT_ONCE, ({ url, ring }) => (url ? fetchPicture(circle.pictureFor(url, ring, size)) : null));
  // The board as big as the shape allows, centred, at the circle's zoom (as the page's --z; the classic never zooms).
  const z = circle.zoomOf(seats.length, size);
  const scale = (Math.min(w, h) - 2 * pad) / geo.BOARD;
  const bx = (w - geo.BOARD * scale) / 2;
  const by = (h - geo.BOARD * scale) / 2;
  const { x: cx, y: cy } = geo.CENTER;
  // THE CLASSIC's faint ring lines, under the seats; its outer rings drawn first, so the closer ones sit on top (as the
  // page's z-index).
  const lines = geo.lines ? geo.RINGS.map((r) => `<circle cx="${cx}" cy="${cy}" r="${r.r}" fill="none" stroke="${T.line}" stroke-width="2"/>`).join("") : "";
  const order = seats.map((s, k) => ({ s, k }));
  if (geo.lines) order.sort((p, q) => q.s.ring - p.s.ring);
  // THE RINGS: how many are around you, a pill on your picture's foot (app.css .circle-count).
  const n = geo.pill && seats.length ? String(seats.length) : "";
  const pillH = 64;
  const pillW = 40 + n.length * 30;
  const foot = cy + geo.CENTER.a;
  const pill = n
    ? `<rect x="${cx - pillW / 2 - 5}" y="${foot - pillH / 2 - 5}" width="${pillW + 10}" height="${pillH + 10}" rx="${pillH / 2 + 5}" fill="${T.bg}"/><rect x="${cx - pillW / 2}" y="${foot - pillH / 2}" width="${pillW}" height="${pillH}" rx="${pillH / 2}" fill="${T.accent}"/><text x="${cx}" y="${foot}" dy="0.35em" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="44" fill="${T["accent-ink"]}">${n}</text>`
    : "";
  const look = geo.pill ? "rings" : "classic";
  const board = [lines, ...order.map(({ s, k }) => seatSvg(s, pictures[k + 1], k, initialOf(s.person), { look, ring: s.ring })), seatSvg(geo.CENTER, pictures[0], "me", (owner.username || "?")[0].toUpperCase(), { look, me: true }), pill].join("");
  // The corners (outside the circle in both shapes): where it's from, the site and its X account.
  const edge = Math.round(label * 1.2);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<rect width="${w}" height="${h}" fill="${T.bg}"/>
<g transform="translate(${bx} ${by}) scale(${scale}) translate(${cx} ${cy}) scale(${z}) translate(${-cx} ${-cy})">${board}</g>
<text x="${edge}" y="${h - edge}" font-family="${FONT}" font-size="${label}" fill="${T.accent}">${esc(siteDomain)}</text>
${siteX ? `<text x="${w - edge}" y="${h - edge}" text-anchor="end" font-family="${FONT}" font-size="${label}" fill="${T.ink}">${esc(`@${siteX}`)}</text>` : ""}
</svg>`;
  return new Resvg(svg, { font: { fontFiles: [FONT_FILE], loadSystemFonts: false, defaultFontFamily: FONT } }).render().asPng();
}

module.exports = { circlePng, lightTokens, SHAPES };
