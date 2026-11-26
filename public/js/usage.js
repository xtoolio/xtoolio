// The Usage page (views/usage.hbs). Two things, both read-only:
//   1. the chart's readout says the bar under the pointer (partials/spend-chart.hbs: each slot's data-say), and its
//      resting line (today, the window's total) when the pointer leaves;
//   2. the table loads its next page as its foot nears the screen: GET /usage/rows?before=<cursor> answers the rows,
//      drawn by the page's own partial (views/partials/usage-rows.hbs), and the cursor after them. This file never
//      builds a row.
// Without script: the Day / Week / Month switch still works (CSS radios), each bar has its native tooltip, and "Older"
// opens the next page.
"use strict";

(function () {
  document.querySelectorAll("[data-spend]").forEach(function (panel) {
    var rest = panel.querySelector("[data-spend-rest]");
    var say = panel.querySelector("[data-spend-say]");
    if (!rest || !say) return;
    function show(slot) {
      say.hidden = !slot;
      rest.hidden = !!slot;
      if (slot) say.textContent = slot.getAttribute("data-say");
    }
    panel.addEventListener("pointerover", function (e) { show(e.target.closest && e.target.closest(".spend-slot")); });
    panel.addEventListener("pointerleave", function () { show(null); });
  });

  var more = document.querySelector("[data-usage-more]");
  var body = document.querySelector("[data-usage-rows]");
  if (!more || !body || !("IntersectionObserver" in window)) return;
  var link = more.querySelector("a");
  var next = more.getAttribute("data-next");
  var busy = false;
  var MARGIN = 600;

  // Shown, too: a hidden element measures at the top (near).
  function near() { return more.isConnected && more.offsetParent !== null && more.getBoundingClientRect().top < window.innerHeight + MARGIN; }

  function load() {
    if (busy || !next) return;
    busy = true;
    fetch("/usage/rows?before=" + encodeURIComponent(next), { headers: { Accept: "application/json" }, credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error(String(r.status))); })
      .then(function (data) {
        if (!data || !data.ok) throw new Error("bad answer");
        var t = document.createElement("template");
        t.innerHTML = data.html || "";
        body.appendChild(t.content);
        next = data.next;
        if (!next) { io.disconnect(); more.remove(); return true; }
        if (link) link.href = "/usage?before=" + encodeURIComponent(next);
        return true;
      })
      .catch(function () { return false; /* the Older link stays; scrolling back to it tries again */ })
      .then(function (landed) {
        busy = false;
        // A tall screen can still show the foot after a page lands: the observer won't fire again by itself. Never
        // after a failure (that would retry in a loop).
        if (landed && next && near()) load();
      });
  }

  var io = new IntersectionObserver(function (entries) {
    if (entries.some(function (e) { return e.isIntersecting; })) load();
  }, { rootMargin: MARGIN + "px" });
  io.observe(more);
})();
