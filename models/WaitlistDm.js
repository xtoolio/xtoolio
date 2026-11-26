const mongoose = require("mongoose");

// One "you're in" direct message per person on the waitlist, EVER (services/waitlistDms.js): `_id` the person's X id
// (the waitlist row's), so a second Grant can't queue them twice. Queued by an admin's Grant while the sender is
// connected, sent by the worker:
//   status   queued → sending (claimed by one worker) → sent | refused; `sending` left by a dead worker goes back to
//            queued after SENDING_STALE_MS (X refuses a repeat as dm-duplicate, so a resend can't double up)
//   problem  X's reason for a refusal, its problem key ("dm-recipient-not-accepting"), and `detail` X's words
//   tries    sends attempted (a refused one sent again from the Admin page counts up)
const WaitlistDmSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    username: String,
    status: { type: String, enum: ["queued", "sending", "sent", "refused"], default: "queued" },
    queuedAt: { type: Date, required: true },
    claimedAt: Date,
    sentAt: Date,
    eventId: String, // X's dm_event_id
    problem: String,
    detail: String,
    tries: { type: Number, default: 0 },
  },
  { versionKey: false, collection: "waitlistdms" }
);
WaitlistDmSchema.index({ status: 1, queuedAt: 1 });

module.exports = mongoose.model("WaitlistDm", WaitlistDmSchema);
