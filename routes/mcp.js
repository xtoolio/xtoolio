// routes/mcp.js — /mcp: an account's own agent (Claude Code, Cursor, OpenAI's API, anything that speaks the Model
// Context Protocol) reading that account's xtoolio data, and leaving draft replies for the person to send. The tools
// are services/agentTools.js (each says whether it writes: `annotations`); this is the door.
//
// One request, one answer (the SDK's stateless Streamable HTTP, JSON responses, no stream to hold open), so any of the
// web copies answers any request and nginx needs nothing new. Signed in by a token the account made
// (models/AgentToken.js: `Authorization: Bearer xto_…`), never a cookie: web.js mounts this BEFORE the cookie, session,
// CSRF and form parsers (an agent has no CSRF cookie; the token is the proof), and the site's IP limiter (which trusts
// only cookie sessions). Its own limits: per address, then per token. No CORS headers: a web page elsewhere can't call it.
//
// A fresh MCP server per request, its tools bound to the ONE account the token opened: no tool takes an account, so
// none can reach another's data.
"use strict";

const express = require("express");
const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = require("express-rate-limit");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const config = require("../config");
const Account = require("../models/Account");
const AgentToken = require("../models/AgentToken");
const AgentGrant = require("../models/AgentGrant");
const agentOAuth = require("../services/agentOAuth");
const { TOOLS } = require("../services/agentTools");
const { version } = require("../package.json");

const PATH = "/mcp";
// What the protocol's errors look like (JSON-RPC), so an agent's app can read them.
const rpcError = (res, status, code, message, headers = {}) => res.status(status).set(headers).json({ jsonrpc: "2.0", error: { code, message }, id: null });

// The MCP server for one account: the tools, each answering JSON as text. A tool that throws answers a plain error
// (the detail goes to the log, not to the agent). `agent` is the token that opened it ({ tokenId, name }): a draft says
// whose it is.
function serverFor(account, agent) {
  const server = new McpServer({ name: config.brandName, version });
  for (const tool of TOOLS) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.input, annotations: tool.annotations }, async (args) => {
      try {
        const out = await tool.run(account, args, agent);
        return { content: [{ type: "text", text: JSON.stringify(out) }], ...(out.error && { isError: true }) };
      } catch (err) {
        console.error(`[mcp] ${tool.name} for @${account.username}: ${err.message}`);
        return { content: [{ type: "text", text: JSON.stringify({ error: `${config.brandName} couldn't answer that just now. Try again in a moment.` }) }], isError: true };
      }
    });
  }
  return server;
}

// The bearer → its account (THE fields a request loads, as a browser's session does), or 401. Two kinds open the
// door, each its own model: a pasted token (xto_…, models/AgentToken.js) and an approved app's access token (xta_…,
// models/AgentGrant.js, services/agentOAuth.js). The 401 points at the protected-resource document (RFC 9728), which
// is how claude.ai and ChatGPT find the sign-in by themselves.
async function signedIn(req, res, next) {
  const m = /^Bearer (\S+)$/.exec(req.get("authorization") || "");
  const bearer = m && m[1];
  const found = !bearer ? null : bearer.startsWith(AgentGrant.PREFIX.ACCESS) ? await AgentGrant.accountFor(bearer) : await AgentToken.accountFor(bearer);
  const account = found ? await Account.findById(found.accountId, Account.REQUEST_FIELDS).lean() : null;
  if (!account) return rpcError(res, 401, -32001, `Sign in to ${config.brandName}: connect this app from ${config.brandName}, or send Authorization: Bearer xto_…`, { "WWW-Authenticate": `Bearer realm="${config.brandName}", resource_metadata="${agentOAuth.RESOURCE_METADATA}"${bearer ? ', error="invalid_token"' : ""}` });
  req.agent = { account, tokenId: found.tokenId || found.grantId, name: found.name };
  next();
}

module.exports = function mcpRoutes() {
  const router = express.Router();
  // Per address first (keyed on IP alone, as the site's limiter): bounds what an unknown caller costs before a token
  // is even looked up. Then per token: one agent can't monopolise the web process.
  const byAddress = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => `mcp:${ipKeyGenerator(req.ip)}`, handler: (req, res) => rpcError(res, 429, -32002, "Too many requests. Wait a minute.") });
  const byToken = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => `mcp-token:${req.agent.tokenId}`, handler: (req, res) => rpcError(res, 429, -32002, "Too many requests for this token: 60 a minute. Wait a minute.") });

  router.post(PATH, byAddress, express.json({ limit: "100kb" }), signedIn, byToken, async (req, res) => {
    const server = serverFor(req.agent.account, { tokenId: req.agent.tokenId, name: req.agent.name });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error(`[mcp] for @${req.agent.account.username}: ${err.message}`);
      if (!res.headersSent) rpcError(res, 500, -32603, "Internal error");
    }
  });
  // Stateless: no stream to open (GET) and no session to end (DELETE).
  router.get(PATH, (req, res) => rpcError(res, 405, -32000, "Method not allowed: POST JSON-RPC to /mcp.", { Allow: "POST" }));
  router.delete(PATH, (req, res) => rpcError(res, 405, -32000, "Method not allowed: there are no sessions to end.", { Allow: "POST" }));
  // SIGN-IN FOR AGENT APPS (services/agentOAuth.js): the SDK's OAuth endpoints and metadata at the site's root, here
  // with the door they open (before cookies, sessions and CSRF: apps call them without a browser session). The approve
  // page itself is a signed-in page (routes/agents.js).
  router.use(agentOAuth.router());
  return router;
};
