const mongoose = require("mongoose");

// THE limits on screenshots sent with feedback (routes/feedback.js checks them; the box's script reads the same numbers,
// drawn into the form's data-shots, to say no before uploading).
const SHOTS_MAX = 3; // per piece of feedback
const SHOT_BYTES = 10 * 1024 * 1024; // each: a full-screen screenshot on a big display fits
const SHOTS_PER_DAY = 15; // per account: the day's feedback limit can't fill the database with pictures
const SHOT_TYPES = ["png", "jpeg", "webp", "gif"]; // lib/media.js sniff's names, read from the bytes; never SVG

// A SCREENSHOT someone attached to their feedback (models/Feedback.js `shots` lists them): the image's bytes as sent,
// its type as its bytes say, kept in the database (feedback is rare and small; nothing else here stores files). Shown to
// admins only (routes/admin.js GET /admin/feedback/shot/:id); deleted with the account (services/deleteAccount.js).
const FeedbackShotSchema = new mongoose.Schema(
  {
    accountId: { type: String, required: true }, // indexed by { accountId, at } below (the day's count, the delete)
    feedbackId: { type: mongoose.Schema.Types.ObjectId, required: true },
    mime: { type: String, required: true },
    bytes: Number,
    data: { type: Buffer, required: true },
    at: { type: Date, default: Date.now },
  },
  { versionKey: false }
);
FeedbackShotSchema.index({ accountId: 1, at: -1 });

module.exports = mongoose.model("FeedbackShot", FeedbackShotSchema);
Object.assign(module.exports, { SHOTS_MAX, SHOT_BYTES, SHOTS_PER_DAY, SHOT_TYPES });
