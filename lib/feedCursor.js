// The money ledgers' shared database pieces: the Usage page's rows (services/usage.js usageRows) and a paying
// account's statement (services/billing.js statement) page the same way and sum by day the same way.
"use strict";

const mongoose = require("mongoose");

// THE page cursor: "<ms>.<id>" of the last row shown. The next page is everything older by (time, _id), newest first,
// so rows that share a millisecond are neither skipped nor shown twice. `field`: the row's time ("startedAt", "at").
const CURSOR = /^(\d{1,15})\.([0-9a-f]{24})$/;
const cursorOf = (row, field) => `${new Date(row[field]).getTime()}.${row._id}`;
// The cursor's time, or null for none / a malformed one (which reads as the first page).
const cursorTime = (cursor) => {
  const m = CURSOR.exec(String(cursor || ""));
  return m ? new Date(Number(m[1])) : null;
};
function olderThan(cursor, field) {
  const m = CURSOR.exec(String(cursor || ""));
  if (!m) return {};
  const t = new Date(Number(m[1]));
  return { $or: [{ [field]: { $lt: t } }, { [field]: t, _id: { $lt: new mongoose.Types.ObjectId(m[2]) } }] };
}

// One page: up to `limit` rows (a lean query sorted newest first by `field`, then _id), and the cursor for the next
// page (null at the end). `find(filter)` builds the query.
async function page(find, { field, before, limit }) {
  const rows = await find(olderThan(before, field)).sort({ [field]: -1, _id: -1 }).limit(limit + 1).lean();
  const more = rows.length > limit;
  if (more) rows.pop();
  return { rows, next: more ? cursorOf(rows[rows.length - 1], field) : null };
}

// The day a date falls on in `timeZone` ("YYYY-MM-DD"), computed by the database (the Node twin: lib/timezone.js dayIn).
const dayExpr = (field, timeZone) => ({ $dateToString: { format: "%Y-%m-%d", date: field, timezone: timeZone } });

module.exports = { page, cursorTime, dayExpr };
