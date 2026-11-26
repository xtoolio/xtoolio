// CSRF protection: `csrf-csrf` (the maintained successor to the archived `csurf`), set up here once. It's a SIGNED,
// SESSION-BOUND double-submit token: the token is HMAC(secret, session identifier + random) + the random, kept in an
// httpOnly cookie and sent back with every form (`_csrf` field, or the `x-csrf-token` header for fetch). A POST
// passes only when the two match AND the HMAC holds for THIS session, so a token minted in another session (an
// attacker's own visit, planted as a cookie: "cookie tossing") is refused.
//
// The session identifier is the login session (express-session's id) AND THE ACTIVE ACCOUNT when signed in: one
// browser can hold several accounts (THE ACCOUNT SWITCHER, lib/sessionAccounts.js) and every tab shares the one cookie,
// so a page drawn for account A, still open after a switch to B in another tab, would otherwise press as B (a like
// on X from the wrong account). Bound to the account, its token is refused instead. Signed out there's no session
// to bind to (sessions are created at sign-in only, so a signed-out page mints none): the identifier is "", which
// guards the one signed-out form, the light/dark toggle. In production the cookie is `__Host-` prefixed, which the
// browser accepts only over HTTPS, for the exact host, with no Domain: nothing on another subdomain can set it.
//
// History: csurf first (archived; its cookie mode had the same unbound weakness), then briefly a hand-rolled HMAC
// token, unbound too, replaced by this.
"use strict";

const crypto = require("crypto");
const { doubleCsrf } = require("csrf-csrf");

// → { protect (the middleware: sets req.csrfToken, refuses a bad POST with code EBADCSRFTOKEN), generateCsrfToken,
//     validateRequest, sessionOf, cookieName }. `key`: the server's secret (config.sessionSecret), from which the CSRF
// key is derived (its own key, not the session's). Needs cookie-parser, express-session and the body parsers first.
function csrfProtection({ key, production = false }) {
  if (!key) throw new Error("csrfProtection needs a key");
  const secret = crypto.createHmac("sha256", key).update("xtoolio csrf").digest("hex");
  const cookieName = production ? "__Host-xt.csrf" : "xt.csrf";
  const sessionOf = (req) => (req.session && req.session.accountId ? `${req.sessionID}:${req.session.accountId}` : "");
  const { doubleCsrfProtection, generateCsrfToken, validateRequest } = doubleCsrf({
    getSecret: () => secret,
    getSessionIdentifier: sessionOf,
    cookieName,
    // lax, not strict: arriving from x.com (sign-in) is a cross-site navigation, and a strict cookie left behind would
    // be replaced, expiring the forms in every other open tab.
    cookieOptions: { sameSite: "lax", secure: production, path: "/", httpOnly: true },
    getCsrfTokenFromRequest: (req) => {
      const header = req.headers["x-csrf-token"];
      if (typeof header === "string" && header) return header;
      return req.body && typeof req.body._csrf === "string" ? req.body._csrf : "";
    },
  });
  return { protect: doubleCsrfProtection, generateCsrfToken, validateRequest, sessionOf, cookieName };
}

module.exports = { csrfProtection };
