// THE TOUR on the front page (views/landing.hbs, [data-tour]): the use cases pick their page by themselves (labels for
// radios, CSS only). This only moves on to the next one every few seconds, like a carousel, until the visitor picks
// one (a click, a key, a tap anywhere in it: from then on it's theirs), and waits while the pointer is over the pages
// or the tab is hidden. Never under reduced motion.
"use strict";

(function () {
  var tour = document.querySelector("[data-tour]");
  if (!tour) return;
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  var picks = Array.prototype.slice.call(tour.querySelectorAll(".tour-pick"));
  if (picks.length < 2) return;
  var EVERY = 7000;
  var resting = false;
  function stop() { clearInterval(timer); }
  tour.addEventListener("pointerdown", stop);
  tour.addEventListener("keydown", stop);
  var slides = tour.querySelector(".tour-slides");
  if (slides) {
    slides.addEventListener("pointerenter", function () { resting = true; });
    slides.addEventListener("pointerleave", function () { resting = false; });
  }
  var timer = setInterval(function () {
    if (resting || document.hidden) return;
    var i = picks.findIndex(function (p) { return p.checked; });
    picks[(i + 1) % picks.length].checked = true;
  }, EVERY);
})();
