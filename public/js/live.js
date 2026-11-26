// Live, in the page (docs/LIVE.md, hop 2): one EventSource on /live (web.js) per signed-in tab, and what each kind of
// news does here. The server sends what changed, never markup to trust blindly: anything drawn comes from the pages'
// own partials over a normal same-origin GET. The browser reconnects by itself and asks for what it missed.
//   status  — X's stream up or down: the header's sync status says "● Live" or when it last synced (.is-live); and
//             whose stream it is (`account`): a page drawn for another account follows the switch (THE ACCOUNT SWITCHER)
//   sync    — a sync run finished: "Synced just now" (and a first read's progress page checks whether it's done)
//   pull    — a first read moved (a page of history, its place in the line): the progress page redraws its block
//   balance — the header balance, as the server writes money
//   inbox   — someone replied to or mentioned you: the Inbox's "N new · Show" pill; a conversation's own pill if it's there
//   post    — a post of yours made on X: a reply to a message on this page lands under it (post-actions.js
//             xtoolioYourReply, `replyOf`), and the rail and the head move; otherwise that conversation's pill
//   like    — a like by you or on your post: every like line of that post on this page is redrawn (likes-line); yours
//             (made on X) leaves that message owing no like (post-actions.js xtoolioYourLike); one on
//             your post (toYou) also comes into the Likes feed, and carries the Likes count (`likes`), which this page
//             takes only when the post isn't on it (on it, you watched the like arrive: the sidebar never moves)
//   follow  — a follow / unfollow; one of you (toYou) comes into the Follows feed
//   me      — the header's "N following · N followers" ({ followers, following }), as the server now has them
//   limits  — X's write windows used up now ([{ words, ends }]): the header's countdown (public/js/limits.js)
//   count   — a sidebar place's number (in the accent) ({ tab: "inbox" | "likes" | "follows", n }): it takes the number, pops once
//             when it goes up, and hides at 0; THE COUNT follows (navSums): the window title's "(N)", the ☰'s dot
// The window title is THE COUNT, "(12) xtoolio": the sidebar's counts added up, as the server drew it (routes/pages.js
// navSums), moving with them.

// Inbox cards never slide in by themselves: you may be reading or typing a reply. A post already on the page is never
// "new". A FEED (Likes, Follows: [data-feed]) does slide in: there's nothing to type there.
"use strict";

