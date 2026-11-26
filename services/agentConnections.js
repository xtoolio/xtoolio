// services/agentConnections.js — an account's CONNECTIONS (Settings → Agents): the tokens it made to paste into an
// agent (models/AgentToken.js) and the apps it approved by signing in (models/AgentGrant.js), as ONE list with ONE
// disconnect. Either opens /mcp for this account alone (routes/mcp.js).
"use strict";

const AgentToken = require("../models/AgentToken");
const AgentGrant = require("../models/AgentGrant");

const MAX = 10; // connections per account: plenty for every app and machine someone uses

// → [{ id, kind: "token" | "app", name, place (an app: where it sends you back), createdAt, lastUsedAt }], newest first
async function connectionsFor(accountId) {
  const [tokens, grants] = await Promise.all([AgentToken.find({ accountId: String(accountId) }, "name createdAt lastUsedAt").lean(), AgentGrant.find({ accountId: String(accountId) }, "name redirectHost createdAt lastUsedAt").lean()]);
  return [
    ...tokens.map((t) => ({ id: t._id, kind: "token", name: t.name || "Token", createdAt: t.createdAt, lastUsedAt: t.lastUsedAt })),
    ...grants.map((g) => ({ id: String(g._id), kind: "app", name: g.name || "An app", place: g.redirectHost, createdAt: g.createdAt, lastUsedAt: g.lastUsedAt })),
  ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// Ends one of this account's connections at once (the next call it makes is a 401). → whether one went
async function disconnect(accountId, id) {
  const aid = String(accountId);
  if (/^[a-f0-9]{64}$/.test(id)) return (await AgentToken.deleteOne({ _id: id, accountId: aid })).deletedCount > 0;
  if (/^[a-f0-9]{24}$/.test(id)) return (await AgentGrant.deleteOne({ _id: id, accountId: aid })).deletedCount > 0;
  return false;
}

const countFor = async (accountId) => (await AgentToken.countDocuments({ accountId: String(accountId) })) + (await AgentGrant.countDocuments({ accountId: String(accountId) }));

module.exports = { connectionsFor, disconnect, countFor, MAX };
