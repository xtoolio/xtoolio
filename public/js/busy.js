// A form that takes a moment (a full page submit the server works through, like "Mark all done") says so: once sent,
// its submit buttons, inside it or pointing at it with form="…", are disabled, and the primary one (.pill) or the one
// you pressed spins (the same .busy as the reply box; "Mark all done" on one card is sent straight
// from its own button, with no question first). Opt in with <form data-busy>. Disabling after the submit event has
// started doesn't cancel the submit. A page restored from the back/forward cache comes back usable.
//
// And THE PAGE-LOADING BAR (layouts/main.hbs [data-nav-progress]: a thin bar across the bottom of the
// header while a page loads): a full page load is ONE signal for every door (the sidebar, cards, a form): the page
// starting to leave (beforeunload). A view swapped in place (post-actions.js VIEWS IN PLACE, search.js) turns the
// same bar on and off itself. The bar shows only past a short delay (CSS: a fast page never flashes it) and creeps toward the end
// until the next page replaces this one; back from the back/forward cache, it's gone.
"use strict";

(function () {
  var bar = document.querySelector("[data-nav-progress]");
  if (bar) {
    window.addEventListener("beforeunload", function () { bar.classList.add("on"); });
    window.addEventListener("pageshow", function () { bar.classList.remove("on"); });
  }

  function buttonsOf(form) {
    var inside = Array.prototype.slice.call(form.querySelectorAll("button[type=submit], button:not([type])"));
    var outside = form.id ? Array.prototype.slice.call(document.querySelectorAll('button[form="' + form.id + '"]')) : [];
    return inside.concat(outside);
  }
  document.addEventListener("submit", function (e) {
    var form = e.target;
    if (!form.hasAttribute || !form.hasAttribute("data-busy") || e.defaultPrevented) return;
    // After this submit is under way (a timeout 0 would also work; this keeps the order clear).
    buttonsOf(form).forEach(function (b) {
      b.disabled = true;
      b.setAttribute("aria-busy", "true");
      if (b.classList.contains("pill") || b === e.submitter) b.classList.add("busy");
    });
  });
  window.addEventListener("pageshow", function (e) {
    if (!e.persisted) return;
    Array.prototype.forEach.call(document.querySelectorAll("form[data-busy]"), function (form) {
      buttonsOf(form).forEach(function (b) {
        b.disabled = false;
        b.removeAttribute("aria-busy");
        b.classList.remove("busy");
      });
    });
  });
})();
