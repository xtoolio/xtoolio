// Pictures from X that fail to load (X changed the URL, the account or post is gone) are removed instead of showing
// a broken-image icon: a profile picture leaves its initial showing underneath; a post's picture takes its whole
// tile with it. This replaces an inline onerror= handler, which the strict CSP (script-src 'self') blocks.
//
// Two halves, because an image can fail before or after this deferred script runs:
//   - a capture-phase listener (error events don't bubble) for the ones that fail later;
//   - a sweep for the ones that already failed (complete, but nothing decoded).
"use strict";

(function () {
  function drop(img) {
    if (!img || img.tagName !== "IMG" || !img.parentElement) return;
    var parent = img.parentElement;
    if (parent.classList.contains("avatar")) img.remove();
    else if (parent.classList.contains("like-thumb")) parent.remove();
    else if (img.closest(".post-media .pm")) img.closest(".pm").remove(); // its whole tile (the image sits in its .pm-open button; previously only a quote card's tile went)
  }

  document.addEventListener(
    "error",
    function (e) {
      drop(e.target);
    },
    true
  );

  document.querySelectorAll(".avatar img, .pm img, .like-thumb img").forEach(function (img) {
    if (img.complete && img.naturalWidth === 0 && img.getAttribute("src")) drop(img);
  });
})();
