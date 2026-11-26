// THE PICKS (views/follows-back.hbs, the reconciler's bulk unfollow): each card's checkbox ([data-pick], a field of the
// "unfollow-many" form from outside it), "Select all on this page" ([data-pick-all], checked / mixed / unchecked as the
// picks are), and every [data-count="picked"] number with its [data-plural="picked"] words (the button, the modal's
// question and its button). The button that asks ([data-pick-go]) is disabled with nothing picked. Without this file
// the button sends whatever is checked.
"use strict";

(function () {
  function picks() {
    return Array.prototype.slice.call(document.querySelectorAll("[data-pick]"));
  }
  if (!picks().length) return;
  var all = document.querySelector("[data-pick-all]");
  var go = document.querySelector("[data-pick-go]");
  function update() {
    var list = picks();
    var n = list.filter(function (c) { return c.checked; }).length;
    document.querySelectorAll('[data-count="picked"]').forEach(function (el) { el.textContent = n.toLocaleString("en-US"); });
    document.querySelectorAll('[data-plural="picked"]').forEach(function (el) { el.textContent = el.getAttribute(n === 1 ? "data-one" : "data-many"); });
    if (go) go.disabled = n === 0;
    if (all) {
      all.checked = n > 0 && n === list.length;
      all.indeterminate = n > 0 && n < list.length;
    }
  }
  document.addEventListener("change", function (e) {
    var t = e.target;
    if (t.matches && t.matches("[data-pick-all]")) picks().forEach(function (c) { c.checked = t.checked; });
    if (t.matches && (t.matches("[data-pick]") || t.matches("[data-pick-all]"))) update();
  });
  // Back from the cache (the browser's Back after sending), the boxes keep their state: count them again. And again
  // when cards leave the page (post-actions.js: a bulk unfollow folds them out, their boxes with them).
  window.addEventListener("pageshow", update);
  document.addEventListener("picks:changed", update);
  update();
})();
