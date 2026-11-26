// THE MARK's files, all drawn from ONE shape, views/partials/site-mark.hbs (the header draws the same partial inline):
//   tabIcons()   the tab icon per accent (lib/accents.js, light values): the mark alone in the accent, no tile, so a
//                tab shows the same thing as the header; web.js serves them at /mark-<accent>.svg and the layout links
//                the account's, so a new accent shows in the tab on the next page load.
//   homeIcon()   the phone's home screen: FULL BLEED, the default accent's square with the mark in white (iOS rounds it
//                and paints transparency black).
//   tabIcon(fill) also feeds the 32px PNG for browsers without SVG favicons (scripts/make-mark.js writes the PNGs).
"use strict";
const fs = require("fs");
const path = require("path");
// The Handlebars the views render with (express-handlebars' own; `handlebars` isn't a dependency of ours).
const Handlebars = require("express-handlebars").create().handlebars;
const { ACCENTS, accentFor, DEFAULT_ACCENT } = require("./accents");

const mark = Handlebars.compile(fs.readFileSync(path.join(__dirname, "..", "views", "partials", "site-mark.hbs"), "utf8"));
const svgOf = (vars) => mark(vars).trim();

// The partial's svg has no size, so nested it fills its parent and centres its own box there.
const tabIcon = (fill) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">${svgOf({ fill })}</svg>`;

function tabIcons() {
  return new Map(ACCENTS.map((a) => [a.key, tabIcon(a.light.accent)]));
}

function homeIcon() {
  const bg = accentFor(DEFAULT_ACCENT).light.accent;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <rect width="64" height="64" fill="${bg}"/>
  <svg x="8" y="8" width="48" height="48">${svgOf({ fill: "#ffffff" })}</svg>
</svg>`;
}

module.exports = { tabIcon, tabIcons, homeIcon };
