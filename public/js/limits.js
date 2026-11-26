// THE COUNTDOWN in the header (views/partials/limits.hbs), folded behind a stopwatch: each X write window being counted
// down, what's left of it and how long until it resets ("Likes 4/50 · resets in 12:34"; red when spent). Ticks every
// second; an entry goes when its time is up, the stopwatch is red while any is spent, and the whole thing hides when
// none is left. USED UP IS NOT AN ERROR: a window you spend to its last write (a Likestorm of 50) turns it red,
// quietly; only X REFUSING a write for its limit (a toast of kind "limit", lib/notices.js: toast.js calls `hit`, and a
// page drawn with one, [data-toast][data-limit]) shakes it and drops the panel open. (Until then it shook and dropped
// open whenever a window reached zero, so a storm that went fine ended on "X's limit reached".) window.xtoolioLimits.set(list) redraws it from the server's list (public/js/live.js, on LiveEvent
// "limits": [{ words, left, max, ends }]), so it moves with each press on every open tab. The clock's format is
// lib/writeLimits.js countdown's. The panel is THE DROPDOWN (public/js/dropdown.js closes it on a click outside it or Esc).
"use strict";

(function () {
  var box = document.querySelector("[data-limits]");
  if (!box) return;
  var list = box.querySelector("[data-limits-list]");
  var timer = null;

  function countdown(ends) {
    var s = Math.max(0, Math.ceil((ends - Date.now()) / 1000));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = String(s % 60);
    if (ss.length < 2) ss = "0" + ss;
    return h ? h + ":" + (m < 10 ? "0" : "") + m + ":" + ss : m + ":" + ss;
  }
  function tick() {
    list.querySelectorAll("[data-ends]").forEach(function (el) {
      var ends = parseInt(el.getAttribute("data-ends"), 10);
      if (!(ends > Date.now())) return el.remove();
      el.querySelector("[data-clock]").textContent = countdown(ends);
    });
    var any = !!list.querySelector("[data-ends]");
    box.hidden = !any;
    if (!any) box.open = false;
    // Spent: the stopwatch is red, quietly (the panel says when it resets).
    box.classList.toggle("spent", !!list.querySelector(".limit.spent"));
    if (!any && timer) { clearInterval(timer); timer = null; }
    if (any && !timer) timer = setInterval(tick, 1000);
  }
  // From the server (anything X says goes in as text, never markup).
  window.xtoolioLimits = {
    set: function (limits) {
      list.querySelectorAll("[data-ends]").forEach(function (el) { el.remove(); });
      (limits || []).forEach(function (l) {
        var el = document.createElement("span");
        el.className = "limit" + (l.left > 0 ? "" : " spent");
        el.setAttribute("data-ends", String(l.ends));
        el.appendChild(document.createTextNode((l.words || "") + " "));
        var n = document.createElement("b");
        n.textContent = String(l.left || 0);
        el.appendChild(n);
        el.appendChild(document.createTextNode("/" + (l.max || "") + " · resets in "));
        var b = document.createElement("b");
        b.setAttribute("data-clock", "");
        el.appendChild(b);
        list.appendChild(el);
      });
      tick();
    },
    // X refused a write for its limit: THE shake (the sidebar's counts' own) and the panel open, saying when it resets.
    hit: function () {
      if (box.hidden) return;
      var btn = box.querySelector(".limits-btn");
      btn.classList.remove("shake");
      void btn.offsetWidth; // restart the animation
      btn.classList.add("shake");
      box.open = true;
    },
  };
  tick();
  if (document.querySelector("[data-toast][data-limit]")) window.xtoolioLimits.hit(); // a page drawn with one
})();
