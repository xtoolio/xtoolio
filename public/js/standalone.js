// THE HOME SCREEN APP, told apart from a browser tab: <html class="standalone">, set in the head before the page paints
// (not deferred), so app.css can give what sits along the screen's top edge room out of iOS's status-bar fade
// (--edge). iOS says it with navigator.standalone (a Home Screen web app); the display-mode query covers the rest.
// The CSS media query alone didn't match in iOS's Home Screen app, so this one signal decides.
(function () {
  var standalone = window.navigator.standalone === true;
  try { standalone = standalone || window.matchMedia("(display-mode: standalone)").matches; } catch (_) {}
  if (standalone) document.documentElement.classList.add("standalone");
})();
