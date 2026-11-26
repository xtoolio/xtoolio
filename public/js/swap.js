// THE CHECK FOR HTML FETCHED TO SWAP INTO THIS PAGE (VIEWS IN PLACE and the search in post-actions.js / search.js, the
// estimator's parts in autosubmit.js, a refreshed person's row): the fetched page must have been drawn for the same
// account as this one (<html data-account>; both empty signed out). One browser has ONE active account, switched in any
// tab; a tab that missed the switch would otherwise swap the other account's view, with its forms' fresh CSRF tokens,
// under this page's header. Not the same: the caller loads the plain way instead.
(function () {
  "use strict";
  var mine = document.documentElement.getAttribute("data-account");
  window.xtoolioSameAccount = function (doc) {
    return !!doc && doc.documentElement.getAttribute("data-account") === mine;
  };
})();
