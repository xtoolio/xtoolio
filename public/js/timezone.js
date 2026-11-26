// The browser's time zone, handed to the server, which writes every date in it (lib/timezone.js). Fills each
// [data-browser-tz] element: a sign-in LINK gets ?tz= (saved on the account at sign-in), and, while the account has
// none, the Settings picker is preselected so one Save sets it. Without this script the account shows UTC until a zone
// is picked in Settings. The server validates and canonicalizes whatever arrives. Elements swapped in later (the module
// picker's sign-in link, autosubmit.js "app:swapped") are filled too.
"use strict";

(function () {
  var tz;
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch (e) {
    return;
  }
  if (!tz) return;
  function fill(root) {
    var els = [].slice.call(root.querySelectorAll("[data-browser-tz]"));
    if (root.matches && root.matches("[data-browser-tz]")) els.push(root);
    els.forEach(function (el) {
      if (el.tagName === "A") {
        var url = new URL(el.getAttribute("href"), location.href);
        url.searchParams.set("tz", tz);
        el.setAttribute("href", url.pathname + url.search);
        return;
      }
      // A select only takes a zone it lists (an alias the server names differently stays on the server's choice).
      if (el.tagName === "SELECT" && !el.querySelector('option[value="' + tz.replace(/"/g, "") + '"]')) return;
      el.value = tz;
    });
  }
  fill(document);
  document.addEventListener("app:swapped", function (e) {
    fill(e.detail.root);
  });
})();
