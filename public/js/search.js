// THE SEARCH BOX of a list (partials/list-search.hbs: the Inbox, Your people, Your posts, Follows), IN PLACE: a moment
// after you stop typing, the page for the new search is fetched (the same GET the form makes, the server filters:
// services/listing.js THE SEARCH RULE) and its <main> takes this one's place, with THIS search box moved into it, so
// the focus, the caret and anything typed meanwhile stay; the address follows (replaceState). The sort beside it
// (autosubmit.js submits it) and Enter come here too. It used to reload the whole page on every pause: the page jumped
// to the top and keys typed during the reload were lost. Other scripts set up what they add to the fresh content on
// "app:swapped" (emoji.js, attach.js, more.js, rail-order.js, nav.js), as for autosubmit.js's swaps. Without script, or
// when a fetch fails, the form submits as before.
//
// THE FOUND WORDS are highlighted (<mark class="hit">) in what a row shows: names, @handles, a post's words, a rail
// row's preview; never a button or a label. Folded as the server folds (plain letters: accents dropped, fancy fonts
// unfolded, case ignored), each word, so a highlight is always a word that matched; mapped back onto the text as drawn.
"use strict";

(function () {
  var SHOWN = ".post-name, .name, .handle-link, .text, .like-words, .like-to, .rail-name, .rail-preview, .rail-text";

  // One character folded (services/listing.js searchKey, a character at a time so a match maps back onto the text).
  function foldChar(c) {
    return c.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();
  }
  // The words a search looks for (services/listing.js searchTerms): a profile link is its handle, a word's @ dropped.
  function termsOf(q) {
    var raw = String(q || "").trim();
    var link = raw.match(/^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/@?([A-Za-z0-9_]{1,15})(?:[/?#].*)?$/i);
    var words = link ? [link[1]] : raw.split(/\s+/);
    return words.map(function (w) { return Array.from(w.replace(/^@+/, "")).map(foldChar).join(""); }).filter(Boolean);
  }

  // Wrap each found word in the text nodes under `root`'s shown parts. A one-letter word still filters (the server) but
  // isn't marked beside longer ones: "maya o" lit every o on the row.
  function highlight(root, all) {
    var terms = all.length > 1 ? all.filter(function (t) { return t.length > 1; }) : all;
    if (!terms.length) return;
    Array.prototype.forEach.call(root.querySelectorAll(SHOWN), function (el) {
      var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode: function (n) {
          return n.parentElement.closest("mark.hit, button, .copy-handle, time") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        },
      });
      var nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      nodes.forEach(function (node) { markIn(node, terms); });
    });
  }
  function markIn(node, terms) {
    var text = node.nodeValue;
    // The folded text, and for each folded character the index in `text` it came from.
    var folded = "";
    var from = [];
    var i = 0;
    Array.from(text).forEach(function (c) {
      var f = foldChar(c);
      for (var k = 0; k < f.length; k++) from.push(i);
      folded += f;
      i += c.length;
    });
    var ranges = [];
    terms.forEach(function (t) {
      for (var at = folded.indexOf(t); at !== -1; at = folded.indexOf(t, at + t.length)) {
        var end = at + t.length;
        ranges.push([from[at], end < from.length ? from[end] : text.length]);
      }
    });
    if (!ranges.length) return;
    // Overlapping finds merged, in order.
    ranges.sort(function (a, b) { return a[0] - b[0]; });
    var merged = [ranges[0]];
    ranges.slice(1).forEach(function (r) {
      var last = merged[merged.length - 1];
      if (r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push(r);
    });
    var frag = document.createDocumentFragment();
    var pos = 0;
    merged.forEach(function (r) {
      if (r[0] > pos) frag.appendChild(document.createTextNode(text.slice(pos, r[0])));
      var mark = document.createElement("mark");
      mark.className = "hit";
      mark.textContent = text.slice(r[0], r[1]);
      frag.appendChild(mark);
      pos = r[1];
    });
    if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
    node.parentNode.replaceChild(frag, node);
  }

  // THE SWAP, around the search box: every level from <main> down to the box takes the fresh page's attributes and
  // children, except the one child holding the box, which stays where it is. The box is NEVER detached: moving a
  // focused field blurs it, and on a phone that closes the keyboard after every pause. false (nothing changed) when
  // the fresh page isn't shaped the same way down to its box.
  function graft(main, fresh) {
    var ours = [];
    for (var n = input; n && n !== main; n = n.parentElement) ours.unshift(n);
    var theirsBox = fresh.querySelector("[data-live-search]");
    var theirs = [];
    for (var m = theirsBox; m && m !== fresh; m = m.parentElement) theirs.unshift(m);
    if (!theirsBox || ours.length !== theirs.length || ours.some(function (o, i) { return o.tagName !== theirs[i].tagName; })) return false;
    var level = function (mine, them, keep, keepTheirs) {
      Array.prototype.slice.call(mine.attributes).forEach(function (a) { if (!them.hasAttribute(a.name)) mine.removeAttribute(a.name); });
      Array.prototype.forEach.call(them.attributes, function (a) { if (mine.getAttribute(a.name) !== a.value) mine.setAttribute(a.name, a.value); });
      Array.prototype.slice.call(mine.childNodes).forEach(function (c) { if (c !== keep) mine.removeChild(c); });
      var before = true;
      Array.prototype.slice.call(them.childNodes).forEach(function (c) {
        if (c === keepTheirs) return (before = false);
        var copy = document.importNode(c, true);
        if (before) mine.insertBefore(copy, keep);
        else mine.appendChild(copy);
      });
    };
    level(main, fresh, ours[0], theirs[0]);
    for (var i = 0; i < ours.length - 1; i++) level(ours[i], theirs[i], ours[i + 1], theirs[i + 1]);
    return true;
  }

  var input = null;
  var form = null;
  var bar = document.querySelector("[data-nav-progress]"); // the header's loading bar (busy.js), while a search is on its way
  var timer = null;
  var latest = 0;
  var last = "";
  // The page's search box, found again when a whole view is swapped in (post-actions.js VIEWS IN PLACE: a new box);
  // this script's own swap keeps the same one.
  function findBox() {
    input = document.querySelector("[data-live-search]");
    form = input && input.form;
    last = input ? input.value.trim() : "";
    if (input) highlight(document.querySelector("main") || document, termsOf(input.value));
  }
  findBox();
  document.addEventListener("app:swapped", function (e) { if (e.detail && e.detail.view) findBox(); });
  if (!input) return;

  function search() {
    var url = new URL(form.getAttribute("action") || location.pathname, location.href);
    url.search = new URLSearchParams(new FormData(form)).toString(); // no page field: a new search starts at page 1
    var asked = input.value.trim();
    var mine = ++latest;
    last = asked;
    if (bar) bar.classList.add("on");
    fetch(url.pathname + url.search, { credentials: "same-origin", headers: { Accept: "text/html" } })
      .then(function (res) {
        if (!res.ok) throw new Error(String(res.status));
        return res.text();
      })
      .then(function (html) {
        if (mine !== latest) return; // a newer search is on its way
        if (input.value.trim() !== asked) return; // still typing: the next pause asks again
        var doc = new DOMParser().parseFromString(html, "text/html");
        if (!window.xtoolioSameAccount(doc)) throw new Error("another account"); // swap.js: the plain submit
        var fresh = doc.querySelector("main");
        var main = document.querySelector("main");
        if (!fresh || !main || !graft(main, fresh)) throw new Error("not the same page");
        history.replaceState(history.state, "", url.pathname + url.search);
        document.dispatchEvent(new CustomEvent("app:swapped", { detail: { root: main } }));
        highlight(main, termsOf(asked));
      })
      .catch(function () {
        if (mine === latest) form.submit(); // the plain way: a reload with the search
      })
      .then(function () {
        if (mine === latest && bar) bar.classList.remove("on");
      });
  }

  document.addEventListener("input", function (e) {
    if (!input || e.target !== input) return;
    clearTimeout(timer);
    timer = setTimeout(function () {
      if (input.value.trim() !== last) search();
    }, 300);
  });
  // Enter, and the sort beside it (autosubmit.js submits the form on change): in place too.
  document.addEventListener("submit", function (e) {
    if (!form || e.target !== form || !window.fetch || !window.DOMParser) return;
    e.preventDefault();
    clearTimeout(timer);
    search();
  });

  // Arriving on a search (the address has one): keep typing where you were.
  if (input.value && new URLSearchParams(location.search).has("q")) {
    input.focus();
    var at = input.value.length;
    input.setSelectionRange(at, at);
  }
})();
