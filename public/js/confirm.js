// THE CLICK-AGAIN CONFIRM: two deliberate clicks, the first saying what the second will do, ONLY for a press over a
// WHOLE Inbox view (the rail's Everyone / Every post, and the toolbar's ♥ Like N and Mark N done with nobody and no
// post picked): everything scoped to a person, a post or a card is one click (double clicks there were confusing).
// Any button
// with data-confirm="Click again to …": the first click sends nothing, it arms the button and says data-confirm beside
// it (app.css .armed); a second click on the same button within a few seconds goes through as a normal click (a
// form's submit, which post-actions.js / busy.js take from there). A click anywhere else, Esc, or the wait running out
// disarms it. In the capture phase, so it runs before any other click handler. Without script the button just works.
"use strict";

(function () {
  var ARMED_MS = 4000;
  var armed = null;
  var timer = null;
  var label = null;

  function disarm() {
    clearTimeout(timer);
    if (!armed) return;
    armed.classList.remove("armed");
    if (label === null) armed.removeAttribute("aria-label");
    else armed.setAttribute("aria-label", label);
    armed = null;
  }

  document.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest("[data-confirm]");
    if (btn && btn === armed) return disarm(); // the second, deliberate click: let it through
    disarm();
    if (!btn || btn.disabled) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    armed = btn;
    label = btn.getAttribute("aria-label");
    btn.setAttribute("aria-label", btn.getAttribute("data-confirm")); // what a screen reader hears on the armed button
    btn.classList.add("armed");
    timer = setTimeout(disarm, ARMED_MS);
  }, true);

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") disarm();
  });
})();
