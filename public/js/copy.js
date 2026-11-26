// Copy buttons (views/partials/handle.hbs: "@handle", for an X search; your circle's link and "Copy all N handles"): a
// click puts the button's data-copy on the clipboard and the button says "Copied" for a moment (.copied: a bubble over
// an icon button, the label itself on a text one, .copy-text). The click stops here, so it never opens the post it sits on.
"use strict";

(function () {
  function fallback(text) {
    var t = document.createElement("textarea");
    t.value = text;
    t.setAttribute("readonly", "");
    t.className = "sr-only";
    document.body.appendChild(t);
    t.select();
    try { document.execCommand("copy"); } finally { t.remove(); }
  }

  document.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest("[data-copy]");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    var text = btn.getAttribute("data-copy");
    var done = function () {
      btn.classList.add("copied");
      setTimeout(function () { btn.classList.remove("copied"); }, 1400);
    };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, function () { fallback(text); done(); });
    else { fallback(text); done(); }
  });
})();
