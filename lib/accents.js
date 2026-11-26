// The accent colours an account can pick (Settings → Accent: a handful that work on both light and dark
// mode), and their CSS, generated from THIS list (the picker, the validation and the
// stylesheet can't drift apart). Each sets the three accent tokens app.css uses everywhere (links, buttons, the
// header mark's border, tooltips' links, and the HEARTS and the sidebar's NOTIFICATION counts, so
// hearts are no longer always pink; app.css's own --like
// token is gone): `accent`, `ink` (text drawn ON the accent: a pill button's, a count's), `soft` (a tint behind it: a
// like pill's), one set for light and one for dark, each checked by eye on both themes. BRIGHT:
// Blue is X-era blue, the app's colour since the start and the default; Pink is the hearts' and counts' pink as it was
// (#f91880); the rest at the same brightness. Graphite and the muted teal went with that.
"use strict";

const ACCENTS = [
  { key: "blue", name: "Blue", light: { accent: "#1d9bf0", ink: "#ffffff", soft: "#e6f3fd" }, dark: { accent: "#3aa7f5", ink: "#04121c", soft: "#10273a" } },
  { key: "pink", name: "Pink", light: { accent: "#f91880", ink: "#ffffff", soft: "#fde8f1" }, dark: { accent: "#f91880", ink: "#ffffff", soft: "#3a1426" } },
  { key: "violet", name: "Violet", light: { accent: "#8b5cf6", ink: "#ffffff", soft: "#f1ecff" }, dark: { accent: "#a78bfa", ink: "#140b2e", soft: "#221a3f" } },
  { key: "cyan", name: "Cyan", light: { accent: "#00b4cc", ink: "#ffffff", soft: "#dff7fa" }, dark: { accent: "#22d3ee", ink: "#041a1f", soft: "#0c2a30" } },
  { key: "green", name: "Green", light: { accent: "#00ba7c", ink: "#ffffff", soft: "#ddf6ec" }, dark: { accent: "#19d38f", ink: "#04170f", soft: "#0d2b20" } },
  { key: "orange", name: "Orange", light: { accent: "#ff7a00", ink: "#ffffff", soft: "#fff0e0" }, dark: { accent: "#ff9a3c", ink: "#2a1405", soft: "#33200f" } },
];
const DEFAULT_ACCENT = "blue";
const byKey = new Map(ACCENTS.map((a) => [a.key, a]));
const accentFor = (key) => byKey.get(key) || byKey.get(DEFAULT_ACCENT);

// The tokens for one set, and the swatch's own colour (Settings' picker shows each accent in the theme being viewed).
const tokens = (t) => `--accent: ${t.accent}; --accent-ink: ${t.ink}; --accent-soft: ${t.soft};`;

// Per <html data-accent>, over app.css's own :root tokens (one more attribute, so it wins whatever the order), dark the
// same three ways app.css switches: the system's dark under data-theme auto, and data-theme="dark".
function accentsCss() {
  const out = [`/* Accents: generated from lib/accents.js. Default: ${accentFor(DEFAULT_ACCENT).name}. */`];
  for (const a of ACCENTS) {
    out.push(`:root[data-accent="${a.key}"] { ${tokens(a.light)} }`);
    out.push(`.swatch-${a.key} { --swatch: ${a.light.accent}; }`);
  }
  const dark = ACCENTS.map((a) => `:root:not([data-theme="light"])[data-accent="${a.key}"] { ${tokens(a.dark)} } :root:not([data-theme="light"]) .swatch-${a.key} { --swatch: ${a.dark.accent}; }`);
  out.push(`@media (prefers-color-scheme: dark) {\n  ${dark.join("\n  ")}\n}`);
  for (const a of ACCENTS) out.push(`:root[data-theme="dark"][data-accent="${a.key}"] { ${tokens(a.dark)} } :root[data-theme="dark"] .swatch-${a.key} { --swatch: ${a.dark.accent}; }`);
  return out.join("\n") + "\n";
}

module.exports = { ACCENTS, DEFAULT_ACCENT, accentFor, accentsCss };
