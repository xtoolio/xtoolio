// models/OAuthRequest.js — one app asking one account for a connection, from the app's /authorize to its /token
// (services/agentOAuth.js): made when the app sends the person here (what it asked: its redirect, PKCE challenge,
// state), shown on the approve page by its random `_id`, given an account and a one-time code when the person
// approves, deleted when the code is exchanged. Ten minutes from start to finish, or it's gone.
"use strict";

const mongoose = require("mongoose");

const LIFETIME_MS = 10 * 60 * 1000;

const OAuthRequestSchema = new mongoose.Schema(
  {
    _id: { type: String }, // random, in the approve page's address
    clientId: { type: String, required: true },
    redirectUri: { type: String, required: true },
    state: { type: String },
    codeChallenge: { type: String, required: true },
    resource: { type: String },
    scopes: { type: [String], default: [] },
    accountId: { type: String }, // set on approval
    codeHash: { type: String }, // sha256 of the one-time code, set on approval
    expireAt: { type: Date, default: () => new Date(Date.now() + LIFETIME_MS) },
  },
  { versionKey: false }
);
OAuthRequestSchema.index({ codeHash: 1 }, { unique: true, partialFilterExpression: { codeHash: { $type: "string" } } });
OAuthRequestSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("OAuthRequest", OAuthRequestSchema);
