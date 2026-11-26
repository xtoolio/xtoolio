// THE DROPDOWN: any <details data-dropdown> (the header's stopwatch, views/partials/limits.hbs; the ↻'s Repost / Quote
// menu, views/partials/repost-button.hbs). The <details> opens and closes by itself without script; this closes it on
// a click anywhere outside it, on a choice inside it (a link or a button in its panel), or Esc, and keeps one open at
// a time. A click inside that isn't a choice (the stopwatch's list) leaves it open.
"use strict";

(function () {
  function closeAll(except) {
    document.querySelectorAll("details[data-dropdown][open]").forEach(function (d) {
      if (d !== except) d.open = false;
    });
  }
  document.addEventListener("click", function (e) {
    var box = e.target.closest && e.target.closest("details[data-dropdown]");
    closeAll(box);
    if (!box) return;
    var choice = e.target.closest("a[href], button");
    // After the choice has done its work (a form's submit, post-actions.js's own click handlers): close it.
    if (choice && !e.target.closest("summary")) setTimeout(function () { box.open = false; }, 0);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeAll(null);
  });
})();
