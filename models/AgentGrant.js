// models/AgentGrant.js — an app an account APPROVED (claude.ai, ChatGPT, an IDE: services/agentOAuth.js), the sign-in
// twin of a pasted token (models/AgentToken.js): Settings lists both as the account's connections and Disconnect
// deletes either. One per account and app; approving the same app again replaces its tokens.
// The app holds an access token (an hour) and a refresh token (rotated on every use, 60 days unused); only their
// SHA-256 is stored, so a stolen database opens nothing. What an access token reaches is exactly what a pasted token
// does: the tools in services/agentTools.js for this one account.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const ACCESS = "xta_";
const REFRESH = "xtr_";
const SHAPE = /^xt[ar]_[A-Za-z0-9_-]{43}$/;
const ACCESS_MS = 60 * 60 * 1000;
const REFRESH_MS = 60 * 24 * 3600 * 1000;
const USED_EVERY_MS = 60 * 1000;

const AgentGrantSchema = new mongoose.Schema(
  {
    accountId: { type: String, required: true },
    clientId: { type: String, required: true },
    name: { type: String, default: "" }, // the app's own name for itself (its registration's client_name)
    redirectHost: { type: String, default: "" }, // where it sends people back: what the approve page showed
    accessHash: { type: String, required: true },
    accessExpiresAt: { type: Date, required: true },
    refreshHash: { type: String, required: true },
    refreshExpiresAt: { type: Date, required: true },
    resource: { type: String },
    createdAt: { type: Date, default: Date.now },
    lastUsedAt: { type: Date },
  },
  { versionKey: false }
);
AgentGrantSchema.index({ accountId: 1, clientId: 1 }, { unique: true });
AgentGrantSchema.index({ accessHash: 1 }, { unique: true });
AgentGrantSchema.index({ refreshHash: 1 }, { unique: true });
AgentGrantSchema.index({ refreshExpiresAt: 1 }, { expireAfterSeconds: 0 }); // a connection unused for 60 days goes

const hashOf = (token) => crypto.createHash("sha256").update(token).digest("hex");
const mint = (prefix) => prefix + crypto.randomBytes(32).toString("base64url");

// A fresh pair for this grant's fields → { tokens (OAuth's answer), fields (what to store) }.
function freshPair() {
  const access = mint(ACCESS);
  const refresh = mint(REFRESH);
  const now = Date.now();
  return {
    tokens: { access_token: access, token_type: "Bearer", expires_in: ACCESS_MS / 1000, refresh_token: refresh },
    fields: { accessHash: hashOf(access), accessExpiresAt: new Date(now + ACCESS_MS), refreshHash: hashOf(refresh), refreshExpiresAt: new Date(now + REFRESH_MS) },
  };
}

// Approved: this account's connection to this app, new tokens (an earlier approval's stop working).
AgentGrantSchema.statics.grant = async function grant({ accountId, clientId, name, redirectHost, resource }) {
  const { tokens, fields } = freshPair();
  await this.findOneAndUpdate({ accountId: String(accountId), clientId }, { $set: { ...fields, name: String(name || "").slice(0, 80), redirectHost, resource }, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
  return tokens;
};

// A refresh token → a new pair (the old refresh token stops working), or null.
AgentGrantSchema.statics.refresh = async function refresh(clientId, token) {
  if (typeof token !== "string" || !SHAPE.test(token) || !token.startsWith(REFRESH)) return null;
  const { tokens, fields } = freshPair();
  const row = await this.findOneAndUpdate({ refreshHash: hashOf(token), clientId, refreshExpiresAt: { $gt: new Date() } }, { $set: fields }, { returnDocument: "after" });
  return row ? tokens : null;
};

// An access token → { accountId, grantId, name, clientId, expiresAt } or null (wrong shape, unknown, expired,
// disconnected). Marks it used at most once a minute.
AgentGrantSchema.statics.accountFor = async function accountFor(token) {
  if (typeof token !== "string" || !SHAPE.test(token) || !token.startsWith(ACCESS)) return null;
  const row = await this.findOne({ accessHash: hashOf(token), accessExpiresAt: { $gt: new Date() } }, "accountId clientId name lastUsedAt accessExpiresAt").lean();
  if (!row) return null;
  if (!row.lastUsedAt || Date.now() - new Date(row.lastUsedAt).getTime() > USED_EVERY_MS) await this.updateOne({ _id: row._id }, { $set: { lastUsedAt: new Date() } });
  return { accountId: row.accountId, grantId: String(row._id), name: row.name, clientId: row.clientId, expiresAt: row.accessExpiresAt };
};

// The app gives a token back (OAuth's /revoke): its whole connection ends.
AgentGrantSchema.statics.revokeToken = function revokeToken(clientId, token) {
  if (typeof token !== "string" || !SHAPE.test(token)) return Promise.resolve();
  const h = hashOf(token);
  return this.deleteOne({ clientId, $or: [{ accessHash: h }, { refreshHash: h }] });
};

AgentGrantSchema.statics.PREFIX = { ACCESS, REFRESH };

module.exports = mongoose.model("AgentGrant", AgentGrantSchema);
