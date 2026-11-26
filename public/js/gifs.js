// GIFs play (they used to show as still pictures): every animated GIF is drawn
// as X's own looping MP4 (views/partials/media-pic.hbs, `video[data-gif]`, preload none, its preview frame the poster).
// It loads and plays only while it's on screen and pauses when it leaves, so a page of GIFs (or the 📎 panel's grid)
// fetches only what you look at. Under reduced motion none plays by itself; a press on one plays or pauses it. GIFs
// that arrive later (a streamed card, a sent reply, the 📎 panel's grid) are picked up as they're added.
"use strict";

(function () {
  var still = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var seen = typeof WeakSet === "function" ? new WeakSet() : null;
  var io = !still && "IntersectionObserver" in window
    ? new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          var v = e.target;
          if (e.isIntersecting) play(v);
          else if (!v.paused) v.pause();
        });
      }, { rootMargin: "200px 0px" })
    : null;

  function play(v) {
    v.muted = true; // the attribute alone isn't always the property when inserted by script; autoplay needs it muted
    var p = v.play();
    if (p && p.catch) p.catch(function () {}); // refused (a power saver): the still frame stays
  }
  function watch(root) {
    var list = root.matches && root.matches("video[data-gif]") ? [root] : root.querySelectorAll ? root.querySelectorAll("video[data-gif]") : [];
    Array.prototype.forEach.call(list, function (v) {
      if (seen) { if (seen.has(v)) return; seen.add(v); }
      if (io) io.observe(v);
    });
  }

  watch(document);
  if ("MutationObserver" in window) {
    new MutationObserver(function (records) {
      records.forEach(function (r) { Array.prototype.forEach.call(r.addedNodes, function (n) { if (n.nodeType === 1) watch(n); }); });
    }).observe(document.body, { childList: true, subtree: true });
  }
  // Reduced motion: a press on a GIF plays or pauses it (only where the press isn't already something else's: a
  // 📎 tile adds it, a Media tile opens the post).
  if (still) {
    document.addEventListener("click", function (e) {
      var v = e.target.closest && e.target.closest("video[data-gif]");
      if (!v || v.closest("a, button")) return;
      if (v.paused) play(v); else v.pause();
    });
  }
  // A hidden tab plays nothing; back in view, what's on screen resumes (the observer doesn't fire again for it).
  document.addEventListener("visibilitychange", function () {
    Array.prototype.forEach.call(document.querySelectorAll("video[data-gif]"), function (v) {
      if (document.hidden) { if (!v.paused) v.pause(); return; }
      var r = v.getBoundingClientRect();
      if (io && r.bottom > 0 && r.top < window.innerHeight && r.width) play(v);
    });
  });
})();
