// models/OAuthClient.js — an app that registered itself to ask accounts for a connection (claude.ai, ChatGPT, an IDE):
// OAuth's dynamic client registration (RFC 7591), through the MCP SDK's /register (services/agentOAuth.js). `info` is
// the registration as the SDK hands it back (client_id, redirect_uris, client_name, client_secret for a confidential
// client...), only the fields services/agentOAuth.js keeps. A registration nobody approved is dropped after a day (an
// app registers right before sending the person to approve it); the first approval keeps it.
"use strict";

const mongoose = require("mongoose");

const UNUSED_MS = 24 * 3600 * 1000;

const OAuthClientSchema = new mongoose.Schema(
  {
    _id: { type: String }, // client_id
    info: { type: mongoose.Schema.Types.Mixed, required: true },
    createdAt: { type: Date, default: Date.now },
    expireAt: { type: Date, default: () => new Date(Date.now() + UNUSED_MS) }, // unset once an account approves it
  },
  { versionKey: false, minimize: false }
);
OAuthClientSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("OAuthClient", OAuthClientSchema);
