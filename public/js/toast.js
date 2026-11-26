// The toast (views/partials/toast.hbs): the ✕ dismisses it, and ?n= (and a Done's ?u=) leave the address bar so a
// reload or a shared link doesn't show it again. Fading out is CSS's job, so the toast works without this script.
"use strict";

(function () {
  function wire(toast) {
    var close = toast.querySelector("[data-toast-close]");
    if (close) close.addEventListener("click", function () { toast.remove(); });
  }

  // A toast from the page itself (public/js/post-actions.js: X said no, a card marked done), cloned from the layout's
  // <template> of the same partial, so there's one toast, drawn one way. Replaces any toast showing. `undo`: a Done
  // press's undo token (the route's JSON `undo`): the toast's Undo sends it, back to this page as it is now; or a
  // function, the page's own way back (post-actions.js: a picture removed from your media), run in place of the form.
  window.xtoolioToast = function (text, kind, undo) {
    var tpl = document.getElementById("toast-template");
    if (!tpl) return;
    document.querySelectorAll("[data-toast]").forEach(function (t) { t.remove(); });
    var toast = tpl.content.firstElementChild.cloneNode(true);
    toast.querySelector("span").textContent = text;
    var err = kind === "error" || kind === "limit";
    toast.classList.toggle("error", err);
    toast.setAttribute("role", err ? "alert" : "status");
    // X refused something for its limit (lib/notices.js kind "limit"): the header's stopwatch says when it resets.
    if (kind === "limit" && window.xtoolioLimits) window.xtoolioLimits.hit();
    var form = toast.querySelector("[data-toast-undo]");
    if (form && typeof undo === "function") {
      form.removeAttribute("data-toast-undo"); // not THE Done undo (post-actions.js sends that one)
      form.removeAttribute("data-busy");
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        toast.remove();
        undo();
      });
    } else if (form && undo) {
      form.elements.u.value = undo;
      form.elements.back.value = location.pathname + location.search;
    } else {
      if (form) form.remove();
      toast.classList.remove("has-undo");
    }
    // Over an open modal (the phone's reply sheet) it goes INSIDE it: a modal sits in the browser's top layer, above
    // anything in the page, so a refusal shown in the body would be hidden behind the sheet.
    var modal = null;
    try { modal = document.querySelector("dialog:modal"); } catch (e) { /* an old browser without :modal */ }
    (modal || document.body).appendChild(toast);
    wire(toast);
  };

  var toast = document.querySelector("[data-toast]");
  if (!toast) return;
  wire(toast);
  var url = new URL(location.href);
  if (url.searchParams.has("n") || url.searchParams.has("u")) {
    url.searchParams.delete("n");
    url.searchParams.delete("u");
    history.replaceState(history.state, "", url.pathname + url.search + url.hash);
  }
})();
