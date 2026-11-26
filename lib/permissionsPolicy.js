// lib/permissionsPolicy.js — the Permissions-Policy header, in ONE place (app.js sets it on every response).
//
// xtoolio uses NONE of these powerful browser features, so they're disabled outright (an empty allowlist `()` =
// off for everyone, self included). If a script ever ran despite the strict CSP, this is a second wall keeping
// it off the webcam, mic and location.
//
// A page that genuinely needs one feature re-allows THAT feature for itself with allowOn([...]) and keeps every
// other denial. Never hand-write the header on a route: replacing it with one feature alone silently drops every
// other denial (an unlisted feature falls back to its default allowlist).
"use strict";

const FEATURES = [
  "accelerometer", "autoplay", "browsing-topics", "camera",
  "display-capture", "encrypted-media", "fullscreen", "geolocation",
  "gyroscope", "magnetometer", "microphone", "midi", "payment", "usb",
];

// The header value with `allow` (feature names) re-allowed for this origin only; every other feature stays off.
function headerAllowing(allow = []) {
  const on = new Set(allow);
  for (const f of on) if (!FEATURES.includes(f)) throw new Error(`permissionsPolicy: unknown feature "${f}"`);
  return FEATURES.map((f) => `${f}=${on.has(f) ? "(self)" : "()"}`).join(", ");
}

const DEFAULT = headerAllowing();

// Express middleware for one route: re-allow `allow` on that response (set AFTER app.js's default, so it replaces it).
const allowOn = (allow) => {
  const value = headerAllowing(allow);
  return (req, res, next) => {
    res.setHeader("Permissions-Policy", value);
    next();
  };
};

module.exports = { FEATURES, DEFAULT, headerAllowing, allowOn };
