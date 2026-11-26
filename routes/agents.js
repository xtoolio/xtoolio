// routes/agents.js — the signed-in side of connecting an agent (the door itself is routes/mcp.js):
//   GET  /oauth/approve?r=…   an app (claude.ai, ChatGPT...) asks to connect: who's asking, where it sends you back,
//                             what it can and can't do; Approve / Cancel. Signed out: Sign in with X, back here after.
//   POST /oauth/approve       the answer → the app's page (services/agentOAuth.js approve / deny)
//   POST /agents              make a token to paste (Claude Code, Cursor, an API): shown ONCE, on its own page
//   POST /agents/:id/disconnect   end a token or an app's connection (Settings → Agents)
// Back to the app goes through a page, not a redirect: the CSP's form-action 'self' covers every redirect a form leads
// to (web.js), and the app's address is elsewhere by definition. The page moves on by itself (meta refresh, which no
// form-action governs) and has the link.
"use strict";

const express = require("express");
const config = require("../config");
const AgentToken = require("../models/AgentToken");
const AgentGrant = require("../models/AgentGrant");
const OAuthRequest = require("../models/OAuthRequest");
const agentOAuth = require("../services/agentOAuth");
const { disconnect, countFor, MAX } = require("../services/agentConnections");
const { requireAccount, withNotice } = require("./pages");

const SETTINGS = "/settings#agents";

module.exports = function agentRoutes() {
  const router = express.Router();
  const MCP_URL = agentOAuth.RESOURCE;

  router.get(agentOAuth.APPROVE_PAGE, async (req, res) => {
    const ask = await agentOAuth.pendingView(String(req.query.r || ""));
    const here = `${agentOAuth.APPROVE_PAGE}?r=${encodeURIComponent(String(req.query.r || ""))}`;
    res.render("oauth-approve", { pageTitle: "Connect an app", ask, signIn: `/auth/x?back=${encodeURIComponent(here)}` });
  });

  router.post(agentOAuth.APPROVE_PAGE, requireAccount, async (req, res) => {
    const id = String(req.body.r || "");
    const yes = req.body.answer === "approve";
    let to = null;
    let refused = null;
    if (yes) {
      // At most MAX connections; approving an app already connected just renews it.
      const row = await OAuthRequest.findById(id, "clientId").lean();
      const renewing = row && (await AgentGrant.exists({ accountId: req.account._id, clientId: row.clientId }));
      if (row && !renewing && (await countFor(req.account._id)) >= MAX) refused = `You have ${MAX} connections already. Disconnect one in Settings first.`;
      else to = await agentOAuth.approve(id, req.account._id);
    } else to = await agentOAuth.deny(id);
    if (!to) return res.render("oauth-approve", { pageTitle: "Connect an app", ask: null, refused });
    // The one-time code is in this page's link and refresh: never kept by the browser's cache, never sent on as a referrer.
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    res.render("oauth-back", { pageTitle: "Connect an app", to, refresh: `0;url=${to}`, approved: yes });
  });

  router.post("/agents", requireAccount, async (req, res) => {
    if ((await countFor(req.account._id)) >= MAX) return res.redirect(303, withNotice(SETTINGS, "agent-limit"));
    const name = String(req.body.name || "").replace(/\s+/g, " ").trim().slice(0, 40) || "Agent";
    const { token } = await AgentToken.mint(req.account._id, name);
    res.set("Cache-Control", "no-store"); // the token is on this page once: never kept by the browser's cache
    res.render("agent-made", {
      pageTitle: "Your token",
      name,
      token,
      url: MCP_URL,
      claudeCode: `claude mcp add --transport http ${config.brandName} ${MCP_URL} --header "Authorization: Bearer ${token}"`,
      json: JSON.stringify({ mcpServers: { [config.brandName]: { url: MCP_URL, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
    });
  });

  router.post("/agents/:id/disconnect", requireAccount, async (req, res) => {
    const gone = await disconnect(req.account._id, String(req.params.id));
    res.redirect(303, withNotice(SETTINGS, gone ? "agent-disconnected" : "agent-gone"));
  });

  return router;
};
