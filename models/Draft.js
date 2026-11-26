// models/Draft.js — a reply an account's own agent drafted (services/agentTools.js draft_reply) for a message in its
// Inbox, waiting for the person: the message wears "✎ Draft from <agent>" (partials/draft-line.hbs) and its reply box
// opens with the text in it. Nothing is ever sent from here: the person edits it and presses Reply (THE reply route,
// web.js, which deletes the draft once X has the reply), or discards it (✕).
// One per message: a new draft for the same message replaces it. Drawn only while that message still owes a reply
// (services/inbox.js inboxRows), so a message answered on X, or marked done, simply stops showing it; the row goes on
// its own after two weeks.
"use strict";

const mongoose = require("mongoose");

const KEEP_MS = 14 * 24 * 3600 * 1000;

const DraftSchema = new mongoose.Schema(
  {
    accountId: { type: String, required: true },
    postId: { type: String, required: true }, // the message it answers (someone else's post in the account's Inbox)
    conversationId: { type: String, required: true },
    text: { type: String, required: true },
    by: { type: String, default: "" }, // the connection's name (models/AgentToken.js `name`), as the line says it
    tokenId: { type: String, default: "" },
    at: { type: Date, default: Date.now },
    expireAt: { type: Date, default: () => new Date(Date.now() + KEEP_MS) },
  },
  { versionKey: false }
);
DraftSchema.index({ accountId: 1, postId: 1 }, { unique: true });
DraftSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

// THE write: the draft for this message, replacing any earlier one.
DraftSchema.statics.put = function put({ accountId, postId, conversationId, text, by = "", tokenId = "" }) {
  const now = new Date();
  return this.findOneAndUpdate(
    { accountId: String(accountId), postId: String(postId) },
    { $set: { conversationId: String(conversationId), text, by, tokenId, at: now, expireAt: new Date(now.getTime() + KEEP_MS) } },
    { upsert: true, returnDocument: "after", lean: true }
  );
};
// THE read: the account's drafts by the message they answer → Map postId → { text, by, at }.
DraftSchema.statics.draftsFor = async function draftsFor(accountId) {
  const rows = await this.find({ accountId: String(accountId) }, "postId text by at").lean();
  return new Map(rows.map((d) => [d.postId, { text: d.text, by: d.by, at: d.at }]));
};
DraftSchema.statics.drop = function drop(accountId, postId) {
  return this.deleteOne({ accountId: String(accountId), postId: String(postId) });
};

module.exports = mongoose.model("Draft", DraftSchema);
