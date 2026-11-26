// The one Handlebars setup: web.js serves with it, and any offline render (lib/mark.js, the verify scripts) uses the
// same helpers and partials so previews can't drift.
const path = require("path");
const { ASSET_V } = require("./assetVersion");
const { DEFAULT_ZONE } = require("./timezone");
const { displayNameOf } = require("../services/people");
const { webHref } = require("../services/text");

const views = path.join(__dirname, "..", "views");
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

// Dates are written in the viewer's time zone (lib/timezone.js): web.js puts it in res.locals.timeZone, which
// reaches every helper as the render's root (partials and #each blocks keep it). An offline render has none: UTC.
const zoneOf = (options) => (options && options.data && options.data.root && options.data.root.timeZone) || DEFAULT_ZONE;

// The formatters for one zone, made once (a person page formats hundreds of dates per render). At most one entry
// per IANA zone, so the cache is bounded.
const formatters = new Map();
function fmt(tz) {
  let f = formatters.get(tz);
  if (!f) {
    const zoned = (opts) => new Intl.DateTimeFormat("en-US", { ...opts, timeZone: tz });
    f = {
      year: zoned({ year: "numeric" }),
      day: zoned({ month: "short", day: "numeric" }),
      dayYear: zoned({ month: "short", day: "numeric", year: "numeric" }),
      clock: zoned({ hour: "numeric", minute: "2-digit" }),
    };
    formatters.set(tz, f);
  }
  return f;
}

// Month and day this year ("Mon D"), with the year otherwise ("Mon D, YYYY"); "this year" as the viewer's calendar has it.
function dayLabel(d, tz) {
  const f = fmt(tz);
  const t = new Date(d);
  return f.year.format(t) === f.year.format(new Date()) ? f.day.format(t) : f.dayYear.format(t);
}

module.exports = {
  extname: ".hbs",
  defaultLayout: "main",
  layoutsDir: path.join(views, "layouts"),
  partialsDir: path.join(views, "partials"),
  // Never indent a partial's output. Handlebars indents every line of a partial called alone on an indented line, and
  // a post's text keeps its line breaks (white-space: pre-wrap), so each paragraph after the first came out indented:
  // `{{> thread}}` on its own line indented every multi-line post on the Inbox by 6 spaces.
  compilerOptions: { preventIndent: true },
  helpers: {
    // Every /js and /css URL carries ?v={{assetV}}, so web.js can cache it as immutable (lib/assetVersion.js).
    assetV: () => ASSET_V,
    // "just now", "5 min ago", "3 h ago", then a date.
    ago: (d, options) => {
      if (!d) return "";
      const min = Math.round((Date.now() - new Date(d).getTime()) / 60000);
      if (min < 1) return "just now";
      if (min < 60) return `${min} min ago`;
      if (min < 24 * 60) return `${Math.round(min / 60)} h ago`;
      return dayLabel(d, zoneOf(options));
    },
    // Short relative time, X-style: "now", "12m", "5h", "3d", then a date (chat bubbles). {{rel d always=true}} stays
    // relative however old: "3w", "4mo", "2y" (the leaderboard's Last, a conversation's last activity).
    rel: (d, options) => {
      if (!d) return "";
      const min = Math.floor((Date.now() - new Date(d).getTime()) / 60000);
      if (min < 1) return "now";
      if (min < 60) return `${min}m`;
      if (min < 24 * 60) return `${Math.floor(min / 60)}h`;
      if (min < 7 * 24 * 60) return `${Math.floor(min / 1440)}d`;
      if (!(options && options.hash && options.hash.always)) return dayLabel(d, zoneOf(options));
      const days = Math.floor(min / 1440);
      if (days < 60) return `${Math.floor(days / 7)}w`;
      if (days < 365) return `${Math.floor(days / 30)}mo`;
      return `${Math.floor(days / 365)}y`;
    },
    shortDate: (d, options) => (d ? dayLabel(d, zoneOf(options)) : ""),
    // An address from X that may become a link: http(s) only, else nothing (services/text.js webHref, THE rule).
    webHref: (u) => webHref(u),
    // Time of day, "7:42 PM": rows already grouped under their day (the Usage page).
    clock: (d, options) => (d ? fmt(zoneOf(options)).clock.format(new Date(d)) : ""),
    add: (a, b) => a + b,
    compact: (n) => (typeof n === "number" ? compact.format(n) : ""),
    count: (n) => (typeof n === "number" ? n.toLocaleString("en-US") : ""),
    // A place in a line: "2nd", "3rd", "11th", "12th", "21st", "1,000th".
    ordinal: (n) => {
      if (typeof n !== "number") return "";
      const teen = n % 100 >= 11 && n % 100 <= 13;
      return `${n.toLocaleString("en-US")}${teen ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th"}`;
    },
    // A balance, said exactly: "$0.34", "$12.50", "−$0.02" (one unit may overshoot zero).
    dollars: (n) => {
      const v = typeof n === "number" ? n : 0;
      return `${v < -0.005 ? "−" : ""}$${Math.abs(v).toFixed(2)}`;
    },
    // What something cost, precise enough to compare small runs: "$1.37", "$0.78", "$0.042" (a sync of a few new
    // posts costs fractions of a cent, which dollars would round to $0.00). Nothing: "$0", or "–" with dash=true (a
    // table cell: a column of $0s reads as noise; the runs that cost something stand out).
    cost: (n, options) => (typeof n !== "number" || !n ? (options && options.hash && options.hash.dash ? "–" : "$0") : n >= 0.1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`),
    // A price per item, exact to the tenth of a cent, no trailing zeros past the cents: "$0.001", "$0.0015", "$0.015",
    // "$0.01", "$0.20" (never "$0.2").
    rate: (usd) => {
      if (typeof usd !== "number") return "";
      const s = usd.toFixed(4).replace(/0+$/, "");
      return `$${s.split(".")[1].length < 2 ? usd.toFixed(2) : s}`;
    },
    // Micro-dollars (the billing ledger's unit) as money, precise enough for a sync that cost a fraction of a cent:
    // "$25.00", "$0.42", "$0.042", "$0.0042". {{money n true}} signs it: "+$25.00", "−$0.004".
    money: (micros, signed) => {
      const usd = (Number(micros) || 0) / 1e6;
      const a = Math.abs(usd);
      const s = a >= 0.1 ? a.toFixed(2) : a >= 0.01 ? a.toFixed(3) : a ? a.toFixed(4) : "0";
      return `${usd < 0 ? "−" : signed === true && usd > 0 ? "+" : ""}$${s}`;
    },
    plural: (n, one, many) => (n === 1 ? one : many),
    // Data for a page's script, in an attribute (partials/owed-model.hbs): a plain string, so Handlebars escapes it
    // like any other (the browser hands the script the JSON back); never markup.
    json: (v) => JSON.stringify(v === undefined ? null : v),
    eq: (a, b) => a === b,
    gt: (a, b) => a > b,
    or: (...args) => args.slice(0, -1).some(Boolean), // the last argument is Handlebars' options
    // Anyone shaped { id, username, profile } (services/people.js identify): the one rule, people.displayNameOf.
    displayName: (p) => displayNameOf(p),
    // The letter an avatar falls back to when there's no picture (or it 404s).
    initial: (name, username) => {
      const s = String(name || username || "").replace(/^[^\p{L}\p{N}]+/u, "");
      return s ? [...s][0].toUpperCase() : "?";
    },
  },
};
