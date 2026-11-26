// services/agentOAuth.js — SIGN-IN FOR AGENT APPS: claude.ai's and ChatGPT's connectors (and Claude Code, Cursor...)
// connect by OAuth 2.1 instead of a pasted token. The person adds `<APP_ORIGIN>/mcp` in their app, is sent here,
// approves on xtoolio's own page (routes/agents.js), and goes back connected.
//
// The protocol is the MCP SDK's own (`mcpAuthRouter`: the metadata documents, dynamic client registration at
// /register, /authorize, /token with PKCE checked, /revoke, each with its own rate limit). This file is only what the
// SDK asks a server to supply (its OAuthServerProvider): where clients, pending approvals and connections are kept
// (models/OAuthClient.js, OAuthRequest.js, AgentGrant.js), and that /authorize hands the person to the approve page.
// Nothing here is hand-rolled crypto: tokens are 32 random bytes, stored hashed (models/AgentGrant.js).
"use strict";

const crypto = require("crypto");
const config = require("../config");
const OAuthClient = require("../models/OAuthClient");
const OAuthRequest = require("../models/OAuthRequest");
const AgentGrant = require("../models/AgentGrant");
const { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } = require("@modelcontextprotocol/sdk/server/auth/router.js");
const { InvalidClientMetadataError, InvalidGrantError, InvalidTokenError } = require("@modelcontextprotocol/sdk/server/auth/errors.js");

// THE resource every token is for: this site's /mcp (RFC 8707). The protected-resource document says so, and an app
// asking for another is refused.
const RESOURCE = `${config.appOrigin}/mcp`;
const APPROVE_PAGE = "/oauth/approve";
const hashOf = (s) => crypto.createHash("sha256").update(s).digest("hex");
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const sameResource = (u) => {
  try {
    const a = new URL(u);
    const b = new URL(RESOURCE);
    return a.origin === b.origin && a.pathname.replace(/\/$/, "") === b.pathname;
  } catch {
    return false;
  }
};

// The desktop apps whose OAuth sends you back on their OWN scheme, by name. Any other scheme is refused: a scheme only
// says which program on the device opens it, and some hand the address straight to a web page (Android's intent://,
// iOS's x-safari-https://), so an attacker could register "Claude" with one, send someone a real approve link, and
// receive the code on their own site while the page said only "intent://" (found by an outside read of the code).
// An app not listed here connects through http on this computer (most do) or https; adding one is a line here.
const APP_SCHEMES = new Set(["cursor:", "vscode:", "vscode-insiders:"]);

// THE rule for where an app may send people back, and how the approve page says it: a web address's host
// ("claude.ai"), this computer (http on loopback: desktop apps listen there), or a listed app's own scheme
// ("cursor://"). Anything else → "" (not allowed). (The SDK also refuses javascript:, data: and vbscript:.)
function placeOf(redirectUri) {
  try {
    const u = new URL(redirectUri);
    if (u.protocol === "https:" && u.hostname) return u.hostname;
    if (u.protocol === "http:" || u.protocol === "https:") return LOOPBACK.has(u.hostname) ? "an app on this computer" : "";
    return APP_SCHEMES.has(u.protocol) ? `${u.protocol}//` : "";
  } catch {
    return "";
  }
}
const allowedRedirects = (uris) => Array.isArray(uris) && uris.length > 0 && uris.every((u) => !!placeOf(u));

