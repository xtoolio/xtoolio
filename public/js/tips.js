// THE TOOLTIP KEPT ON THE SCREEN: every [data-tip] is drawn by CSS alone (app.css), centred over its element (an (i)
// starts a little left of its icon). Near the window's edge that runs off it: the page switch's (i) at a title row's
// right. As the pointer or the focus reaches one, this measures where it would show and, if it would cross an edge,
// sets data-tip-at="end" (it grows leftward from the element's right edge) or "start" (rightward from its left);
// app.css places it. The sidebar's folded labels show to the side and are left alone.
"use strict";

(function () {
  var MARGIN = 8;
  var canvas = document.createElement("canvas").getContext("2d");
  // The tooltip's width as app.css draws it: its text at 12px / 500 plus padding, capped where it wraps.
  function widthOf(el) {
    canvas.font = "500 12px " + getComputedStyle(el).fontFamily;
    var text = canvas.measureText(el.getAttribute("data-tip") || "").width;
    var info = el.classList.contains("info-tip");
    var wraps = info ? 240 : el.classList.contains("tip-wide") ? 280 : el.classList.contains("nav-count") ? 170 : Infinity;
    return Math.min(text + (info || el.classList.contains("tip-wide") ? 20 : 18), wraps);
  }
  function place(e) {
    var el = e.target.closest && e.target.closest("[data-tip]");
    if (!el || el.classList.contains("side-link") || el.classList.contains("tip-end") || el.classList.contains("tip-start")) return;
    var r = el.getBoundingClientRect();
    var w = widthOf(el);
    var left = el.classList.contains("info-tip") ? r.left - 60 : r.left + r.width / 2 - w / 2;
    var at = left + w > window.innerWidth - MARGIN ? "end" : left < MARGIN ? "start" : null;
    if (at) el.setAttribute("data-tip-at", at);
    else el.removeAttribute("data-tip-at");
  }
  document.addEventListener("pointerover", place, true);
  document.addEventListener("focusin", place, true);
})();
