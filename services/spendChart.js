// THE USAGE CHART (views/usage.hbs, web.js usageView): money per day as bars, three ways, each a fixed window ending
// today: the last 30 days, the last 13 weeks (Monday first), the last 12 months. Fixed, so a new account's first days
// sit at the right edge where they belong, and the windows fill in over time. It carries what the day lines of the
// table used to (the Today figure moved from the top of the page into the chart area):
// today, this week, this month, at rest above the bars; any bucket on hover.
//
// Pure. `days`: [{ day: "YYYY-MM-DD" in the viewer's zone, micros, estimated }] (any order, gaps allowed); `today`: that
// zone's "YYYY-MM-DD". Geometry for the SVG (the CSP allows no style=""): one unit per slot and 100 high, drawn with
// preserveAspectRatio="none" so the bars fill any width while the labels are HTML text at their own size.
"use strict";

const DAY_MS = 24 * 3600 * 1000;
const toDate = (day) => new Date(`${day}T00:00:00Z`);
const toDay = (d) => d.toISOString().slice(0, 10);
const shift = (day, n) => toDay(new Date(toDate(day).getTime() + n * DAY_MS));
const fmt = (opts) => new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" });
const MD = fmt({ month: "short", day: "numeric" });
const MON = fmt({ month: "short" });
const MONTH_YEAR = fmt({ month: "long", year: "numeric" });
const MONTH = fmt({ month: "long" });
const mondayOf = (day) => shift(day, -((toDate(day).getUTCDay() + 6) % 7));
const monthOf = (day) => `${day.slice(0, 7)}-01`;
const prevMonth = (first) => {
  const d = toDate(first);
  return toDay(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)));
};

// The three views: how many buckets, the bucket a day falls in, each bucket's words. `every`: one axis label per this
// many buckets, counted from the newest, so today's is always labelled.
const VIEWS = [
  { key: "day", label: "Day", n: 30, every: 5, bucketOf: (d) => d, back: (b) => shift(b, -1), short: (b) => MD.format(toDate(b)), full: (b) => MD.format(toDate(b)), now: "Today", span: "Last 30 days" },
  { key: "week", label: "Week", n: 13, every: 3, bucketOf: mondayOf, back: (b) => shift(b, -7), short: (b) => MD.format(toDate(b)), full: (b) => `Week of ${MD.format(toDate(b))}`, now: "This week", span: "Last 13 weeks" },
  { key: "month", label: "Month", n: 12, every: 1, bucketOf: monthOf, back: prevMonth, short: (b) => MON.format(toDate(b)), full: (b) => MONTH_YEAR.format(toDate(b)), now: null, span: "Last 12 months" },
];

const BAR = 0.64; // of a slot; the rest is the gap

function spendChart(days, today) {
  const panels = VIEWS.map((v) => {
    const keys = [v.bucketOf(today)];
    while (keys.length < v.n) keys.unshift(v.back(keys[0]));
    const at = new Map(keys.map((k, i) => [k, i]));
    const sums = keys.map(() => ({ micros: 0, estimated: false }));
    for (const d of days) {
      const i = at.get(v.bucketOf(d.day));
      if (i === undefined || d.day > today) continue;
      sums[i].micros += d.micros || 0;
      if (d.estimated && d.micros) sums[i].estimated = true;
    }
    const peak = Math.max(0, ...sums.map((s) => s.micros));
    const last = keys.length - 1;
    const bars = keys.map((k, i) => {
      const s = sums[i];
      // A bar that cost something stays visible however small beside the peak.
      const h = s.micros > 0 ? Math.max(1.5, +((s.micros / peak) * 100).toFixed(2)) : 0;
      return { x: +(i + (1 - BAR) / 2).toFixed(3), slot: i, w: BAR, y: +(100 - h).toFixed(2), h, micros: s.micros, estimated: s.estimated, label: v.full(k), axis: (last - i) % v.every === 0 ? v.short(k) : "", now: i === last };
    });
    return {
      key: v.key,
      label: v.label,
      n: v.n,
      bars,
      peak,
      now: { label: v.now || MONTH.format(toDate(keys[last])), micros: sums[last].micros, estimated: sums[last].estimated },
      span: { label: v.span, micros: sums.reduce((n, s) => n + s.micros, 0), estimated: sums.some((s) => s.estimated) },
      empty: peak === 0,
    };
  });
  return { panels, empty: panels.every((p) => p.empty) };
}

// The first day the chart can show (the month view's oldest month): what to ask the database for.
function chartSince(today) {
  let first = monthOf(today);
  for (let i = 1; i < VIEWS[2].n; i++) first = prevMonth(first);
  return first;
}

module.exports = { spendChart, chartSince };
