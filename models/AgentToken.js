// models/AgentToken.js — a token an account made for its own agent (Claude Code, Cursor, OpenAI's API...) to read its
// xtoolio data through /mcp (routes/mcp.js). The token itself is shown once, when it's made, and never stored: `_id` is
// its SHA-256, so a stolen database holds nothing that opens the door. 32 random bytes, so a hash needs no salt or
// slowing (that's for passwords people choose). Revoking deletes the row. Read-only: what a token can reach is exactly
// what the tools in services/agentTools.js return for its account, nothing else.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

// The shape a token has: a prefix that says what it is (secret scanners and people both recognise it), then 43
// base64url characters. Anything else is refused before the database is asked.
const PREFIX = "xto_";
const SHAPE = /^xto_[A-Za-z0-9_-]{43}$/;
// How often a token's lastUsedAt is written: a busy agent calls many times a minute, and the row needs only "lately".
const USED_EVERY_MS = 60 * 1000;

const AgentTokenSchema = new mongoose.Schema(
  {
    _id: { type: String }, // sha256(token), hex
    accountId: { type: String, required: true, index: true },
    name: { type: String, default: "" }, // what it's for, the account's own words ("Claude Code on my laptop")
    createdAt: { type: Date, default: Date.now },
    lastUsedAt: { type: Date },
  },
  { versionKey: false }
);

const hashOf = (token) => crypto.createHash("sha256").update(token).digest("hex");

// A new token for `accountId` → { token (show it once), id (the hash, which names it in a list) }.
AgentTokenSchema.statics.mint = async function mint(accountId, name = "") {
  const token = PREFIX + crypto.randomBytes(32).toString("base64url");
  const id = hashOf(token);
  await this.create({ _id: id, accountId: String(accountId), name: String(name).slice(0, 80) });
  return { token, id };
};

// The account a presented token belongs to, or null (wrong shape, unknown, revoked), with the token's id and name (a
// draft says whose it is: models/Draft.js `by`). Marks it used at most once a minute.
AgentTokenSchema.statics.accountFor = async function accountFor(token) {
  if (typeof token !== "string" || !SHAPE.test(token)) return null;
  const id = hashOf(token);
  const row = await this.findById(id, "accountId name lastUsedAt").lean();
  if (!row) return null;
  if (!row.lastUsedAt || Date.now() - new Date(row.lastUsedAt).getTime() > USED_EVERY_MS) await this.updateOne({ _id: id }, { $set: { lastUsedAt: new Date() } });
  return { accountId: row.accountId, tokenId: id, name: row.name || "" };
};

AgentTokenSchema.statics.SHAPE = SHAPE;

module.exports = mongoose.model("AgentToken", AgentTokenSchema);