function checkRedirects(uris) {
  for (const uri of uris || []) {
    if (!placeOf(uri)) throw new InvalidClientMetadataError(`redirect_uri must be https, http on this computer (localhost, 127.0.0.1), or ${[...APP_SCHEMES].map((s) => `${s}//`).join(", ")}: ${uri}`);
  }
}

// An app's own name as the approve page shows it: control characters and bidi overrides dropped (they can make the
// heading read in another order than it's stored), one line, at most NAME_MAX.
const NAME_MAX = 80;
const cleanName = (s) => String(s || "").replace(/[\u0000-\u001F\u007F-\u009F‎‏‪-‮⁦-⁩]/g, "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX);

// What a registration may hold. /register is open to anyone (that's dynamic registration), so a row keeps ONLY what the
// SDK and the approve page read, in bounded sizes, and an unapproved one lapses in a day (models/OAuthClient.js): the
// SDK accepts any other metadata (contacts, jwks, software_statement...) up to its 100 kB body, which would otherwise
// be a cheap way to fill the database. `UNAPPROVED_MAX` bounds the rows waiting for an approval across everyone.
const KEPT = ["client_id", "client_secret", "client_id_issued_at", "client_secret_expires_at", "redirect_uris", "token_endpoint_auth_method", "grant_types", "response_types", "scope"];
const REDIRECTS_MAX = 5;
const URI_MAX = 512;
const UNAPPROVED_MAX = 5000;

const clientsStore = {
  // A registration whose addresses the rule no longer allows is no client at all, at every step the SDK asks (authorize,
  // token, refresh, revoke): one door for apps registered before the rule.
  async getClient(clientId) {
    const row = await OAuthClient.findById(String(clientId), "info").lean();
    return row && row.info && allowedRedirects(row.info.redirect_uris) ? row.info : undefined;
  },
  async registerClient(info) {
    const uris = info.redirect_uris;
    if (!Array.isArray(uris) || uris.length > REDIRECTS_MAX || uris.some((u) => typeof u !== "string" || u.length > URI_MAX)) {
      throw new InvalidClientMetadataError(`redirect_uris: 1 to ${REDIRECTS_MAX} addresses, each at most ${URI_MAX} characters`);
    }
    checkRedirects(uris);
    if ((await OAuthClient.countDocuments({ expireAt: { $exists: true } })) >= UNAPPROVED_MAX) {
      throw new InvalidClientMetadataError("Too many apps are waiting to be approved; try again later");
    }
    const kept = Object.fromEntries(KEPT.filter((k) => info[k] !== undefined).map((k) => [k, info[k]]));
    if (typeof kept.scope === "string") kept.scope = kept.scope.slice(0, 200);
    const name = cleanName(info.client_name);
    if (name) kept.client_name = name;
    await OAuthClient.create({ _id: kept.client_id, info: kept });
    return kept;
  },
};

const provider = {
  clientsStore,
  // The app sent the person here: keep what it asked and show them the approve page. Nothing is decided yet.
  async authorize(client, params, res) {
    if (params.resource && !sameResource(params.resource.href)) {
      const back = new URL(params.redirectUri);
      back.searchParams.set("error", "invalid_target");
      back.searchParams.set("error_description", `This server's resource is ${RESOURCE}`);
      if (params.state) back.searchParams.set("state", params.state);
      return res.redirect(back.href);
    }
    const id = crypto.randomBytes(24).toString("base64url");
    await OAuthRequest.create({ _id: id, clientId: client.client_id, redirectUri: params.redirectUri, state: params.state, codeChallenge: params.codeChallenge, resource: params.resource ? params.resource.href : undefined, scopes: params.scopes || [] });
    res.redirect(`${APPROVE_PAGE}?r=${id}`);
  },
  async challengeForAuthorizationCode(client, code) {
    const row = await OAuthRequest.findOne({ codeHash: hashOf(String(code)), clientId: client.client_id }, "codeChallenge").lean();
    if (!row) throw new InvalidGrantError("Invalid or expired authorization code");
    return row.codeChallenge;
  },
  // The code (once: the request is deleted as it's read) → the connection's tokens.
  async exchangeAuthorizationCode(client, code, codeVerifier, redirectUri) {
    const row = await OAuthRequest.findOneAndDelete({ codeHash: hashOf(String(code)), clientId: client.client_id, accountId: { $type: "string" } }).lean();
    if (!row) throw new InvalidGrantError("Invalid or expired authorization code");
    if (redirectUri && redirectUri !== row.redirectUri) throw new InvalidGrantError("redirect_uri doesn't match the one the code was issued to");
    await OAuthClient.updateOne({ _id: client.client_id }, { $unset: { expireAt: 1 } }); // approved once: kept
    return AgentGrant.grant({ accountId: row.accountId, clientId: client.client_id, name: client.client_name, redirectHost: placeOf(row.redirectUri), resource: row.resource || RESOURCE });
  },
  async exchangeRefreshToken(client, refreshToken) {
    const tokens = await AgentGrant.refresh(client.client_id, refreshToken);
    if (!tokens) throw new InvalidGrantError("Invalid or expired refresh token");
    return tokens;
  },
  async verifyAccessToken(token) {
    const found = await AgentGrant.accountFor(token);
    if (!found) throw new InvalidTokenError("Invalid or expired token");
    return { token, clientId: found.clientId, scopes: [], expiresAt: Math.floor(new Date(found.expiresAt).getTime() / 1000), resource: new URL(RESOURCE), extra: { accountId: found.accountId } };
  },
  async revokeToken(client, { token }) {
    await AgentGrant.revokeToken(client.client_id, token);
  },
};

// THE APPROVE PAGE's side (routes/agents.js). A request still waiting for a person → what the page shows, or null.
async function pendingView(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(id)) return null;
  const row = await OAuthRequest.findOne({ _id: id, accountId: { $exists: false } }).lean();
  if (!row) return null;
  const client = await clientsStore.getClient(row.clientId);
  if (!client) return null;
  return { id, name: cleanName(client.client_name) || "An app", place: placeOf(row.redirectUri) };
}
// The person said yes (signed in as `accountId`): a one-time code, and where the app gets it. → URL | null
async function approve(id, accountId) {
  const code = crypto.randomBytes(32).toString("base64url");
  const row = await OAuthRequest.findOneAndUpdate({ _id: String(id), accountId: { $exists: false } }, { $set: { accountId: String(accountId), codeHash: hashOf(code) } }, { returnDocument: "after" }).lean();
  if (!row) return null;
  const back = new URL(row.redirectUri);
  back.searchParams.set("code", code);
  if (row.state) back.searchParams.set("state", row.state);
  return back.href;
}
// The person said no: the app hears access_denied. → URL | null
async function deny(id) {
  const row = await OAuthRequest.findOneAndDelete({ _id: String(id), accountId: { $exists: false } }).lean();
  if (!row) return null;
  const back = new URL(row.redirectUri);
  back.searchParams.set("error", "access_denied");
  if (row.state) back.searchParams.set("state", row.state);
  return back.href;
}

// The SDK's endpoints, mounted at the site's root BEFORE the cookie, session and CSRF layers (web.js): apps call them
// without a browser session. Registrations never expire their secret (an app would lose its connection after the
// SDK's default 30 days).
const router = () =>
  mcpAuthRouter({ provider, issuerUrl: new URL(config.appOrigin), resourceServerUrl: new URL(RESOURCE), resourceName: config.brandName, clientRegistrationOptions: { clientSecretExpirySeconds: 0 } });

// What a 401 from /mcp points at, so an app finds the sign-in by itself (RFC 9728).
const RESOURCE_METADATA = getOAuthProtectedResourceMetadataUrl(new URL(RESOURCE));

module.exports = { router, provider, pendingView, approve, deny, placeOf, RESOURCE, RESOURCE_METADATA, APPROVE_PAGE };
