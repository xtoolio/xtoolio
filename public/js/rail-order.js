// THE PHONE'S INBOX ORDER (views/inbox.hbs): on a phone the rail IS the Inbox (app.css .inbox-page.listing), read
// newest first, as X's notifications are; on a wide screen it stays closest first beside
// the cards. The server can't know the width, so this reorders the drawn rows once by when their newest owed reply
// came (data-at, ISO, so text order is time order). Loaded right after the rail and NOT deferred: it runs before the
// list paints, so nothing jumps; and again on a rail a search swaps in ("app:swapped": public/js/search.js). Rows are
// found by their key everywhere else (post-actions.js), so moving them is safe.
"use strict";

(function () {
  if (!window.matchMedia || !window.matchMedia("(max-width: 720px)").matches) return;
  function order() {
    var rail = document.querySelector(".inbox-page.listing .rail");
    if (!rail) return;
    var rows = Array.prototype.slice.call(rail.querySelectorAll(".rail-row[data-at]"));
    rows.sort(function (a, b) {
      var x = a.getAttribute("data-at");
      var y = b.getAttribute("data-at");
      return x < y ? 1 : x > y ? -1 : 0;
    });
    var end = rail.querySelector(".rail-empty"); // null: append
    rows.forEach(function (r) {
      rail.insertBefore(r, end);
    });
  }
  order();
  document.addEventListener("app:swapped", order);
})();
