// A <select data-auto-submit> or <input type="checkbox" data-auto-submit> submits its form as soon as it changes: the
// leaderboard's sort, every dropdown in the Settings panel (each saves itself; the toast says it took), and the module
// picker (the front page's cost estimate, the start page). Without this script, each form shows its own button
// (<noscript>) or works on Enter.
//
// A GET form marked data-swap (the module picker) doesn't reload the page: it fetches the same page for the new choices
// and puts its fresh [data-swap-part] elements (matched by id) in place of the old ones, then updates the address. A
// reload scrolled back to the picker's anchor on every switch, so the screen jumped. Only
// the newest answer is used when switches are pressed quickly; any failure falls back to the plain submit. Listeners
// are on the document, so swapped-in fields work too; other scripts redraw their bits on "app:swapped" (timezone.js).
"use strict";

(function () {
  var latest = 0;

  function swap(form) {
    var url = new URL(form.getAttribute("action") || location.pathname, location.href);
    url.search = new URLSearchParams(new FormData(form)).toString();
    url.hash = "";
    var active = document.activeElement;
    var focusName = active && active.form === form && active.name ? active.name : null;
    var mine = ++latest;
    fetch(url.pathname + url.search, { credentials: "same-origin", headers: { Accept: "text/html" } })
      .then(function (res) {
        if (!res.ok) throw new Error(res.status);
        return res.text();
      })
      .then(function (html) {
        if (mine !== latest) return; // a newer press is on its way
        var doc = new DOMParser().parseFromString(html, "text/html");
        if (!window.xtoolioSameAccount(doc)) throw new Error("another account"); // swap.js: the plain submit
        document.querySelectorAll("[data-swap-part]").forEach(function (old) {
          var fresh = old.id && doc.getElementById(old.id);
          if (!fresh) return;
          var node = document.importNode(fresh, true);
          old.replaceWith(node);
          document.dispatchEvent(new CustomEvent("app:swapped", { detail: { root: node } }));
        });
        history.replaceState(history.state, "", url.pathname + url.search + location.hash);
        var again = focusName && document.querySelector('form[data-swap] [name="' + focusName.replace(/"/g, "") + '"]');
        if (again) again.focus({ preventScroll: true });
      })
      .catch(function () {
        if (mine === latest) form.submit(); // the plain way: a reload with the choices
      });
  }

  document.addEventListener("change", function (e) {
    var el = e.target;
    if (!el.matches || !el.matches("[data-auto-submit]") || !el.form) return;
    if (el.form.hasAttribute("data-swap")) return swap(el.form);
    el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit();
  });

  // The picker's own submits (its Estimate button, Enter in the handle box) swap too.
  document.addEventListener("submit", function (e) {
    var form = e.target;
    if (!form.hasAttribute || !form.hasAttribute("data-swap") || (form.method || "get").toLowerCase() !== "get") return;
    e.preventDefault();
    swap(form);
  });
})();
