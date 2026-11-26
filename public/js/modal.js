// The modal (views/partials/modal.hbs): a click on anything with data-modal-open="<id>" opens that <dialog>; a click
// on its backdrop closes it (the click lands on the <dialog> itself, never on its content). Esc and the ✕ are the
// browser's own. An opener that is a form's submit button sends the form without script, so the page still works,
// just without the question.
"use strict";

(function () {
  document.addEventListener("click", function (e) {
    var opener = e.target.closest("[data-modal-open]");
    if (opener) {
      var dialog = document.getElementById(opener.getAttribute("data-modal-open"));
      if (dialog && dialog.showModal) {
        e.preventDefault();
        dialog.showModal();
      }
      return;
    }
    if (e.target.tagName === "DIALOG" && e.target.classList.contains("modal")) e.target.close();
  });
})();
