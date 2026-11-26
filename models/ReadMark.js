const mongoose = require("mongoose");

// "X already returned this resource today": X charges a post or user once per 24-hour UTC day however often it's
// returned (docs.x.com pricing). `_id` = "<UTC day>:<post|user>:<id>", inserted on every response
// (services/usage.js record); an insert that finds it already there is a free re-read. Kept two days, then gone.
const ReadMarkSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    at: { type: Date, required: true },
  },
  { versionKey: false }
);
ReadMarkSchema.index({ at: 1 }, { expireAfterSeconds: 2 * 24 * 3600 });

module.exports = mongoose.model("ReadMark", ReadMarkSchema);
