const mongoose = require("mongoose");

// THE UNDO OF A DONE (every Done has an Undo in its toast): what every Inbox mark a Done
// press touched was BEFORE it (a card's ✓ Done, the rail's ✓, the toolbar's ✓ Done N), so the toast's Undo
// (POST /inbox/undo, web.js) puts each back exactly: `prev` null = there was no mark (deleted on undo), else its
// throughId / handled as they were. Reopen can't be the undo: it deletes the whole mark, and a card marked before
// would lose that too. One record per press, used once (deleted by the undo), kept a day.
const InboxUndoSchema = new mongoose.Schema(
  {
    accountId: { type: String, required: true },
    marks: [{ _id: false, conversationId: String, prev: { type: mongoose.Schema.Types.Mixed, default: null } }],
    at: { type: Date, default: Date.now, expires: 24 * 3600 },
  },
  { versionKey: false }
);

// Before a Done press writes: the marks of these conversations as they stand. → the record's id (the toast's token).
InboxUndoSchema.statics.snapshot = async function snapshot(accountId, conversationIds, InboxMark) {
  const now = await InboxMark.find({ accountId, conversationId: { $in: conversationIds } }, "conversationId throughId handled").lean();
  const by = new Map(now.map((m) => [m.conversationId, { throughId: m.throughId || null, handled: m.handled || null }]));
  const doc = await this.create({ accountId, marks: conversationIds.map((c) => ({ conversationId: c, prev: by.get(c) || null })) });
  return String(doc._id);
};

// The undo itself: the record (the account's own, once: it's deleted as it's read), every mark put back as it was
// (none before: deleted). → how many marks it touched | null (no such record, or already used / expired).
InboxUndoSchema.statics.restore = async function restore(id, accountId, InboxMark) {
  const u = /^[a-f0-9]{24}$/.test(String(id || "")) ? await this.findOneAndDelete({ _id: id, accountId }).lean() : null;
  if (!u) return null;
  const at = new Date();
  if (u.marks.length) {
    await InboxMark.bulkWrite(u.marks.map(({ conversationId, prev }) => (prev
      ? { replaceOne: { filter: { accountId, conversationId }, replacement: { accountId, conversationId, ...(prev.throughId && { throughId: prev.throughId }), ...(prev.handled && { handled: prev.handled }), at }, upsert: true } }
      : { deleteOne: { filter: { accountId, conversationId } } })), { ordered: false });
  }
  return u.marks.length;
};

module.exports = mongoose.model("InboxUndo", InboxUndoSchema);
