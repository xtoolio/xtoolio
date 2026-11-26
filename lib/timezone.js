// Time zones. Every date the server writes out (a short date, a time of day, whether a date needs its year)
// is in the account's zone (Account.timeZone), never the machine's: deployed, the machine runs in UTC, and a reply
// you sent at 9pm would show the next day's date.
//
// The zone comes from the browser at sign-in (public/js/timezone.js fills the sign-in form's hidden `tz`; the
// callback saves it only when the account has none yet) or from the Time zone row in Settings. Unset = UTC.
"use strict";

const DEFAULT_ZONE = "UTC";
// Every IANA zone this runtime knows (Node lists ~420, without "UTC" itself), for the Settings picker.
const ZONES = [DEFAULT_ZONE, ...Intl.supportedValuesOf("timeZone")];
const KNOWN = new Set(ZONES);

// A zone from a form or a query string → its canonical name, or null. Aliases resolve ("Asia/Kolkata" and
// "Asia/Calcutta" are one zone; ICU names it the latter), so a browser's answer always matches a picker option.
// Fixed offsets ("+05:00") are refused: they ignore daylight saving, and browsers report a named zone anyway.
function zoneFor(input) {
  if (typeof input !== "string" || !input || input.length > 64) return null;
  try {
    const canonical = new Intl.DateTimeFormat("en-US", { timeZone: input }).resolvedOptions().timeZone;
    return KNOWN.has(canonical) ? canonical : null;
  } catch {
    return null;
  }
}

// The day a date falls on in a zone, "YYYY-MM-DD" (the Usage page's days, its chart, a statement's). One formatter
// per call: make it once per render and reuse it. (The database's twin, for days summed there: lib/feedCursor.js dayExpr.)
function dayIn(timeZone = DEFAULT_ZONE) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return (d) => f.format(new Date(d));
}

module.exports = { DEFAULT_ZONE, ZONES, zoneFor, dayIn };
