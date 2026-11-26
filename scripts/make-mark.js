// THE MARK's PNGs (your circle; its one shape is views/partials/site-mark.hbs, its files lib/mark.js). The tab icons are SVG,
// one per accent, generated at boot (web.js /mark-<accent>.svg); this writes the two that must be PNG, in the default
// accent:
//   public/favicon-32.png       for browsers without SVG favicons: the tab icon
//   public/apple-touch-icon.png 180×180, a phone's home screen: full bleed (no transparency: iOS fills it black)
//   public/icon-192.png, icon-512.png  the same, for the web app manifest (web.js /manifest.webmanifest; Android)
// node scripts/make-mark.js (again after changing the shape or the default accent)
"use strict";
const fs = require("fs");
const path = require("path");
const { Resvg } = require("@resvg/resvg-js");
const { tabIcon, homeIcon } = require("../lib/mark");
const { accentFor, DEFAULT_ACCENT } = require("../lib/accents");

const PUBLIC = path.join(__dirname, "..", "public");
const png = (svg, w) => new Resvg(svg, { fitTo: { mode: "width", value: w } }).render().asPng();
fs.writeFileSync(path.join(PUBLIC, "favicon-32.png"), png(tabIcon(accentFor(DEFAULT_ACCENT).light.accent), 32));
fs.writeFileSync(path.join(PUBLIC, "apple-touch-icon.png"), png(homeIcon(), 180));
for (const s of [192, 512]) fs.writeFileSync(path.join(PUBLIC, `icon-${s}.png`), png(homeIcon(), s));
console.log("favicon-32.png, apple-touch-icon.png (180), icon-192.png, icon-512.png");
