const mongoose = require("mongoose");

// X's real prepaid credit balance (GET /2/usage/credits), as THE BALANCE CLOCK reads it (services/balanceClock.js:
// once a minute, stored when it moved or hourly). A time series: consecutive readings bracket every cent spent, so a
// day's real spend is the sum of its drops (a rise is a top-up), whatever ran or crashed in between. The oldest
// readings were taken around each unit and also carry `entryId` / `phase`; nothing reads those any more.
// `d`: the move since the previous reading (services/usage.js moveOf): positive = spent, negative = added (a top-up).
// Written as the reading is taken, so a day's spend is a sum the database does (a year of the clock is up to ~500k
// readings). The first reading ever has none. Readings from before `d` existed got theirs once, by a one-off backfill.
// `owner`: the X user id whose token read it (X_APP_OWNER_ID), i.e. WHOSE credit balance it is. A move is only ever
// measured against the same owner's previous reading: moving the app to another developer account made
// the clock read one account's balance then the other's (say $300 then $100), and stored the $200 between two
// different balances as a day's spend. A new owner's first reading has no `d`, like the first reading ever. Readings
// from before `owner` was recorded carry none.
const BalanceReadingSchema = new mongoose.Schema(
  {
    at: { type: Date, required: true, index: true },
    usd: { type: Number, required: true },
    d: Number,
    owner: String,
  },
  { versionKey: false }
);
// The Usage page's lookups are by owner (services/usage.js): its latest, the reading just after a row, its credits.
BalanceReadingSchema.index({ owner: 1, at: -1 });

module.exports = mongoose.model("BalanceReading", BalanceReadingSchema);