(function () {
  if (!window.EventSource) return;

  // THE CONNECTION'S LIFECYCLE (without it, the app hung after quickly clicking through five or so pages). Leaving
  // a page can freeze it in the back/forward cache WITH its /live still open, and
  // HTTP/1.1 allows 6 connections per host: a headless repro showed one more open /live per click
  // and the 8th page never loading. So: pagehide (a real leave AND a freeze into the cache) closes it; pageshow from
  // the cache reopens it, asking for what arrived meanwhile (`after`: the last event id this page saw; a fresh
  // EventSource sends no Last-Event-ID of its own). Not on a hidden TAB: the window title's count needs the stream.
  var es = null;
  var handlers = {};
  var lastId = "";
  function attach(type) {
    es.addEventListener(type, function (e) {
      if (e.lastEventId) lastId = e.lastEventId;
      var data;
      try {
        data = JSON.parse(e.data || "{}");
      } catch (err) {
        return;
      }
      handlers[type](data);
    });
  }
  function connect() {
    if (es) return;
    es = new EventSource("/live" + (lastId ? "?after=" + encodeURIComponent(lastId) : ""));
    Object.keys(handlers).forEach(attach);
  }
  function disconnect() {
    if (!es) return;
    es.close();
    es = null;
  }
  function on(type, fn) {
    handlers[type] = fn;
    if (es) attach(type);
  }
  window.addEventListener("pagehide", disconnect);
  window.addEventListener("pageshow", function (e) { if (e.persisted) back(); });
  connect();

  // BACK TO THE APP (a phone's Home Screen app reopened, a tab brought forward after a while): the page RE-CHECKS by
  // itself. A phone that sleeps the app drops its stream without a word (the page still thinks it's open), so nothing
  // new reached it and the mentions check, which runs only while the account has xtoolio open, had stopped. So on
  // return after AWAY_MS: the stream is reopened from the last news this page saw (the server replays what came in
  // between, and opening it starts the mentions check within seconds), and for CATCH_UP_MS, while you haven't touched
  // the page yet, news that would light a "N new · Show" pill reloads the page instead (`pill`). Touching it first
  // (a tap, a key, the wheel) ends that: from then on it's the pill, as always, since a reload would lose your place.
  // Nothing new: nothing moves.
  var AWAY_MS = 15000;
  var CATCH_UP_MS = 40000;
  var hiddenAt = document.hidden ? Date.now() : 0;
  var catchUpUntil = 0;
  function back() {
    disconnect();
    connect();
    catchUpUntil = Date.now() + CATCH_UP_MS;
  }
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      hiddenAt = Date.now();
      return;
    }
    if (hiddenAt && Date.now() - hiddenAt >= AWAY_MS) back();
    hiddenAt = 0;
  });
  ["pointerdown", "keydown", "wheel", "touchstart"].forEach(function (type) {
    document.addEventListener(type, function () { catchUpUntil = 0; }, { capture: true, passive: true });
  });
  // Safe to reload: still catching up, and nothing of yours open on the page (a reply box, a modal, words typed).
  function catchingUp() {
    if (Date.now() > catchUpUntil || leaving) return false;
    if (document.querySelector("dialog[open]")) return false;
    return !Array.prototype.some.call(document.querySelectorAll("textarea, input[type=text], input[type=search]"), function (el) { return el.value !== el.defaultValue; });
  }

  var counts = {}; // per list pill: how many arrived

  // THE COUNT (routes/pages.js navSums, which drew it first): the sidebar's counts as they show, added up (one fading
  // out on its own page is seen, so it isn't in it). It's the window title's "(N)", as X's tab says it, and the phone's
  // ☰ wears a dot while it's above 0, so the closed drawer hides nothing. Recomputed whenever a count moves. (The title
  // once counted only what arrived while the tab was hidden, from 0 on every page: never the sidebar's number.)
  var baseTitle = document.title.replace(/^\(\d[\d,]*\) /, "");
  function navSums() {
    var total = 0;
    document.querySelectorAll("[data-tab-count]:not([hidden]):not(.clearing) [data-tab-n]").forEach(function (el) {
      total += parseInt(el.textContent.replace(/\D/g, ""), 10) || 0;
    });
    var dot = document.querySelector("[data-nav-dot]");
    if (dot) dot.hidden = !total;
    document.title = (total ? "(" + total.toLocaleString("en-US") + ") " : "") + baseTitle;
  }
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && feedUnseen) markSeen();
  });

  var onPage = function (postId) { return !!document.getElementById("p" + postId); };

  // Showing what's new: the view drawn again IN PLACE where the page can (post-actions.js VIEWS IN PLACE: the Inbox, a
  // conversation's page), else a reload.
  function showNew() {
    if (window.xtoolioView && window.xtoolioView.here()) return window.xtoolioView.refresh();
    location.reload();
  }
  // A view swapped in is drawn with everything new: its pills start from 0.
  document.addEventListener("app:swapped", function (e) { if (e.detail && e.detail.view) counts = {}; });
  // The pill: a list's (the Inbox's, a feed's) counts what's new; a conversation's just says there's something.
  function pill(el) {
    if (!el) return;
    if (catchingUp()) {
      catchUpUntil = 0; // once
      return showNew();
    }
    var list = el.getAttribute("data-live-list");
    if (list) {
      counts[list] = (counts[list] || 0) + 1;
      el.textContent = counts[list] + " " + el.getAttribute("data-text") + " · Show";
    }
    el.hidden = false;
  }
  document.addEventListener("click", function (e) {
    if (e.target.closest && e.target.closest("[data-live-pill]")) showNew();
  });
  function conversationPill(conversationId) {
    return conversationId ? document.querySelector('[data-live-conversation="' + conversationId + '"]') : null;
  }

  // THE FEED on this page, if any (the Likes page's cards, the Follows page's rows: [data-feed="likes|follows"]). A new
  // row is drawn by the server's own partial (`url`) and put at the top, replacing the row with the same key (a post's
  // card gains a liker), in the default view ([data-streams]); any other view counts on its pill. The page in view means
  // it's seen (its [data-seen-form] posts /<feed>/seen, so the tab's count stays 0); arriving while the tab is in the
  // background, it's seen when you come back.
  // The feed element is looked up when a row arrives, never kept: a search swaps the list in place (search.js), and a
  // kept one would be the old, detached list.
  var firstFeed = document.querySelector("[data-feed]");
  var feedName = firstFeed && firstFeed.getAttribute("data-feed");
  var feedUnseen = false;
  function markSeen() {
    var form = document.querySelector("[data-seen-form]");
    feedUnseen = false;
    // urlencoded, as every form here posts (only the reply route parses multipart, so a FormData body would lose its
    // _csrf anywhere else).
    if (form) fetch(form.action, { method: "POST", body: new URLSearchParams(new FormData(form)), credentials: "same-origin" }).catch(function () {});
  }
  function intoFeed(name, key, url) {
    var feed = document.querySelector("[data-feed]");
    if (feedName !== name || !feed) return;
    if (!feed.hasAttribute("data-streams")) return pill(document.querySelector('[data-live-list="' + name + '"]'));
    fetch(url, { credentials: "same-origin" })
      .then(function (res) { return res.status === 200 ? res.text() : null; })
      .then(function (html) {
        if (!html) return;
        var box = document.createElement("div");
        box.innerHTML = html;
        var row = box.firstElementChild;
        if (!row) return;
        var old = feed.querySelector('[data-feed-row="' + key + '"]');
        if (old) old.remove();
        feed.insertBefore(row, feed.firstChild);
        feed.hidden = false;
        var empty = document.querySelector("[data-feed-empty]");
        if (empty) empty.hidden = true;
        row.classList.add("arrive");
        if (document.hidden) feedUnseen = true;
        else markSeen();
      })
      .catch(function () {});
  }

  // THE ACCOUNT SWITCHER's other tabs (lib/sessionAccounts.js: one active account per browser, as X does): a page is
  // drawn for one account (<html data-account>), and every tab shares the one sign-in, so after a switch anywhere every
  // tab follows. Two signals: each page, as it loads, tells this browser's other tabs whose it is (BroadcastChannel;
  // a tab showing someone else reloads at once: two windows side by side), and the stream's status line says whose
  // it is (web.js /live), so a tab that missed that (asleep, back from the cache) reloads on reconnecting, before any
  // of the other account's news lands in it. A press from a page that still slipped through is refused by the server
  // (its token is bound to the account, lib/csrf.js).
  var pageAccount = document.documentElement.getAttribute("data-account");
  function follow() {
    disconnect();
    location.reload();
  }
  if (pageAccount && window.BroadcastChannel) {
    var tabs = new BroadcastChannel("active-account");
    tabs.onmessage = function (e) { if (e.data && e.data !== pageAccount) follow(); };
    tabs.postMessage(pageAccount);
  }

  // The header's sync status ([data-live-state]): "● Live" or when it last synced (its tooltip shows only Live: app.css).
  on("status", function (d) {
    if (pageAccount && d.account && d.account !== pageAccount) return follow();
    var st = document.querySelector("[data-live-state]");
    if (st) st.classList.toggle("is-live", !!d.live);
  });
  // THE FIRST READ's progress page ([data-pull], views/pulling.hbs): the worker says when it moved (`pull`: a page of
  // history read, its place in the line changed) and when a run ends (`sync`); the block is redrawn from the server's
  // own partial (GET /pull/progress), and once that says the read is done (204) the page goes on to what it was
  // waiting for. No reload while it runs (a 4-second meta refresh made the screen jump).
  var pullBox = document.querySelector("[data-pull]");
  function pullMoved() {
    if (!pullBox) return;
    fetch("/pull/progress", { credentials: "same-origin", cache: "no-store" })
      .then(function (res) {
        if (res.status === 204) return location.reload();
        if (res.ok) return res.text().then(function (html) { pullBox.innerHTML = html; });
      })
      .catch(function () {});
  }
  on("pull", pullMoved);
  // THE FOLLOW RECONCILER's read, in the worker (services/followingReads.js): each page read counts up
  // ([data-following-read]: views/follows-back.hbs), and the end reloads the page with its toast.
  on("following", function (d) {
    var box = document.querySelector("[data-following-read]");
    if (!box) return;
    if (d.done) {
      var u = new URL(location.href);
      if (d.n) u.searchParams.set("n", d.n);
      return location.assign(u.toString());
    }
    var n = box.querySelector("[data-following-n]");
    if (n && d.text) n.textContent = d.text;
  });
  on("sync", function () {
    pullMoved();
    var label = document.querySelector("[data-synced-label]");
    if (label) label.textContent = "Synced just now";
  });
  on("balance", function (d) {
    var el = document.querySelector("[data-header-balance]");
    if (el && d.text) el.textContent = d.text;
  });
  // The header's own counts moved (someone followed or unfollowed you, a follow made on X, a sync's read of your
  // profile, your press in another tab): post-actions.js xtoolioMe, the one setter.
  on("me", function (d) {
    if (window.xtoolioMe) window.xtoolioMe.set(d);
  });
  on("inbox", function (d) {
    if (onPage(d.postId)) return;
    pill(document.querySelector('[data-live-list="inbox"]') || conversationPill(d.conversationId));
  });
  on("post", function (d) {
    if (onPage(d.postId)) return; // a reply you sent from here is already in the chat
    // A reply you made on X to a message on this page: it lands under it, as if sent from here (post-actions.js).
    if (window.xtoolioYourReply && window.xtoolioYourReply(d.postId, d.replyOf)) return;
    pill(conversationPill(d.conversationId));
  });
  // Leaving this page: the next one is already being drawn with the counts as the server has them, so this one must not
  // move them on its way out (opening Likes zeroes its count while this page is still up: it blanked the badge, and the
  // new page drew it again). beforeunload is the start of the navigation; back from the cache, it's over.
  var leaving = false;
  window.addEventListener("beforeunload", function () { leaving = true; });
  window.addEventListener("pageshow", function () { leaving = false; });
  on("count", function (d) { setCount(d.tab, d.n); });
  // X's write limits used up now: the header's countdown (public/js/limits.js).
  on("limits", function (d) { if (window.xtoolioLimits) window.xtoolioLimits.set(d.limits); });
  // Your agent left a draft reply on a message (services/agentTools.js draft_reply): it shows under that message when
  // it's on this page (post-actions.js).
  on("draft", function (d) { if (window.xtoolioDraft) window.xtoolioDraft(d.postId); });
  // THE ONE SETTER of a sidebar place's number (a "count" event, or a live like's own `likes`).
  function setCount(tab, n) {
    if (leaving) return;
    var bell = document.querySelector('[data-tab-count="' + tab + '"]');
    var num = bell && bell.querySelector("[data-tab-n]");
    if (!num || typeof n !== "number") return;
    // On that feed's own page in view, a new row is seen as it lands (markSeen): no flash of "1" before the 0.
    if (tab === feedName && n > 0 && !document.hidden) return;
    // A count fading out on arrival (.clearing, web.js openFeed) is already 0 to the server: anything new counts from
    // there, shown again in full.
    var clearing = bell.classList.contains("clearing");
    bell.classList.remove("clearing");
    var was = clearing ? 0 : parseInt(num.textContent.replace(/\D/g, ""), 10) || 0;
    if (n === was && !clearing) return; // what it already shows (a recount that landed where the page is): touch nothing
    num.textContent = n.toLocaleString("en-US");
    bell.hidden = n === 0;
    navSums();
    // Any change it still shows: a small, subtle shake, up or down; going to 0 just hides it.
    if (n !== was && n > 0) {
      bell.classList.remove("shake");
      void bell.offsetWidth; // restart the animation
      bell.classList.add("shake");
    }
  }
  on("like", function (d) {
    var slots = document.querySelectorAll('[data-likes-for="' + d.postId + '"]');
    if (d.toYou) {
      intoFeed("likes", d.postId, "/posts/card/" + encodeURIComponent(d.postId));
      // The Likes count rides in this event (services/live.js). With the post on this page you watched it arrive (it's
      // marked viewed just below, and the server's recount lands back where it was): the sidebar doesn't move at all,
      // up or down, so it never flashes. Anywhere else, it takes the number.
      if (!slots.length) setCount("likes", d.likes);
    }
    if (slots.length && window.xtoolioRedrawLikes) window.xtoolioRedrawLikes(d.postId); // THE redraw (post-actions.js)
    // Your like, made on X (or X's echo of one pressed here, which moves nothing twice): that message owes no like.
    if (!d.toYou && window.xtoolioYourLike) window.xtoolioYourLike(d.postId);
    // A like on your post you watched arrive here isn't news on Your posts (POST /posts/viewed); Your posts
    // marks its own (markSeen). Arriving while the tab is hidden, it's viewed when you come back to it.
    if (d.toYou && slots.length && feedName !== "likes") {
      if (document.hidden) unviewed.push(d.postId);
      else viewed(d.postId);
    }
  });
  // Someone reposted your post (services/live.js, the Likes module): its Likes row comes in like a like's, the Likes
  // count rides in the event (and so the title's).
  on("repost", function (d) {
    intoFeed("likes", d.postId, "/posts/card/" + encodeURIComponent(d.postId));
    setCount("likes", d.likes); // on the Likes page itself it's seen as it lands (setCount knows)
  });
  // THE token every signed-in page carries (the sidebar's forms), for a write that has no form of its own.
  function csrf() {
    var input = document.querySelector('input[name="_csrf"]');
    return input ? input.value : "";
  }
  var unviewed = [];
  function viewed(postId) {
    var body = new URLSearchParams();
    body.set("_csrf", csrf());
    body.set("postId", postId);
    fetch("/posts/viewed", { method: "POST", body: body, credentials: "same-origin" }).catch(function () {});
  }
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) return;
    unviewed.splice(0).forEach(viewed);
  });
  on("follow", function (d) {
    if (!d.toYou) return; // your own follows aren't news
    intoFeed("follows", d.eventId, "/follows/row/" + encodeURIComponent(d.eventId));
  });
})();
