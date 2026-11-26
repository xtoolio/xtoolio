const mongoose = require("mongoose");

// THE FIRST-READ QUEUE as the worker sees it (services/scheduler.js publishes it; one doc, `_id: "first"`), so the
// progress page (views/pulling.hbs, web.js) can say where someone stands with one read by _id: "You're 12th in line".
//   waiting  — account ids queued for their first read, in the order they'll start
//   running  — the ones reading now
//   slots    — how many run at once (SYNC_SLOTS)
//   durations — how long the last first reads took (ms, newest last, up to 20): the wait's estimate is their median
//   at       — when it was published (every few seconds while the worker runs; an old one isn't shown)
const PullQueueSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "first" },
    waiting: [String],
    running: [String],
    slots: Number,
    durations: [Number],
    at: Date,
  },
  { versionKey: false, collection: "pullqueue" }
);

module.exports = mongoose.model("PullQueue", PullQueueSchema);
