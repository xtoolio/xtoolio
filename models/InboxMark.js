const mongoose = require("mongoose");

// What you marked done in an Inbox card (services/inbox.js). One per account per card, which is one CONVERSATION
// (a card was once one person in one conversation, so your long post with two people's replies showed twice).
// Two parts, ONE rule (inbox.isHandled: an incoming message is done when either covers it; the card is done when every
// incoming message is):
//   throughId — the whole thread up to here: the card's "Mark done" in the everyone view, and Mark all done, set it to
//               the newest incoming message when pressed. Anyone writing something newer makes it wait again.
//   handled   — single messages: "Done with <person>" in the rail's person view marks just theirs (done at
//               the thread level AND the message level), so someone else's message in the same thread
//               keeps the card waiting instead of going to Done unseen.
// Reopen deletes the whole mark. (The earlier per-person marks were merged once, each conversation through
// the newest any of them covered.)
//
// Done is your call, not inferred (you may like and reply, or only like, or only reply): a like or a reply
// doesn't move a card. It replaced a "Done when liked or replied" switch that did.
const InboxMarkSchema = new mongoose.Schema(
  {
    accountId: { type: String, required: true },
    conversationId: { type: String, required: true },
    throughId: { type: String },
    handled: { type: [String], default: undefined },
    at: { type: Date, default: Date.now },
  },
  { versionKey: false }
);
InboxMarkSchema.index({ accountId: 1, conversationId: 1 }, { unique: true });

// An account's marks as services/inbox.js reads them: Map conversationId → { through, handled }. THE reader (the
// Inbox page and the header's count both use it).
InboxMarkSchema.statics.marksFor = async function marksFor(accountId) {
  const rows = await this.find({ accountId }, "conversationId throughId handled").lean();
  return new Map(rows.map((m) => [m.conversationId, { through: m.throughId || null, handled: m.handled || [] }]));
};

module.exports = mongoose.model("InboxMark", InboxMarkSchema);
