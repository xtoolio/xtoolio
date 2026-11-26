// The theme, ONE list. Light is the default everywhere (dark was tried as the default and dropped; accounts
// that had saved dark keep it). A signed-in account keeps its own
// (Account.theme, cycled by the header menu's Theme item, in this order); someone not signed in flips light / dark
// with the header's sun / moon on the front page, remembered in a cookie that holds only "light" or "dark" (never
// "auto": the server can't know the system's scheme, so the button couldn't say which way it flips). Signed-in
// presses write the cookie too, so the front page stays as you left it after signing out; a new account starts
// with it (routes/auth.js). Rendered server-side on <html data-theme>, so there's no flash. Pure.
"use strict";

const THEMES = ["light", "dark", "auto"];
const DEFAULT_THEME = "light";
const COOKIE = "xt.theme";
const COOKIE_MAX_AGE_MS = 365 * 24 * 3600 * 1000;

// The cookie's theme, if it's one it may hold; else null.
const cookieTheme = (req) => {
  const v = req.cookies && req.cookies[COOKIE];
  return v === "light" || v === "dark" ? v : null;
};

// The theme a request renders in: the account's, else the cookie's, else the default.
const themeFor = (req) => (req.account && THEMES.includes(req.account.theme) ? req.account.theme : cookieTheme(req) || DEFAULT_THEME);

module.exports = { THEMES, DEFAULT_THEME, COOKIE, COOKIE_MAX_AGE_MS, cookieTheme, themeFor };
