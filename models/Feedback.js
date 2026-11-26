const mongoose = require("mongoose");

// THE limits on what one piece of feedback keeps (routes/feedback.js reads them; the box's maxlength is TEXT_MAX).
const TEXT_MAX = 2000;
const PAGE_MAX = 300;

// FEEDBACK someone sent from the app (the sidebar's Feedback → THE modal → POST /feedback, routes/feedback.js): their
// words, who (account and handle as it was), the page they were on, when, up to 3 screenshots (`shots`, their own
// collection: the list loads without the pictures); `doneAt` once an admin marked it handled
// (routes/admin.js). Read by the admins on the Admin page and by `npm run feedback`. Deleted with the account.
const FeedbackSchema = new mongoose.Schema(
  {
    accountId: { type: String, required: true, index: true },
    username: String,
    // THE limits (the route refuses past them with a toast; here they're the last stop for any other writer).
    text: { type: String, required: true, maxlength: TEXT_MAX },
    page: { type: String, maxlength: PAGE_MAX },
    at: { type: Date, default: Date.now, index: true },
    shots: [mongoose.Schema.Types.ObjectId], // its screenshots (models/FeedbackShot.js), in the order attached
    doneAt: Date,
  },
  { versionKey: false }
);

module.exports = mongoose.model("Feedback", FeedbackSchema);
module.exports.TEXT_MAX = TEXT_MAX;
module.exports.PAGE_MAX = PAGE_MAX;
