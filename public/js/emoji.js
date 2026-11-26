// Emoji in the reply composer (as X has): a 😊 button in each composer's foot opens THE EMOJI PICKER, which hangs
// BELOW the box (X's way: it never covers what you're writing), and one click puts an emoji where the cursor is.
//   - a search box first ("lol", "fire", "clap": every word must start a word of the emoji's name or keywords; Enter
//     puts in the first found);
//   - Recently used (this browser's, kept in localStorage), then Popular (the ones people reply with), then the whole
//     set by Unicode's groups, with a row of tabs that jumps to each.
// The whole set and its words are public/emoji.json (scripts/make-emoji.js, from emojibase-data: names and keywords
// from Unicode CLDR), fetched once, the first time a picker opens, at this script's own version (?v=: an immutable
// cache). Until it's in, or if it can't load, Recent and Popular still work.
// ONE picker per page, built on first use and moved to whichever composer asked: every message has its own hidden
// composer, and a grid in each would be ~2,000 buttons each. In the phone's reply sheet it sits in the flow under the
// box (app.css). Without script there's no button (the system's picker, Win + . / Ctrl + ⌘ + Space, still works).
"use strict";

(function () {
  var POPULAR = "👉 🫵 👈 👆 👇 👏 🙌 🙏 🤝 💪 👍 👎 🫡 🫶 👀 🔥 💯 ✅ 🚀 🎉 ✨ ⚡ ❤️ 💜 😂 🤣 😅 😊 🙂 😉 😎 🤔 🤯 😭 🥲 😤 😮‍💨 🤷 🤦 💀 🧠 🛠️ 📈 💸 ⏳ 🍿 ☕ 🤖".split(" ");
  var RECENT_KEY = "xt.emoji.recent";
  var RECENT_MAX = 27; // three rows
  var me = document.currentScript;
  var VERSION = me ? new URL(me.src).searchParams.get("v") : "";
  var TOUCH = window.matchMedia && window.matchMedia("(hover: none)").matches;
  var panel = null;
  var target = null; // the textarea the picker inserts into
  var all = null; // [[emoji, words], …] once emoji.json is in, words starting with a space (" grinning face grin …")

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }
  function button(e) {
    var b = el("button", "emoji-pick", e);
    b.type = "button";
    b.setAttribute("data-emoji", e);
    return b;
  }
  function grid(list) {
    var g = el("div", "emoji-grid");
    var frag = document.createDocumentFragment();
    list.forEach(function (e) { frag.appendChild(button(e)); });
    g.appendChild(frag);
    return g;
  }
  function recent() {
    try {
      var r = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
      return Array.isArray(r) ? r.filter(function (e) { return typeof e === "string"; }).slice(0, RECENT_MAX) : [];
    } catch (err) {
      return [];
    }
  }
  function remember(e) {
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify([e].concat(recent().filter(function (r) { return r !== e; })).slice(0, RECENT_MAX)));
    } catch (err) { /* private window: no recents */ }
  }

  // A section: its heading and grid; its tab jumps to it.
  function section(key, name, icon, list) {
    var s = el("section", "emoji-sec");
    s.setAttribute("data-emoji-sec", key);
    s.appendChild(el("h3", "emoji-sec-name", name));
    s.appendChild(grid(list));
    var tab = el("button", "emoji-tab", icon);
    tab.type = "button";
    tab.setAttribute("data-emoji-jump", key);
    tab.setAttribute("aria-label", name);
    tab.setAttribute("data-tip", name);
    panel.querySelector("[data-emoji-tabs]").appendChild(tab);
    panel.querySelector("[data-emoji-scroll]").appendChild(s);
  }
  function build() {
    panel = el("div", "emoji-panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Emoji");
    var search = el("input", "emoji-search");
    search.type = "search";
    search.placeholder = "Search emoji";
    search.setAttribute("aria-label", "Search emoji");
    search.autocomplete = "off";
    search.setAttribute("data-emoji-search", ""); // no name: never sent with the reply
    var tabs = el("div", "emoji-tabs");
    tabs.setAttribute("data-emoji-tabs", "");
    var scroll = el("div", "emoji-scroll");
    scroll.setAttribute("data-emoji-scroll", "");
    var results = el("div", "emoji-results");
    results.setAttribute("data-emoji-results", "");
    results.hidden = true;
    panel.appendChild(search);
    panel.appendChild(tabs);
    panel.appendChild(scroll);
    panel.appendChild(results);
    panel.hidden = true;
    drawSections();
    load();
  }
  function drawSections() {
    panel.querySelector("[data-emoji-tabs]").textContent = "";
    panel.querySelector("[data-emoji-scroll]").textContent = "";
    var r = recent();
    if (r.length) section("recent", "Recently used", "🕘", r);
    section("popular", "Popular", "⭐", POPULAR);
    if (all) all.groups.forEach(function (g) { section(g.key, g.name, g.icon, g.e.map(function (x) { return x[0]; })); });
  }
  function load() {
    fetch("/emoji.json" + (VERSION ? "?v=" + encodeURIComponent(VERSION) : ""), { credentials: "same-origin" })
      .then(function (res) { return res.ok ? res.json() : Promise.reject(res.status); })
      .then(function (data) {
        all = data;
        all.flat = [];
        data.groups.forEach(function (g) { g.e.forEach(function (x) { all.flat.push([x[0], " " + x[1] + " "]); }); });
        var keep = panel.querySelector("[data-emoji-scroll]").scrollTop;
        drawSections();
        panel.querySelector("[data-emoji-scroll]").scrollTop = keep;
        find(panel.querySelector("[data-emoji-search]").value);
      })
      .catch(function () { all = null; }); // Recent and Popular stay; search says it can't
  }

  // THE SEARCH: every word typed must start one of the emoji's words. First the ones where each is a WHOLE word ("lol"
  // is 😂's keyword before it's the start of 🍭 "lollipop"), then the ones whose name starts with it, then the rest.
  function find(q) {
    var words = String(q || "").toLowerCase().trim().split(/\s+/).filter(Boolean);
    var results = panel.querySelector("[data-emoji-results]");
    var scroll = panel.querySelector("[data-emoji-scroll]");
    var tabs = panel.querySelector("[data-emoji-tabs]");
    if (!words.length) {
      results.hidden = true;
      scroll.hidden = false;
      tabs.hidden = false;
      return;
    }
    results.textContent = "";
    scroll.hidden = true;
    tabs.hidden = true;
    results.hidden = false;
    if (!all) {
      results.appendChild(el("p", "emoji-none", "Loading emoji…"));
      return;
    }
    // Within each, the ones you've used and the Popular ones lead ("lol": 😂 before 😄, which Unicode lists first).
    var known = recent().concat(POPULAR);
    var tiers = [[], [], [], [], [], []];
    all.flat.forEach(function (x) {
      if (!words.every(function (w) { return x[1].indexOf(" " + w) !== -1; })) return;
      var whole = words.every(function (w) { return x[1].indexOf(" " + w + " ") !== -1; });
      var tier = whole ? 0 : x[1].indexOf(" " + words[0]) === 0 ? 1 : 2;
      tiers[tier * 2 + (known.indexOf(x[0]) !== -1 ? 0 : 1)].push(x[0]);
    });
    var found = [].concat.apply([], tiers);
    if (!found.length) return results.appendChild(el("p", "emoji-none", "No emoji found"));
    results.appendChild(grid(found));
  }

  function close() {
    if (panel) panel.hidden = true;
    target = null;
  }
  function openFor(btn) {
    if (!panel) build();
    var form = btn.closest("form[data-reply]");
    if (!panel.hidden && target === form.elements.text) return close();
    var search = panel.querySelector("[data-emoji-search]");
    search.value = "";
    drawSections(); // Recently used, as it is now
    find("");
    btn.closest(".reply-foot").appendChild(panel);
    target = form.elements.text;
    panel.hidden = false;
    panel.querySelector("[data-emoji-scroll]").scrollTop = 0;
    panel.scrollIntoView({ block: "nearest" }); // it hangs below the box: the page moves just enough to show it
    if (!TOUCH) search.focus({ preventScroll: true }); // a phone's keyboard is up for the reply already
  }
  function insert(e) {
    if (!target) return;
    var start = target.selectionStart == null ? target.value.length : target.selectionStart;
    var end = target.selectionEnd == null ? start : target.selectionEnd;
    target.setRangeText(e, start, end, "end");
    target.dispatchEvent(new Event("input", { bubbles: true })); // the length line and the box's height follow
    target.focus({ preventScroll: true });
    remember(e);
  }

  // A 😊 button in every composer's foot (the forms are all on the page from the start, hidden or not), and in the
  // ones a search swaps in ("app:swapped": public/js/search.js, autosubmit.js).
  function addButtons(root) {
    Array.prototype.forEach.call(root.querySelectorAll("form[data-reply] .reply-foot"), function (foot) {
      if (foot.querySelector("[data-emoji-toggle]")) return;
      var b = el("button", "emoji-btn", "😊");
      b.type = "button";
      b.setAttribute("data-emoji-toggle", "");
      b.setAttribute("aria-label", "Add an emoji");
      b.setAttribute("data-tip", "Emoji");
      foot.insertBefore(b, foot.firstChild);
    });
  }
  addButtons(document);
  document.addEventListener("app:swapped", function (e) { addButtons(e.detail.root); });

  document.addEventListener("click", function (e) {
    var t = e.target;
    if (!t.closest) return;
    var toggle = t.closest("[data-emoji-toggle]");
    if (toggle) return openFor(toggle);
    var pick = t.closest("[data-emoji]");
    if (pick) return insert(pick.getAttribute("data-emoji"));
    var jump = t.closest("[data-emoji-jump]");
    if (jump) {
      var sec = panel.querySelector('[data-emoji-sec="' + jump.getAttribute("data-emoji-jump") + '"]');
      var scroll = panel.querySelector("[data-emoji-scroll]");
      if (sec) scroll.scrollTop = sec.offsetTop - scroll.offsetTop;
      return;
    }
    if (panel && !panel.hidden && !t.closest(".emoji-panel")) close();
  });
  document.addEventListener("input", function (e) {
    if (e.target.matches && e.target.matches("[data-emoji-search]")) find(e.target.value);
  });
  document.addEventListener("keydown", function (e) {
    if (!panel || panel.hidden) return;
    var inSearch = e.target.matches && e.target.matches("[data-emoji-search]");
    // Enter in the search puts in the first emoji found (and never sends the reply: the search is inside its form).
    if (inSearch && e.key === "Enter") {
      e.preventDefault();
      var first = panel.querySelector("[data-emoji-results]:not([hidden]) [data-emoji]");
      if (first) insert(first.getAttribute("data-emoji"));
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault(); // the picker, not the reply sheet around it
      var back = target;
      close();
      if (back) back.focus({ preventScroll: true });
    }
  });
})();
