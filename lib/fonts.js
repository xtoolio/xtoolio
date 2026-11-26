// The fonts an account can pick (Settings → Font), and the stylesheet for them — generated from THIS list, so
// the CSS, the picker and the validation can't drift apart. All self-hosted in public/fonts (the CSP allows fonts
// from 'self' only), Latin variable subsets, OFL 1.1 (public/fonts/LICENSE.md). A browser downloads only the face
// the page actually uses.
"use strict";

const { ASSET_V } = require("./assetVersion");

const FONTS = [
  { key: "bricolage", name: "Bricolage Grotesque", file: "bricolage-grotesque-latin-wght-normal.woff2", weights: "200 800", note: "Characterful" },
  { key: "geist", name: "Geist", file: "geist-latin-wght-normal.woff2", weights: "100 900", note: "Crisp, best numbers" },
  { key: "inter", name: "Inter", file: "inter-latin-wght-normal.woff2", weights: "100 900", note: "Neutral" },
  { key: "manrope", name: "Manrope", file: "manrope-latin-wght-normal.woff2", weights: "200 800", note: "Rounded" },
  { key: "space-grotesk", name: "Space Grotesk", file: "space-grotesk-latin-wght-normal.woff2", weights: "300 700", note: "Techy" },
  { key: "dm-sans", name: "DM Sans", file: "dm-sans-latin-wght-normal.woff2", weights: "100 1000", note: "Friendly" },
  { key: "instrument-sans", name: "Instrument Sans", file: "instrument-sans-latin-wght-normal.woff2", weights: "400 700", note: "Compact" },
];
// Each file's ONE address, versioned like every asset (?v=, immutable-cached in production): the layout's preload and
// the @font-face below must be the same URL or the preload is wasted. Unversioned, every page re-checked the file with
// the server while the stylesheets came from cache, so on a real network the page could paint in the fallback font and
// then swap (font-display: swap), a visible flash.
for (const f of FONTS) f.href = `/fonts/${f.file}?v=${ASSET_V}`;
// The face for anyone who hasn't picked one, and the whole signed-out site (DM Sans; previously Bricolage
// Grotesque, which the mark and the circle's share image still use).
const DEFAULT_FONT = "dm-sans";
const byKey = new Map(FONTS.map((f) => [f.key, f]));

const fontFor = (key) => byKey.get(key) || byKey.get(DEFAULT_FONT);
const FALLBACK = 'system-ui, -apple-system, "Segoe UI", sans-serif';

// The fonts' half of /look.css: one @font-face per font, and the page font per <html data-font>.
function fontsCss() {
  const faces = FONTS.map((f) => `@font-face { font-family: "${f.name}"; src: url("${f.href}") format("woff2"); font-weight: ${f.weights}; font-display: swap; }`);
  const pick = FONTS.map((f) => `:root[data-font="${f.key}"] { --font: "${f.name}", ${FALLBACK}; }`);
  return [`/* Generated from lib/fonts.js. Default: ${fontFor(DEFAULT_FONT).name}. */`, ...faces, ...pick].join("\n") + "\n";
}

module.exports = { FONTS, DEFAULT_FONT, fontFor, fontsCss };
