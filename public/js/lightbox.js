// THE VIEWER (views/partials/lightbox.hbs, THE modal dressed "lightbox"): a press on a post's picture (partials/media.hbs
// .pm-open: data-view, data-view-kind, data-post) opens it big. A photo at its original size, a press on it zooming to
// 1:1 (scroll to look around) and back; a GIF as its looping MP4, playing (under reduced motion it waits, with
// controls); a video's frame with "▶ Play on X" (its file isn't stored). ← → step through the same post's pictures.
// Closing empties the stage, so nothing keeps playing or loading. Esc, the ✕ and the backdrop are THE modal's
// (public/js/modal.js); a click anywhere on the dark (not the picture or a control) closes it too.
"use strict";

(function () {
  var box = document.getElementById("lightbox");
  if (!box || !box.showModal) return;
  var stage = box.querySelector("[data-lightbox-stage]");
  var counter = box.querySelector("[data-lightbox-n]");
  var steps = box.querySelectorAll("[data-lightbox-step]");
  var onX = box.querySelector("[data-lightbox-onx]");
  var still = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var list = [];
  var at = 0;

  function show(i) {
    at = (i + list.length) % list.length;
    var b = list[at];
    var kind = b.getAttribute("data-view-kind");
    var src = b.getAttribute("data-view");
    var thumb = b.querySelector("img, video");
    stage.textContent = "";
    box.classList.remove("zoomed");
    var el;
    if (kind === "gif") {
      el = document.createElement("video");
      el.muted = true;
      el.loop = true;
      el.playsInline = true;
      el.src = src;
      if (thumb && thumb.getAttribute("poster")) el.poster = thumb.getAttribute("poster");
      if (still) el.controls = true;
      else el.autoplay = true;
      if (thumb && thumb.getAttribute("aria-label")) el.setAttribute("aria-label", thumb.getAttribute("aria-label"));
      // Its box takes the picture's shape (app.css video.sized), so the dark around it is the viewer's and closes it.
      el.addEventListener("loadedmetadata", function () {
        if (!el.videoWidth || !el.videoHeight) return;
        el.style.setProperty("--ar", String(el.videoWidth / el.videoHeight));
        el.classList.add("sized");
      });
    } else {
      el = document.createElement("img");
      el.alt = (thumb && thumb.getAttribute("alt")) || "";
      el.referrerPolicy = "no-referrer";
      el.src = src;
      if (kind === "photo") el.className = "zoomable";
    }
    stage.appendChild(el);
    onX.hidden = kind !== "video";
    if (kind === "video") onX.href = "https://x.com/i/status/" + encodeURIComponent(b.getAttribute("data-post") || "");
    var many = list.length > 1;
    counter.hidden = !many;
    counter.textContent = many ? at + 1 + " / " + list.length : "";
    Array.prototype.forEach.call(steps, function (s) { s.hidden = !many; });
  }

  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest(".pm-open[data-view]");
    if (b && !b.closest("[inert]")) {
      e.preventDefault();
      var media = b.closest(".post-media, [data-view-group]"); // a post's pictures, or another set (a feedback's screenshots)
      list = media ? Array.prototype.slice.call(media.querySelectorAll(".pm-open[data-view]")) : [b];
      show(list.indexOf(b));
      box.showModal();
      return;
    }
    if (!box.open) return;
    var step = e.target.closest && e.target.closest("[data-lightbox-step]");
    if (step) return show(at + Number(step.getAttribute("data-lightbox-step")));
    if (e.target.classList && e.target.classList.contains("zoomable")) return box.classList.toggle("zoomed"); // read it 1:1
    // ANYWHERE on the dark closes it, not just the ✕: the
    // picture, a GIF's controls and the bar's buttons and link are the only things that don't. It was the stage alone,
    // and a wide picture leaves the dark beside and under it to the dialog's body and bar.
    if (box.contains(e.target) && !e.target.closest("img, video, button, a")) box.close();
  });
  document.addEventListener("keydown", function (e) {
    if (!box.open || list.length < 2) return;
    if (e.key === "ArrowLeft") show(at - 1);
    else if (e.key === "ArrowRight") show(at + 1);
  });
  box.addEventListener("close", function () {
    stage.textContent = ""; // stops a GIF, and nothing more loads
    box.classList.remove("zoomed");
    list = [];
  });
})();
