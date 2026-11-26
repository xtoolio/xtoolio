// Long posts fold to a few lines with "Show more" / "Show less",
// wherever posts show (the Inbox, a conversation: partials/topic-post.hbs and bubble.hbs). Only a post
// that actually runs past the fold gets the button: each one is measured folded, and one that fits is left alone.
// Without script nothing folds, so every word still shows. The fold itself is CSS (.text.folded in app.css).
"use strict";

(function () {
  // The fold is the text's own limit when it has one: a quote card's words are already `.clamp` (4 lines), so its
  // "Show more" lifts THAT, not a 6-line fold laid over it (which made opening one show fewer lines). → the
  // class the button toggles, on the button (data-fold).
  function fold(text) {
    var cls = text.classList.contains("clamp") ? "clamp" : "folded";
    text.classList.add(cls);
    if (text.scrollHeight - text.clientHeight < 4) {
      if (cls === "folded") text.classList.remove("folded"); // it fits
      return;
    }
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "more-btn";
    btn.textContent = "Show more";
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("data-fold", cls);
    text.insertAdjacentElement("afterend", btn);
  }
  // The page's posts, and the ones a search swaps in ("app:swapped": public/js/search.js).
  var foldIn = function (root) { Array.prototype.forEach.call(root.querySelectorAll(".seed-post .text, .bubble .text"), fold); };
  foldIn(document);
  document.addEventListener("app:swapped", function (e) { foldIn(e.detail.root); });

  document.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest(".more-btn");
    if (!btn) return;
    var open = !btn.previousElementSibling.classList.toggle(btn.getAttribute("data-fold") || "folded");
    btn.textContent = open ? "Show less" : "Show more";
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  });
})();
