// THE SIDEBAR (views/partials/side-nav.hbs). Without this file it all still works: the fold is a form (POST /nav, back
// to the page), the phone's drawer a checkbox (#nav-open) its ☰ and scrim toggle. This adds:
//   the fold in place: <body> folds at once (.nav-collapsed) and the choice is saved in the background (204); if the
//     save fails, it unfolds again, so the page never shows a state the next page won't;
//   Esc closes the drawer;
//   a page's tab bar (.seg-tabs) that scrolls sideways (Follows' four tabs on a phone) starts with its current tab in
//     view (the bar alone scrolls, never the page).
// The ☰'s dot follows the counts in public/js/live.js (navSums), where they move.
"use strict";

(function () {
  var tabsInView = function (root) {
    root.querySelectorAll(".seg-tabs").forEach(function (bar) {
      var on = bar.querySelector(".on");
      if (on && bar.scrollWidth > bar.clientWidth) bar.scrollLeft = Math.max(0, on.offsetLeft + on.offsetWidth - bar.clientWidth + 8);
    });
  };
  tabsInView(document);
  document.addEventListener("app:swapped", function (e) { tabsInView(e.detail.root); }); // a search's fresh tabs (search.js)

  var fold = document.querySelector("[data-nav-fold]");
  if (fold) {
    fold.addEventListener("submit", function (e) {
      if (!window.fetch) return;
      e.preventDefault();
      var input = fold.elements.collapsed;
      var collapse = input.value === "1";
      function show(folded) {
        document.body.classList.toggle("nav-collapsed", folded);
        input.value = folded ? "0" : "1";
        var btn = fold.querySelector("button");
        var say = folded ? "Open the sidebar" : "Fold the sidebar";
        btn.setAttribute("data-tip", say);
        btn.setAttribute("aria-label", say);
      }
      show(collapse);
      var body = new URLSearchParams();
      body.set("_csrf", fold.elements._csrf.value);
      body.set("collapsed", collapse ? "1" : "0");
      fetch(fold.action, { method: "POST", credentials: "same-origin", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() })
        .then(function (r) { if (!r.ok) throw new Error(String(r.status)); })
        .catch(function () { show(!collapse); });
    });
  }

  var open = document.getElementById("nav-open");
  if (open) {
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && open.checked) open.checked = false;
    });
  }
})();
