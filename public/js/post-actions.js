// What you can do to a post or an Inbox card from xtoolio, in place, no page load (each also works as a plain form).
// THE PRESS IS THE ACTION: each moves the page at once and the server confirms behind it (see "THE PAGE IS
// OPTIMISTIC" below):
//   the ♥ (views/partials/liked.hbs → POST /posts/:id/like): flips at once, goes back if X says no.
//   a message's "↩ Reply" opens its own composer right under it (views/partials/reply-box.hbs → POST
//     /posts/:id/reply); your reply lands as your bubble right under the message it answers.
//   an Inbox card's "Mark done" / Reopen (views/inbox.hbs → POST /inbox/done): Mark done pops the button green with
//     a confetti burst; the card folds out of the tab it no longer belongs in, and the Waiting / Done counts move.
//   THE Follow button (views/partials/follow-button.hbs → POST /people/:id/follow: a Follows card, a People card, a
//     person's page): flips at once, the Mutual / Follows you / You follow tag beside it moves with it, goes back if X
//     says no.
//   the ↻ (views/partials/refresh-profile.hbs → POST /people/:id/refresh): re-reads that person from X, then redraws
//     their card from the page itself, which glows once.
//   bulk unfollow (views/follows-back.hbs → POST /follows/back/unfollow): the unfollowed cards fold out.
//   bulk like (views/partials/like-all.hbs, a rail row's ♥, a card's ♥ → POST /inbox/like-all): the hearts it will
//     take flip, the counts move.
//   Mark all done (the toolbar's, a rail row's ✓ → POST /inbox/done-all): what it marks folds away.
//   following a thread's people (views/partials/thread-follow.hbs → POST /inbox/follow-all): the line redraws.
// A like or a reply never moves a card: Done is your call. The ♥ and the reply: the toast says why
// when X refuses (xtoolioToast), and the header's balance takes the cost.
"use strict";

(function () {
  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // A press that can't reach the server at all (no answer, not an error answer): the app restarting (a deploy, a few
  // seconds), the network, or the page being left mid-request (Back right after ♥: the browser cancels it, often after
  // the server already acted). "Couldn't connect" was seen when clicking back.
  //   - The ♥ and Done are repeat-safe (each says which way, on=1|0; a like that's already there is "same" on the
  //     server and isn't charged again), so they retry, over ~7 s: long enough for a restart.
  //   - A reply never retries: a lost answer may mean it was posted, and a retry would post it twice.
  //   - Leaving the page says nothing and undoes nothing; coming back to it from the back/forward cache after an
  //     interrupted press reloads it, so it shows what really happened.
  var pageLeft = false;
  var interrupted = false;
  window.addEventListener("pagehide", function () { pageLeft = true; });
  window.addEventListener("pageshow", function (e) {
    pageLeft = false;
    if (e.persisted && interrupted) location.reload();
  });
  var RETRY_MS = [1000, 2000, 4000];

  // Send a form as it stands NOW: callers read it before touching the page (the ♥ flips its own `on` field for the next
  // press; sending after that flip sent "unlike" for every like, and the server rightly did nothing).
  // { retry: true }: on no answer at all, try again (repeat-safe presses only).
  // { set: { name: value } }: fields sent in place of the form's (THE OPTIMISTIC TOGGLE says which way it sends).
  // { files, library }: pictures to send with it (a reply's, public/js/attach.js: files from your computer, and keys
  // picked from your media) as a multipart body, its CSRF token in the x-csrf-token header (the server's check runs
  // before it reads a multipart body).
  // Every press changes what the server would draw: a view fetched before it is stale (VIEWS IN PLACE).
  var pressed = 0;
  function post(form, opts) {
    pressed++;
    var retry = !!(opts && opts.retry);
    var files = (opts && opts.files) || [];
    var library = (opts && opts.library) || [];
    var headers = { Accept: "application/json" };
    var body;
    if (files.length || library.length) {
      body = new FormData(form);
      files.forEach(function (f) { body.append("media", f, f.name || "picture"); });
      library.forEach(function (k) { body.append("library", k); });
      headers["x-csrf-token"] = form.elements._csrf.value;
    } else {
      body = new URLSearchParams(new FormData(form));
    }
    var set = (opts && opts.set) || {};
    Object.keys(set).forEach(function (k) { body.set(k, set[k]); });
    function attempt(n) {
      return fetch(form.action, { method: "POST", headers: headers, body: body, credentials: "same-origin" }).then(
        function (res) { return res.json().catch(function () { return { ok: false }; }); },
        function (err) {
          if (!retry || pageLeft || n >= RETRY_MS.length) throw err;
          return new Promise(function (r) { setTimeout(r, RETRY_MS[n]); }).then(function () { return attempt(n + 1); });
        }
      );
    }
    return attempt(0);
  }
  // A form sent for a STREAMED answer (Accept: application/x-ndjson; the bulk like, web.js /inbox/like-all): each line
  // as it arrives goes to `onLine`, and the last, { final }, is what this resolves to, as post() would. An answer that
  // isn't a stream (an error before it began) is read as JSON. A stream that ends WITHOUT its final line (the server
  // failed or restarted part way) rejects, as no answer at all does: some writes may have gone, so the caller can't
  // say which. Never retried (the bulk like isn't repeat-safe).
  function postStream(form, onLine) {
    pressed++;
    var body = new URLSearchParams(new FormData(form));
    return fetch(form.action, { method: "POST", headers: { Accept: "application/x-ndjson" }, body: body, credentials: "same-origin" }).then(function (res) {
      if (!res.body || !res.body.getReader || !/ndjson/.test(res.headers.get("content-type") || "")) return res.json().catch(function () { return { ok: false }; });
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buf = "";
      var last = null;
      function take(text) {
        if (!text.trim()) return;
        var m = JSON.parse(text);
        if (m.final) last = m.final;
        else onLine(m);
      }
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) {
            take(buf);
            if (!last) throw new Error("the stream ended without its answer");
            return last;
          }
          buf += decoder.decode(r.value, { stream: true });
          var lines = buf.split("\n");
          buf = lines.pop();
          lines.forEach(take);
          return pump();
        });
      }
      return pump();
    });
  }
  function refused(body) {
    if (window.xtoolioToast) window.xtoolioToast((body && body.text) || "X didn't answer. Try again.", (body && body.kind) || "error");
  }
  // No answer at all. A beat first: the page may be on its way out (pagehide follows the cancel), and then there's
  // nothing to say and nothing to undo. Otherwise `undo` puts the page back and the toast says it.
  function unreachable(message, undo) {
    setTimeout(function () {
      if (pageLeft) { interrupted = true; return; }
      if (undo) undo();
      if (window.xtoolioToast) window.xtoolioToast(message, "error");
    }, 300);
  }
  // Short and sweet, as lib/notices.js's list. The site's name is config's (BRAND_NAME), read off the layout's own meta,
  // never typed here: a renamed copy says its own.
  var brandMeta = document.querySelector('meta[name="apple-mobile-web-app-title"]');
  var BRAND = (brandMeta && brandMeta.content) || "the site";
  var NO_ANSWER = "Couldn't reach " + BRAND + ". Try again.";
  window.xtoolioNoAnswer = NO_ANSWER; // THE words when the server gives no answer (public/js/feedback.js too)
  var NO_ANSWER_REPLY = "Couldn't reach " + BRAND + ". Check X before resending.";
  var NO_ANSWER_BULK = "Connection lost. Reload to see what went through."; // a bulk like / follow / unfollow cut off
  // The write cost money: the header's balance, as the server now has it.
  function balance(body) {
    var el = document.querySelector("[data-header-balance]");
    if (el && body.balance) el.textContent = body.balance;
  }
  // ── THE PAGE IS OPTIMISTIC: THE PRESS IS THE ACTION ──
  // Everything a press changes moves the moment it's pressed (hearts, the rail, the head, the counts, folds); the
  // server's answer only confirms it, or puts it back with a toast when X says no. No press locks its button while it
  // waits, and no answer carries a recount: the page computes its own numbers.

  // THE OWED TABLE (partials/owed-model.hbs, services/inbox.js owedModel): every message still owed a like or a reply in
  // this Inbox, on this page or not, each { id, p (its author), c (its conversation), f (flags) }, in THE BULK LIKE's
  // order. Every number about what's owed is computed from it by ONE recount (the rail's columns and rows, the head's
  // "♥ N to like · ↩ N to reply", People | Posts, the toolbar's Done N replies, every bulk ♥'s N), and a bulk like's
  // messages are taken from it, exactly the ones the server will take (verify-people pins the order). Presses change the
  // table; the recount follows.
  var LIKE = 1, REPLY = 2, LIKEABLE = 4, IN_VIEW = 8;
  var modelEl = null;
  var owedList = [];
  var owedById = {};
  // Read from the page as drawn, and again whenever a view is swapped in (VIEWS IN PLACE).
  function loadModel() {
    modelEl = document.querySelector("[data-owed-model]");
    owedList = [];
    owedById = {};
    if (!modelEl) return;
    try {
      JSON.parse(modelEl.getAttribute("data-owed") || "[]").forEach(function (e) {
        var x = { id: e[0], p: e[1], c: e[2], f: e[3] };
        owedList.push(x);
        owedById[x.id] = x;
      });
    } catch (e) { modelEl = null; }
  }
  loadModel();
  function modelInt(name) { return modelEl ? parseInt(modelEl.getAttribute(name), 10) || 0 : 0; }
  function modelSet(id, what, owed) {
    var e = owedById[id];
    if (!e) return;
    var bit = what === "like" ? LIKE : REPLY;
    e.f = owed ? e.f | bit : e.f & ~bit;
  }
  // Messages marked done leave the table (`test`: which).
  function modelDrop(test) {
    owedList = owedList.filter(function (e) {
      if (!test(e)) return true;
      delete owedById[e.id];
      return false;
    });
  }
  function inScope(e, scope) { return (!scope.person || e.p === scope.person) && (!scope.post || e.c === scope.post); }
  // What a bulk like over `scope` ({ person, post }) takes, in the server's order (inbox.likeTargets): the view's
  // messages still owed a like that the ♥ can take.
  var TARGET = LIKE | LIKEABLE | IN_VIEW;
  function likeTargetsOf(scope) {
    return owedList.filter(function (e) { return (e.f & TARGET) === TARGET && inScope(e, scope); }).map(function (e) { return e.id; });
  }
  // How many one press takes: what's owed, X's window (data-left), the per-press cap (data-max, LIKE_ALL_MAX).
  function pressN(scope) { return Math.min(likeTargetsOf(scope).length, modelInt("data-left"), modelInt("data-max") || 50); }
  // A ♥'s key (partials/rail-row.hbs, card-presses.hbs): "all", a person's id, "post-<id>", "post-<id>-<person>".
  function scopeOfKey(key) {
    if (key === "all") return {};
    var m = /^post-(\d+)(?:-(\d+))?$/.exec(key);
    return m ? { post: m[1], person: m[2] || "" } : { person: key };
  }
  // Many changes, one recount (`batch(fn)`).
  var holding = 0;
  function batch(fn) {
    holding++;
    try { fn(); } finally { holding--; }
    recount();
  }
  function recount() {
    if (!modelEl || holding) return;
    var view = { person: modelEl.getAttribute("data-person") || "", post: modelEl.getAttribute("data-post") || "" };
    var sums = {}, head = { l: 0, r: 0 }, people = {}, posts = {}, waiting = 0;
    owedList.forEach(function (e) {
      var l = e.f & LIKE ? 1 : 0, r = e.f & REPLY ? 1 : 0;
      if (!l && !r) return;
      head.l += l;
      head.r += r;
      if (!(e.f & IN_VIEW)) return;
      people[e.p] = 1;
      posts[e.c] = 1;
      if (inScope(e, view)) waiting++;
      ["all", e.p, "post-" + e.c, "post-" + e.c + "-" + e.p].forEach(function (k) {
        var s = sums[k] || (sums[k] = { l: 0, r: 0 });
        s.l += l;
        s.r += r;
      });
    });
    // ONE pass over the page's numbers (a rail has a couple of hundred rows, two columns each: looking each up on its
    // own, once per message a press retired, froze a phone for seconds), each written only when it changed.
    // The rail's columns and each card's hidden like count (data-count="rail-<like|reply>-<key>").
    document.querySelectorAll('[data-count^="rail-like-"], [data-count^="rail-reply-"]').forEach(function (el) {
      var name = el.getAttribute("data-count");
      var like = name.indexOf("rail-like-") === 0;
      var s = sums[name.slice(like ? 10 : 11)];
      showNumber(el, s ? (like ? s.l : s.r) : 0);
    });
    setCount("owe-like", head.l);
    setCount("owe-reply", head.r);
    setCount("rail-mode-people", Object.keys(people).length);
    setCount("rail-mode-posts", Object.keys(posts).length);
    setCount("done-replies", waiting); // the People view's toolbar: its replies still waiting
    // A row with nothing left in either column leaves the rail, unless it's the one picked, or a post's page (views/
    // conversation.hbs data-rail-keeps: it lists everyone who wrote, owed or not).
    var keeps = !!document.querySelector("[data-rail-keeps]");
    document.querySelectorAll(".rail-row[data-rail-key]").forEach(function (row) {
      var s = sums[row.getAttribute("data-rail-key")];
      var owing = !!s && s.l + s.r > 0;
      if (row.hasAttribute("data-owes-nothing") === owing) row.toggleAttribute("data-owes-nothing", !owing);
      var hide = !owing && !row.classList.contains("on") && !keeps;
      if (row.hidden !== hide) row.hidden = hide;
    });
    // Every bulk ♥ (a rail row's, a card's) says what ONE press takes now; X's window spent, none can be pressed.
    var left = modelInt("data-left");
    document.querySelectorAll("button[data-rail-like][data-like-key]").forEach(function (btn) {
      if (!btn.form) return; // drawn spent (no form)
      var key = btn.getAttribute("data-like-key");
      pressLikes(btn, pressN(scopeOfKey(key)), key === "all");
      btn.toggleAttribute("data-spent", !left);
      btn.disabled = !left;
    });
    // The toolbar's ♥ Like N (partials/like-all.hbs): the view's own; hidden with nothing to take, "More at …" while
    // X's window is spent.
    var box = document.querySelector("[data-like-all]");
    if (box) {
      var owed = likeTargetsOf(view).length;
      var n = pressN(view);
      setCount("like-all-n", n);
      var form = box.querySelector("[data-like-all-form]");
      var spent = box.querySelector("[data-like-all-spent]");
      if (form) {
        form.hidden = n === 0;
        likeConfirm(form.querySelector("button[type=submit]"), n, !view.person && !view.post);
      }
      if (spent) spent.hidden = !(owed > 0 && left === 0);
    }
  }
  // X'S LIKE WINDOW (the table's data-left / data-ends / data-after, from the page and each like's answer, `likes`):
  // the bulk ♥s' N follows it, and counts back up by itself a second after X's window ends.
  var windowTimer = null;
  function allowance(likes) {
    if (!modelEl) return;
    if (likes && typeof likes.left === "number") {
      modelEl.setAttribute("data-left", String(likes.left));
      modelEl.setAttribute("data-ends", likes.ends ? String(likes.ends) : "");
      if (typeof likes.after === "number") modelEl.setAttribute("data-after", String(likes.after));
      var at = document.querySelector("[data-like-all-at]");
      if (at && likes.at) at.textContent = likes.at;
    }
    armWindow();
    recount();
  }
  // Likes sent now spend X's window at once (the answer corrects it).
  function spend(n) {
    if (modelEl) modelEl.setAttribute("data-left", String(Math.max(0, modelInt("data-left") - n)));
  }
  function armWindow() {
    clearTimeout(windowTimer);
    var ends = modelInt("data-ends");
    var after = modelInt("data-after");
    if (!ends || after <= modelInt("data-left")) return;
    // A background tab may fire it late: fine.
    windowTimer = setTimeout(function () {
      modelEl.setAttribute("data-left", String(after));
      modelEl.setAttribute("data-ends", "");
      recount();
    }, Math.max(0, ends - Date.now()) + 1000);
  }

  // THE OPTIMISTIC TOGGLE (the ♥, the ↻'s Repost, THE Follow button, + Save): ONE way an on / off press goes. The page
  // shows the new state at once (`how.show`), never locked: pressed again before X answers, the latest press wins
  // (one request at a time per thing, `how.key`, the next sent only if you changed your mind meanwhile). X's answer is
  // the truth (`how.truth`): different from what was sent, the page takes it; refused or unreachable, the page goes back
  // to what was last confirmed, with the toast. `how.done(body, sent)` takes the rest of a confirmed answer. Each press
  // is repeat-safe (on=1|0: a press matching what's recorded sends nothing to X), so a lost answer retries (post()).
  var toggles = {};
  function toggle(form, how) {
    var key = how.key || form.getAttribute("action");
    var st = toggles[key];
    if (!st) {
      var drawn = form.elements.on.value !== "1"; // the field says the NEXT press's way: "1" while off
      st = toggles[key] = { confirmed: drawn, want: drawn, shown: drawn, busy: false };
    }
    // `final`: the server's word (a confirmation, or going back), not a press.
    function display(v, final) {
      if (st.shown === v) return;
      st.shown = v;
      how.show(v, !!final);
    }
    function back() {
      st.want = st.confirmed;
      display(st.confirmed, true);
    }
    function idle() { if (how.idle) how.idle(); } // nothing in flight for it any more
    function send() {
      var sent = st.want;
      st.busy = true;
      post(form, { retry: true, set: { on: sent ? "1" : "0" } }).then(
        function (body) {
          st.busy = false;
          if (!body.ok) {
            back();
            idle();
            // A ♥ or ↻ on a post deleted on X since: the post leaves the page (goneFromPage).
            if (body.gone) goneFromPage((/\/posts\/(\d+)\//.exec(form.getAttribute("action")) || [])[1]);
            return refused(body);
          }
          st.confirmed = how.truth(body, sent);
          if (st.confirmed !== sent) back(); // the server's word over the guess
          else if (st.want !== sent) return send(); // pressed again meanwhile: send the latest
          idle();
          if (how.done) how.done(body, sent);
        },
        function () {
          st.busy = false;
          unreachable(NO_ANSWER, function () { back(); idle(); });
        }
      );
    }
    st.want = !st.want;
    display(st.want, false);
    if (!st.busy) send();
  }
  // Something else moved a toggle's thing (a bulk like flipped that heart): its next press reads the page again.
  function forgetToggle(key) {
    if (toggles[key] && !toggles[key].busy) delete toggles[key];
  }
  // THE HEADER'S OWN COUNTS (views/layouts/main.hbs [data-me]: "512 following · 480 followers"), the one place they're
  // set in the page: `set` takes the server's numbers (a Follow press's answer; live.js's "me" event), `bump` moves one
  // at once (your own press, before X answers). The raw number rides on data-n, so "1.2K" can still count by one; it's
  // written the way the layout's `compact` helper writes it (lib/hbs.js: the same Intl options).
  var compact = window.Intl ? new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }) : null;
  function meShow(name, n) {
    var el = document.querySelector('[data-me="' + name + '"]');
    if (!el || typeof n !== "number" || !isFinite(n)) return;
    el.setAttribute("data-n", String(n));
    el.textContent = compact ? compact.format(n) : String(n);
  }
  // `v` (Account.countsV): the version the numbers on screen are; an older one arriving late (two processes' "me" notes
  // can land out of order) is ignored.
  window.xtoolioMe = {
    set: function (d) {
      if (!d) return;
      var who = document.querySelector("[data-me-v]");
      if (who && typeof d.v === "number") {
        var shown = parseInt(who.getAttribute("data-me-v"), 10);
        if (isFinite(shown) && d.v <= shown) return;
        who.setAttribute("data-me-v", String(d.v));
      }
      meShow("followers", d.followers);
      meShow("following", d.following);
    },
    bump: function (name, by) {
      var el = document.querySelector('[data-me="' + name + '"]');
      var n = el && parseInt(el.getAttribute("data-n"), 10);
      if (isFinite(n)) meShow(name, Math.max(0, n + by));
    },
  };
  // The page's live counts (views/inbox.hbs): every element with data-count="<name>" shows the same number, and every
  // data-plural="<name>" word agrees with it (its data-one / data-many). → the new number.
  // A number inside a [data-zero] box (the Inbox rail's columns) blanks that box at 0 and brings it back above it.
  function setCount(name, n) {
    document.querySelectorAll('[data-count="' + name + '"]').forEach(function (el) { showNumber(el, n); });
    document.querySelectorAll('[data-plural="' + name + '"]').forEach(function (el) { el.textContent = el.getAttribute(n === 1 ? "data-one" : "data-many"); });
    return n;
  }
  // One number on the page, written only when it changed (a write the page doesn't need still costs it a layout).
  function showNumber(el, n) {
    var text = n.toLocaleString("en-US");
    if (el.textContent !== text) el.textContent = text;
    var box = el.closest("[data-zero]");
    if (box && box.classList.contains("is-zero") !== (n === 0)) box.classList.toggle("is-zero", n === 0);
  }
  function bump(name, by) {
    var el = document.querySelector('[data-count="' + name + '"]');
    if (!el) return null;
    return setCount(name, Math.max(0, (parseInt(el.textContent.replace(/\D/g, ""), 10) || 0) + by));
  }
  // A card left the list on screen: "1–20 of 343" and the toolbar's "✓ Done N" lose one. When nothing matches any more, those
  // go and the empty list's words show; when this page is empty but later pages aren't, the server draws what's left.
  function leftList() {
    bump("list-to", -1);
    var matched = bump("list-matched", -1);
    // Down to one card: the toolbar's Like N and Mark N done are that card's own head's now, so they go (views/inbox.hbs
    // draws them only for more than one).
    if (matched !== null && matched <= 1) {
      ["[data-like-all]", "#all-done-form"].forEach(function (sel) { var el = document.querySelector(sel); if (el) el.remove(); });
    }
    if (matched === 0) {
      ["[data-list-count]", "[data-list-pager]"].forEach(function (sel) { var el = document.querySelector(sel); if (el) el.remove(); });
    }
    if (document.querySelector("[data-inbox-show] .thread")) return;
    if (navigating) return; // a press is already taking the page where the server says (doneAll)
    // The next view comes in place (VIEWS IN PLACE), once any Done still saving is saved (whenSaved: DONE IS
    // OPTIMISTIC), or it would be drawn from before it: this list's later cards, or…
    if (matched) return whenSaved(function () { showView(location.href, { replace: true }); });
    // …narrowed to one person (the rail) and nothing of theirs left: everyone, where they're no longer on the rail.
    var everyone = document.querySelector(".rail-row.on[data-rail-key]") && document.querySelector("[data-rail-everyone]");
    if (everyone) return whenSaved(function () { showView(everyone.href, { replace: true }); });
    var empty = document.querySelector("[data-list-empty]");
    if (empty) empty.hidden = false;
  }

  // ── the ♥ ──
  // THE LIKE LINE, REDRAWN by the server's own partial (GET /posts/:id/likes-line → liked.hbs: the heart and the likers'
  // faces), in every slot of that post on the page. ONE redraw for a like pressed here and one that arrived live
  // (public/js/live.js calls it). Each slot keeps whom its line names besides you (data-person).
  function redrawLikes(postId) {
    document.querySelectorAll('[data-likes-for="' + postId + '"]').forEach(function (slot) {
      var person = slot.getAttribute("data-person");
      var url = "/posts/" + encodeURIComponent(postId) + "/likes-line?back=" + encodeURIComponent(location.pathname + location.search) + (person ? "&person=" + encodeURIComponent(person) : "");
      fetch(url, { credentials: "same-origin" })
        .then(function (res) { return res.ok ? res.text() : null; })
        .then(function (html) { if (html !== null) slot.innerHTML = html; })
        .catch(function () {});
    });
  }
  window.xtoolioRedrawLikes = redrawLikes;
  // A post's like, shown everywhere at once: every ♥ of it on the page (the accent pill liked, the outline heart not)
  // and, for a message still owed one, everything that counts it (owe: the table, the recount, THE COUNTDOWN). Who's in
  // the line (the faces) comes with the server's redraw once X has answered (redrawLikes): the page can't know the other
  // likers' faces. `pending`: not yet confirmed by X, so THE COUNTDOWN holds its press (a refusal would otherwise leave
  // a message marked done that was never liked).
  function likeFormsOf(id) { return document.querySelectorAll('form.like-form[action="/posts/' + id + '/like"]'); }
  // Likes X hasn't confirmed yet (id → the way they were pressed): a view swapped in meanwhile was drawn by the server
  // without them, so they're put on it again (VIEWS IN PLACE, overlayPending).
  var pendingLikes = {};
  function markLiked(id, liked, pending) {
    if (pending) pendingLikes[id] = liked;
    else delete pendingLikes[id];
    likeFormsOf(id).forEach(function (f) { showLiked(f, liked); });
    var msg = document.getElementById("p" + id);
    if (msg && msg.matches(".msg")) {
      msg.toggleAttribute("data-pending", !!pending);
      if (msg.hasAttribute("data-owed-by")) return owe(msg, "like", !liked);
    }
    modelSet(id, "like", !liked);
    recount();
  }
  function settled(id) {
    delete pendingLikes[id];
    var msg = document.getElementById("p" + id);
    if (msg) msg.removeAttribute("data-pending");
  }
  function showLiked(form, liked) {
    var btn = form.querySelector(".like-btn");
    btn.classList.toggle("on", liked);
    // The pill is the line's (partials/liked.hbs .like-line), the faces' links beside the ♥; the redraw sets it as
    // the server has it.
    var line = form.closest(".like-line");
    if (line) line.classList.toggle("liked", liked || !!line.querySelector(".liked-faces"));
    btn.setAttribute("aria-pressed", liked ? "true" : "false");
    btn.setAttribute("aria-label", (liked ? "Unlike" : "Like") + " on X");
    form.elements.on.value = liked ? "0" : "1";
    btn.classList.remove("pop");
    if (liked && !reduced) { void btn.offsetWidth; btn.classList.add("pop"); }
  }
  // ── the ♥ (THE OPTIMISTIC TOGGLE): the heart, the rail, the head, the bulk ♥s' N and THE COUNTDOWN all move on the
  // press; X's answer confirms it (and the faces are redrawn), or puts it all back. ──
  function like(form) {
    var id = (/\/posts\/(\d+)\/like/.exec(form.getAttribute("action")) || [])[1];
    if (!id) return;
    toggle(form, {
      show: function (on, final) {
        markLiked(id, on, !final);
        if (on && !final) spend(1); // a like spends X's window; an unlike has its own
      },
      idle: function () { settled(id); },
      truth: function (body) { return body.liked === true; },
      done: function (body, sent) {
        redrawLikes(id); // the faces, as the server has them now
        if (sent) allowance(body.likes);
        balance(body);
      },
    });
  }

  // ── THE ↻'s Repost (views/partials/repost-button.hbs, the ↻'s menu → POST /posts/:id/repost; the Reposting add-on) ──
  // THE OPTIMISTIC TOGGLE, as the ♥. Choosing it in the menu is the deliberate second click, as on X. Every copy of
  // the post's ↻ on the page moves together: the ↻ in the accent, the menu's item saying Undo repost.
  function showReposted(form, on) {
    var action = form.getAttribute("action");
    document.querySelectorAll("form[data-repost]").forEach(function (f) {
      if (f.getAttribute("action") !== action) return;
      var item = f.querySelector(".repost-item");
      item.setAttribute("aria-pressed", on ? "true" : "false");
      f.querySelector("[data-repost-word]").textContent = on ? "Undo repost" : "Repost";
      var menu = f.closest(".repost-menu");
      if (menu) menu.querySelector(".repost-btn").classList.toggle("on", on);
      f.elements.on.value = on ? "0" : "1";
    });
  }
  function repost(form) {
    toggle(form, {
      show: function (on) { showReposted(form, on); },
      truth: function (body) { return body.reposted === true; },
      done: balance,
    });
  }

  // ── THE Follow button (views/partials/follow-button.hbs → POST /people/:id/follow; the Following extra): a Follows
  // card, a People card, a person's page ──
  // Flips at once and goes back if X says no, like the ♥ (repeat-safe: on=1|0, a press that matches is "same"). The
  // tag in the same [data-person-row] is redrawn by partials/follow-badge.hbs's own rules: Mutual / Follows you /
  // You follow / "—" (a facts column, data-ftag-dash), hidden when there's nothing to say. A person drawn more than once
  // on the page (a conversation's names, partials/follow-inline.hbs) has a Follow button each: every one of theirs moves.
  function showFollow(form, following, followsYou) {
    var action = form.getAttribute("action");
    document.querySelectorAll("form[data-follow]").forEach(function (f) {
      if (f.getAttribute("action") === action) showFollowOne(f, following, followsYou);
    });
  }
  function showFollowOne(form, following, followsYou) {
    var btn = form.querySelector(".follow-btn");
    btn.classList.toggle("on", following);
    btn.setAttribute("aria-pressed", following ? "true" : "false");
    form.elements.on.value = following ? "0" : "1";
    var row = form.closest("[data-person-row]");
    if (!row) return;
    if (typeof followsYou === "boolean") row.toggleAttribute("data-follows-you", followsYou);
    var they = row.hasAttribute("data-follows-you");
    var off = btn.querySelector(".if-off");
    if (off) off.textContent = they ? "Follow back" : "Follow";
    var tag = row.querySelector("[data-ftag]");
    if (!tag) return;
    tag.textContent = they ? (following ? "Mutual" : "Follows you") : following ? "You follow" : "—";
    tag.classList.toggle("mutual", they && following);
    tag.classList.toggle("oneway", !they && following);
    tag.classList.toggle("none", !they && !following);
    tag.hidden = !they && !following && !tag.hasAttribute("data-ftag-dash");
  }
  function follow(form) {
    toggle(form, {
      // The header's "following" moves with the button, and back with it.
      show: function (on) {
        showFollow(form, on);
        window.xtoolioMe.bump("following", on ? 1 : -1);
      },
      truth: function (body) { return body.following === true; },
      done: function (body, sent) {
        if (typeof body.followsYou === "boolean") showFollow(form, body.following === true, body.followsYou);
        if (body.pending && window.xtoolioToast) window.xtoolioToast("Requested. They have to approve it.", "info");
        // The server's numbers when the press moved them; otherwise (a press that matched what was recorded) nothing
        // moved, so the header's guess goes back (a protected account's request already went back with the button).
        if (body.me) window.xtoolioMe.set(body.me);
        else if ((body.following === true) === sent) window.xtoolioMe.bump("following", sent ? -1 : 1);
        balance(body);
      },
    });
  }

  // ── BULK UNFOLLOW (views/follows-back.hbs #unfollow-many → POST /follows/back/unfollow) ──
  // In place, like Mark done: the modal's button spins while X unfollows them one by one (the header's "following"
  // counts down meanwhile, live.js's "me"), then the modal closes, each unfollowed card folds out and the toast says how
  // many (X's limit used up: the header's countdown, live.js "limits"). A page left empty goes to the server, which draws what's
  // left (a plain reload landed past the list's new end, on cards still followed: "it didn't work").
  // Not retried: a lost answer can't say which went, so it says to reload.
  function unfollowMany(form) {
    if (form.hasAttribute("data-sending")) return;
    var buttons = Array.prototype.slice.call(form.querySelectorAll("button[type=submit]")).concat(Array.prototype.slice.call(document.querySelectorAll('button[form="' + form.id + '"]')));
    function busy(on) {
      form.toggleAttribute("data-sending", on);
      buttons.forEach(function (b) { b.disabled = on; b.classList.toggle("busy", on); b.setAttribute("aria-busy", on ? "true" : "false"); });
    }
    var sent = post(form);
    busy(true);
    sent
      .then(function (body) {
        var dialog = document.getElementById("unfollow-confirm");
        if (dialog && dialog.open) dialog.close();
        if (!body.ok) return refused(body);
        if (body.me) window.xtoolioMe.set(body.me);
        balance(body);
        var cards = (body.done || []).map(function (id) { return document.querySelector('.pcards [data-person-row="' + id + '"]'); }).filter(Boolean);
        if (cards.length && cards.length === document.querySelectorAll(".pcards [data-person-row]").length) return location.replace(body.href);
        cards.forEach(function (card) { fold(card, function () { document.dispatchEvent(new Event("picks:changed")); }); });
        if (window.xtoolioToast && body.text) window.xtoolioToast(body.text, body.kind || "info");
      })
      .catch(function () { unreachable(NO_ANSWER_BULK); })
      .then(function () { busy(false); });
  }

  // ── FOLLOW A THREAD (views/partials/thread-follow.hbs → POST /inbox/follow-all) ──
  // The pressed button spins while X follows them one by one (the header's "following" counts up meanwhile, live.js's
  // "me"); then the server's own numbers, the presses redrawn (fewer left, or hidden once you follow everyone) and the
  // toast.
  // Never retried: a second send follows the next ones.
  function followAll(form) {
    var btn = form.querySelector("button[type=submit]");
    if (btn.disabled) return;
    var all = document.querySelectorAll("[data-thread-follow] button");
    function busy(on) {
      Array.prototype.forEach.call(all, function (b) { b.disabled = on; });
      btn.classList.toggle("busy", on);
      btn.setAttribute("aria-busy", on ? "true" : "false");
    }
    var sent = post(form);
    busy(true);
    sent
      .then(function (body) {
        if (!body.ok) return refused(body);
        if (body.me) window.xtoolioMe.set(body.me);
        balance(body);
        var line = document.querySelector("[data-thread-follow]");
        if (line && body.html) line.outerHTML = body.html;
        // Everyone it followed: their Follow buttons on this page say Following now (a post's page lists them as rows;
        // the Inbox draws one beside each name).
        (body.done || []).forEach(function (id) {
          var f = document.querySelector('form[data-follow][action="/people/' + id + '/follow"]');
          if (f) showFollow(f, true);
        });
        if (window.xtoolioToast && body.text) window.xtoolioToast(body.text, body.kind || "info");
      })
      .catch(function () { unreachable(NO_ANSWER_BULK); })
      .then(function () { if (btn.isConnected) busy(false); });
  }

  // ── the ↻ (views/partials/refresh-profile.hbs → POST /people/:id/refresh): a People card, a Follows card, a
  // person's page ──
  // Halfway down a list, a reload lost your place. So: the arrow spins while X is asked, then the
  // card around it ([data-person-row]) is redrawn from the page itself, fetched again (the server's own markup, every
  // surface alike: no second copy of a card's rules here), which glows once (success: a shake would read as "no"), and
  // the toast says whose ("Refreshed @maya from X."). A card that's no longer on this
  // page (it left the list's filter) stays as it was; the next load has it right.
  function refresh(form) {
    var btn = form.querySelector("button");
    if (btn.disabled) return;
    var row = form.closest("[data-person-row]");
    var id = row && row.getAttribute("data-person-row");
    btn.disabled = true;
    btn.classList.add("busy");
    post(form, { retry: true }) // a read: repeat-safe, and a second press within 10 minutes reads nothing
      .then(function (body) {
        if (!body.ok) return refused(body);
        balance(body);
        if (body.text && window.xtoolioToast) window.xtoolioToast(body.text, body.kind || "info");
        if (!body.read || !row) return;
        return fetch(location.pathname + location.search, { credentials: "same-origin", headers: { Accept: "text/html" } })
          .then(function (res) { if (!res.ok) throw new Error(res.status); return res.text(); })
          .then(function (html) {
            var doc = new DOMParser().parseFromString(html, "text/html");
            if (!window.xtoolioSameAccount(doc)) throw new Error("another account"); // swap.js: the plain reload
            var fresh = doc.querySelector('[data-person-row="' + id.replace(/"/g, "") + '"]');
            if (!fresh || !row.isConnected) return;
            var node = document.importNode(fresh, true);
            row.replaceWith(node);
            node.classList.add("refreshed"); // a glow (app.css; reduced motion: without the pop)
            node.addEventListener("animationend", function (e) { if (e.target === node) node.classList.remove("refreshed"); });
          })
          .catch(function () { location.reload(); }); // the read happened; the plain way shows it
      })
      .catch(function () { unreachable(NO_ANSWER); })
      .then(function () { if (btn.isConnected) { btn.disabled = false; btn.classList.remove("busy"); } });
  }

  // ── the reply box ──
  // The meta line: how long it is (X's 280 without Premium), and a warning when it has a link, which makes it X's
  // "with URL" price (the same test as lib/pricing.js hasLink).
  var LINK = /https?:\/\/|\bwww\.|\b[a-z0-9-]+\.(com|org|net|io|ai|co|dev|app|xyz|me|so|gg|ly|tv|fm|news|info|us|uk|ca)\b/i;
  function meta(form) {
    var text = form.elements.text.value;
    var el = form.querySelector("[data-reply-meta]");
    var link = LINK.test(text);
    // No price unless it jumps: the length while you type, and the link price as a warning when there's a link.
    el.textContent = !text.length ? "" : text.length + " / 280" + (link ? " · has a link: " + form.getAttribute("data-link-price") : "");
    el.classList.toggle("warn", link || text.length > 280);
    mirror(form);
    // Grow with the text.
    form.elements.text.style.height = "auto";
    form.elements.text.style.height = form.elements.text.scrollHeight + "px";
    keepInView(form);
  }
  // THE @HANDLES IN ACCENT (partials/reply-box.hbs .compose): the box's text copied into the layer under it, each @handle
  // (X's: 1-15 letters, digits or _, not inside a word or an address) in its own span. Every change runs meta(), so
  // this follows typing, an emoji, a draft, a reset. A zero-width space at the end keeps a trailing line break's height.
  var AT = /(^|[^A-Za-z0-9_@])(@[A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/g;
  function mirror(form) {
    var under = form.querySelector("[data-compose-mirror]");
    if (!under) return;
    var text = form.elements.text.value;
    var frag = document.createDocumentFragment();
    var last = 0;
    var m;
    AT.lastIndex = 0;
    while ((m = AT.exec(text))) {
      var at = m.index + m[1].length;
      frag.appendChild(document.createTextNode(text.slice(last, at)));
      var span = document.createElement("span");
      span.className = "c-at";
      span.textContent = m[2];
      frag.appendChild(span);
      last = at + m[2].length;
    }
    frag.appendChild(document.createTextNode(text.slice(last) + "​"));
    under.replaceChildren(frag);
    under.parentNode.classList.add("on");
  }
  // In the phone's sheet, the end of what you type stays above the keyboard: the box grows with the text and iOS doesn't
  // always scroll the sheet after the caret (a long message above and a long reply put the reply's end under the
  // keyboard). Only while typing at the end; the sheet's own bottom is the keyboard's top (fitSheet).
  function keepInView(form) {
    var here = form.closest(".reply-here.sheet[open]");
    var text = form.elements.text;
    if (!here || text.selectionEnd < text.value.length) return;
    var under = form.querySelector("[data-reply-meta]").getBoundingClientRect().bottom + 12 - here.getBoundingClientRect().bottom;
    if (under > 0) here.scrollTop += under;
  }
  // While it's on its way to X: the button spins and can't be pressed again, the text can't change under it.
  function sending(form, on) {
    // Both Replys: the foot's, and the phone sheet's at the top right (partials/reply-box.hbs).
    Array.prototype.forEach.call(form.querySelectorAll("button[type=submit]"), function (btn) {
      btn.disabled = on;
      btn.classList.toggle("busy", on);
      btn.setAttribute("aria-busy", on ? "true" : "false");
    });
    form.elements.text.readOnly = on;
  }
  // A REPLY OF YOURS LANDS under the message it answers (`msg`), after any earlier answers to it (people.chatOrder draws
  // it there on reload too), and the message owes no reply now. ONE placement for a reply sent from here and one you made
  // on X that arrived live (xtoolioYourReply below). Whichever comes second finds it on the page and adds nothing (X's
  // echo of a reply sent from here can beat the send's own answer). → the placed .msg, or null.
  // `html`: the server's bubble, or a node (the reply on its way, sendingBubble).
  function placeReply(msg, id, html) {
    owe(msg, "reply", false);
    if (!msg || !html) return null;
    if (id && document.getElementById("p" + id)) return document.getElementById("p" + id);
    var insert = function (where, at) {
      if (typeof html === "string") return at.insertAdjacentHTML(where, html);
      at.insertAdjacentElement(where, html);
    };
    // An answer to a post in the box (.seed-post) starts a branch at its time (people.chatOrder): the conversation's end.
    if (msg.matches(".seed-post")) {
      var card = msg.closest(".thread");
      var chat = card && card.querySelector(".chat");
      if (!chat && card) { // nobody else wrote in it yet: no chat drawn (thread.hbs)
        var dialogue = node("div", "dialogue");
        chat = node("div", "chat");
        dialogue.appendChild(chat);
        card.appendChild(dialogue);
      }
      if (!chat) return null;
      insert("beforeend", chat);
      return chat.lastElementChild;
    }
    // At the end of what's under the message (people.chatOrder's tree: the newest answer is its last child).
    var after = msg, under = {};
    under[msg.id.slice(1)] = true;
    for (var next = msg.nextElementSibling; next; next = next.nextElementSibling) {
      if (next.matches("hr.msg-rule")) continue;
      if (!next.matches(".msg") || !under[next.getAttribute("data-reply-of")]) break;
      under[next.id.slice(1)] = true;
      after = next;
    }
    insert("afterend", after);
    var placed = after.nextElementSibling;
    while (placed && !placed.matches(".msg")) placed = placed.nextElementSibling;
    // THE THREAD LINE as a reload draws it (people.runsOf joinsNext; a reply sent here once drew no line
    // until a reload): landing right under the message it answers joins them. Under
    // earlier answers instead, the reload's "Replying to" says it; not drawn here.
    if (after === msg) {
      msg.classList.remove("join-when-open", "join-when-shut");
      msg.classList.add("joins-next");
    }
    return placed;
  }
  // DONE ON X ITSELF (a post's On X, or X's own app), arriving live (public/js/live.js): the page catches up as if
  // it had been pressed here (without it, a reply made through On X didn't show here). Your reply:
  // drawn by the server (GET /posts/:id/bubble) and placed under the message it answers, when that's on this page; the
  // rail and the head's "to reply" move. Your like: that message owes no like (its line is redrawn by live.js).
  // → whether the reply had a place here (else live.js lights the conversation's pill).
  window.xtoolioYourReply = function (id, replyOf) {
    // One sent from here still on its way to it: its own answer puts the real one in its place.
    if (replyOf && document.querySelector('.msg[data-sending-for="' + replyOf + '"]')) return true;
    var msg = replyOf && document.getElementById("p" + replyOf);
    if (!msg || !msg.matches(".msg")) return false;
    fetch("/posts/" + encodeURIComponent(id) + "/bubble?back=" + encodeURIComponent(location.pathname + location.search), { credentials: "same-origin" })
      .then(function (res) { return res.ok ? res.text() : null; })
      .then(function (html) { if (html) placeReply(msg, id, html); })
      .catch(function () {});
    return true;
  };
  window.xtoolioYourLike = function (postId) {
    var msg = document.getElementById("p" + postId);
    if (msg && msg.matches(".msg")) owe(msg, "like", false);
  };
  // A REPLY IS OPTIMISTIC TOO (it spun on its Reply button until X answered, half a second or several): on the press
  // your reply lands under the message at once, as it will look (sendingBubble: your face, "You", your words and
  // pictures), faded and saying "Sending…", the composer closes, and the message owes no reply (the rail and the head
  // move). It's the one write that can't just flip: X's answer brings the real post (its id, its pictures as X hosts
  // them), which takes the sending one's place. X says no, or no answer at all: the sending one goes, the composer
  // opens again with everything in it, and the toast says why (no answer: check X before sending again, since it may
  // have gone; if it did, X's own echo puts it on the page). Never retried. THE COUNTDOWN never presses Done on a
  // message whose reply X hasn't confirmed (data-reply-pending). A view swapped in waits for it (hold), so it's drawn
  // with the reply.
  function sendingBubble(form, text) {
    var bubble = node("div", "msg me run-start is-sending");
    var av = node("span", "msg-av");
    var mine = document.querySelector(".top-me .avatar");
    if (mine) av.appendChild(mine.cloneNode(true));
    var col = node("div", "msg-col");
    var head = node("div", "msg-meta");
    var name = node("span", "msg-name");
    name.textContent = "You";
    var dot = node("span", "msg-dot");
    dot.textContent = "·";
    var when = node("span", "post-time");
    when.textContent = "Sending…";
    head.appendChild(name);
    head.appendChild(document.createTextNode(" "));
    head.appendChild(dot);
    head.appendChild(document.createTextNode(" "));
    head.appendChild(when);
    var box = node("div", "bubble");
    if (text) {
      var words = node("div", "text");
      words.textContent = text;
      box.appendChild(words);
    }
    // The pictures as the composer shows them (attach.js's preview tiles), without their ✕.
    var strip = form.querySelector("[data-attach-strip]:not([hidden])");
    if (strip && strip.children.length) {
      var pics = strip.cloneNode(true);
      pics.removeAttribute("data-attach-strip");
      pics.querySelectorAll(".attach-remove").forEach(function (x) { x.remove(); });
      box.appendChild(pics);
    }
    col.appendChild(head);
    col.appendChild(box);
    bubble.appendChild(av);
    bubble.appendChild(col);
    return bubble;
  }
  function reply(form) {
    var files = window.xtoolioAttach ? window.xtoolioAttach.files(form) : [];
    var library = window.xtoolioAttach ? window.xtoolioAttach.picked(form) : [];
    var text = form.elements.text.value.trim();
    if (form.hasAttribute("data-sending") || (!text && !files.length && !library.length)) return;
    var msg = form.closest(".msg, .seed-post");
    var sent = post(form, { files: files, library: library }); // built before anything moves
    hold(sent);
    sending(form, true);
    form.setAttribute("data-sending", "");
    // The page moves now: your reply under the message, the composer closed (its "close" below tidies up), the draft
    // line gone (the server deletes the draft with the send).
    var bubble = sendingBubble(form, text);
    bubble.setAttribute("data-sending-for", msg ? msg.id.slice(1) : "");
    if (msg) msg.setAttribute("data-reply-pending", "");
    var placed = placeReply(msg, null, bubble);
    var draft = msg && msg.querySelector(".msg-draft");
    if (draft) draft.hidden = true;
    var here = form.closest(".reply-here");
    var sheet = here && here.classList.contains("sheet");
    if (here && here.open) here.close();
    if (sheet && placed) placed.scrollIntoView({ block: "center" }); // from the phone's sheet: where it landed
    function done() {
      sending(form, false);
      form.removeAttribute("data-sending");
      if (msg) msg.removeAttribute("data-reply-pending");
    }
    // Back as it was: no reply, the message owing one again, the composer open with your words and pictures.
    function undo() {
      bubble.remove();
      done();
      if (draft) draft.hidden = false;
      if (msg) owe(msg, "reply", true);
      var link = msg && msg.querySelector("[data-reply-to]");
      if (link && here && !here.open && here.isConnected) openReply(link, here);
    }
    sent
      .then(function (body) {
        if (!body.ok && body.gone) {
          // Deleted on X: nothing to answer any more. The sending reply goes, and the message after it (goneFromPage).
          bubble.remove();
          done();
          refused(body);
          return goneFromPage(msg && msg.id.slice(1));
        }
        if (!body.ok) {
          undo();
          return refused(body);
        }
        done();
        balance(body);
        if (window.xtoolioAttach) window.xtoolioAttach.clear(form);
        form.elements.text.value = "";
        meta(form);
        if (draft) draft.remove();
        // The real post in the sending one's place (or, X's echo having put it on the page already, just that).
        if (document.getElementById("p" + body.id) || !body.html) return bubble.remove();
        var real = document.createElement("template");
        real.innerHTML = body.html.trim();
        if (bubble.isConnected) bubble.replaceWith(real.content);
        else if (msg && msg.isConnected) placeReply(msg, body.id, body.html);
      })
      .catch(function () { unreachable(NO_ANSWER_REPLY, undo); });
  }

  // ── A POST DELETED ON X (a reply, a ♥ or a ↻ refused with { gone: true }: the server marked it gone, and a reload no
  // longer draws it, people.exchangeWith) leaves the page the same way, GRACEFULLY: its reply box closes, its foot
  // becomes a red "Deleted on X" (one small shake: an error's beat), and a moment later it folds out as a Done would,
  // out of THE OWED TABLE with every count moving (retireMsg), or just folds when it owed nothing. The red toast says
  // it too. A thread's seed stays, wearing the note: the replies under it are still there. (It used to stay put, its
  // composer opening again on every try.) ──
  var GONE_HOLD_MS = 1600;
  function goneFromPage(id) {
    var el = id && document.getElementById("p" + id);
    if (!el || el.classList.contains("is-gone")) return;
    var here = el.querySelector(".reply-here");
    if (here && here.open) here.close();
    el.classList.add("is-gone");
    var note = node("p", "gone-note");
    note.textContent = "Deleted on X";
    var foot = el.querySelector(".post-foot");
    if (foot) {
      foot.hidden = true;
      foot.parentNode.insertBefore(note, foot);
    } else {
      el.appendChild(note);
    }
    if (!el.matches(".msg")) return;
    setTimeout(function () {
      if (!el.isConnected) return;
      var card = el.closest(".thread");
      if (card && el.hasAttribute("data-owed-by")) return retireMsg(el, true);
      fold(el, function () { if (card) relink(card); });
    }, reduced ? 0 : GONE_HOLD_MS);
  }

  // ── A DRAFT your agent left on a message (partials/draft-line.hbs; models/Draft.js). Its line opens the reply box,
  // which the server drew holding the words. ✕ discards it in place; a reply sent from the box drops the line (the server
  // deleted the draft with the send); one arriving live is drawn by the server and put under the message's foot. ──
  function boxOf(msg) {
    var form = msg && msg.querySelector("form[data-reply]");
    return form && form.elements.text;
  }
  function dropDraftLine(msg) {
    var line = msg && msg.querySelector(".msg-draft");
    if (line) line.remove();
  }
  // At once; the discard is sent behind it (a draft that didn't go is drawn again on the next load, with the toast now).
  function discardDraft(form) {
    var msg = form.closest(".msg");
    var line = form.closest(".msg-draft");
    var words = line && line.querySelector("[data-draft-text]");
    var box = boxOf(msg);
    var sent = post(form, { retry: true }); // built before the line (and the form in it) leaves the page
    // The box keeps anything you changed; only the untouched draft goes with it.
    if (box && words && box.value === words.textContent) {
      box.value = "";
      meta(box.form);
    }
    dropDraftLine(msg);
    sent.then(function (body) { if (!body.ok) refused(body); }).catch(function () { unreachable(NO_ANSWER); });
  }
  // live.js: a draft for message `postId` was saved. Drawn by the server; the box takes the words unless you've
  // started typing something else.
  window.xtoolioDraft = function (postId) {
    var msg = document.getElementById("p" + postId);
    if (!msg || !msg.matches(".msg")) return;
    fetch("/drafts/" + encodeURIComponent(postId) + "?back=" + encodeURIComponent(location.pathname + location.search), { credentials: "same-origin" })
      .then(function (res) { return res.ok ? res.text() : null; })
      .then(function (html) {
        if (!html || !msg.isConnected) return;
        var old = msg.querySelector(".msg-draft");
        var box = boxOf(msg);
        var before = old && old.querySelector("[data-draft-text]");
        var untouched = box && (!box.value.trim() || (before && box.value === before.textContent));
        if (old) old.remove();
        var foot = msg.querySelector(".post-foot");
        if (!foot) return;
        foot.insertAdjacentHTML("afterend", html);
        var words = msg.querySelector(".msg-draft [data-draft-text]");
        if (box && untouched && words) {
          box.value = words.textContent;
          meta(box.form);
        }
      })
      .catch(function () {});
  };

  // ── DONE IS OPTIMISTIC (Mark done used to pause while the server answered) ──
  // A Done (the card's, one message's) moves the page AT ONCE: the confetti, the counts, the fold. The save goes in the
  // background (the route records the mark, recounts the red count and the rail's People | Posts, ~1 s or more), and its
  // answer brings only what the page can't know: the toast's Undo and the server's counts. What LEAVES the page (an
  // emptied view going to Everyone, a list reloading for its next page) waits for every save in flight (`whenSaved`), or
  // the next page would be drawn from before the mark. A save that fails (refused, or no answer after post()'s retries)
  // puts the page back by reloading it from the server, saying so (`done-failed`): the page has already folded things
  // away, and the server is the truth.
  // (A like in flight isn't waited for: a view drawn before X confirms it gets it put back on, pendingLikes.)
  var inFlight = Promise.resolve();
  var saveFailed = false;
  var navigating = false; // a press is taking the page to another view once saved (doneAll): leftList stands aside
  function saving(sent) {
    inFlight = Promise.all([inFlight, sent.then(function (body) { if (!body.ok) saveFailed = true; }, function () { saveFailed = true; })]);
  }
  // A reply on its way is waited for too (seconds at most), but its failure is its own to handle.
  function hold(sent) {
    inFlight = Promise.all([inFlight, sent.then(function () {}, function () {})]);
  }
  function whenSaved(go) {
    inFlight.then(function () { if (!saveFailed) go(); });
  }
  // The page showed something the server didn't take (or never answered about): reload it from the server, the
  // toast (`n`, lib/notices.js) saying so.
  function reloadWith(n) {
    saveFailed = true;
    setTimeout(function () {
      if (pageLeft) { interrupted = true; return; } // on its way out: the back/forward cache reloads it (pageshow)
      var u = new URL(location.href);
      u.searchParams.set("n", n);
      u.searchParams.delete("u");
      location.replace(u.pathname + u.search + u.hash);
    }, 300);
  }
  function doneFailed() { reloadWith("done-failed"); }

  // ── an Inbox card's Done ──
  // Marked done (or reopened): the card leaves the tab it no longer belongs in (Waiting after "Mark done", Done after
  // Reopen; in All it stays and its button flips), and one card moves between the Waiting and Done counts. At once
  // (DONE IS OPTIMISTIC, above).
  function done(form) {
    var btn = form.querySelector("button[type=submit]");
    if (btn.disabled) return;
    var marking = form.elements.on.value === "1";
    // In the rail's person view (partials/card-presses.hbs data-done-person): just their messages are done; the card
    // stays waiting while anyone else's in it isn't, and it leaves their list either way.
    var person = marking && form.getAttribute("data-done-person");
    var cardDone = marking && !(person && form.hasAttribute("data-others-waiting"));
    var sent = post(form, { retry: true }); // built before the button flips the form
    saving(sent);
    btn.disabled = true;
    var card = form.closest(".thread");
    // Read before anything moves: whether this Done empties a view narrowed to one person or post.
    var emptied = marking && emptiesView(card, person);
    // (The People view's "✓ Done N replies" follows THE OWED TABLE: handledRail takes this card's out of it.)
    var leaving = cardTabs(card, marking, person);
    if (marking) handledRail(card, person);
    // Reopened where the card stays (All): what its messages owe again isn't on the page; the server redraws the view,
    // in place, where you are.
    else if (!leaving && document.querySelector(".rail")) whenSaved(function () { showView(location.href, { replace: true, keepScroll: true }); });
    form.elements.on.value = marking ? "0" : "1";
    card.classList.toggle("done", !!cardDone);
    // The button says the card's state (partials/card-presses.hbs): ✓ Done, reading Reopen under the pointer, or the
    // press Mark done. Marking done is celebrated: the button pops and confetti bursts from it; a card leaving holds
    // a beat so you see it, then folds. While it pops (.just-done) the pointer still on it doesn't turn it to Reopen.
    btn.classList.toggle("is-done", marking);
    btn.classList.remove("just-done");
    if (marking) {
      void btn.offsetWidth;
      btn.classList.add("just-done");
      burst(btn);
      setTimeout(function () { btn.classList.remove("just-done"); }, 1500);
    }
    // An emptied view stays as it is under the confetti until the save lands and Everyone loads.
    if (leaving && !emptied) setTimeout(function () { fold(card); }, marking && !reduced ? 450 : 0);
    sent
      .then(function (body) {
        if (!body.ok) return doneFailed();
        // Every Done is undoable from its toast (POST /inbox/undo puts the card's mark back as it was).
        if (marking && body.undo && window.xtoolioToast) window.xtoolioToast(body.text || "Done.", "info", body.undo);
        if (emptied) whenSaved(function () { showView(emptied, { replace: true }); });
      })
      .catch(doneFailed)
      .then(function () { if (btn.isConnected) btn.disabled = false; });
  }
  // A whole card marked done (or not): the tabs count this view's cards. In a person's view, theirs: a card they're done
  // in leaves Waiting and All (done owes nothing, so it's never in their Done); everywhere else, one card moves between
  // Waiting and Done. → whether the card leaves the list on screen.
  function cardTabs(card, marking, person) {
    if (person) {
      bump("tab-waiting", -1);
      bump("tab-all", -1);
    } else {
      bump("tab-waiting", marking ? -1 : 1);
      bump("tab-done", marking ? 1 : -1);
    }
    return leaves(card, marking, person);
  }
  function leaves(card, marking, person) {
    var list = card.closest("[data-inbox-show]");
    return !!person || !!(list && list.getAttribute("data-inbox-show") === (marking ? "waiting" : "done"));
  }
  // A Done that empties a view narrowed to one person or post (the rail, the phone's drill-in): back to everyone, IN
  // PLACE (VIEWS IN PLACE) as soon as the save lands, this view left as it is under the confetti until then, the toast
  // and its Undo shown with the answer. (It reloaded the whole page there: the stall after finishing someone; before
  // that it waited for the folds, ~0.8 s, so on a phone "← Inbox" and the name sat over an empty page.) leftList stays
  // the fallback (no script timing, reduced motion). Read BEFORE the press moves anything (the list's count is still
  // this card's). → null, or Everyone's address.
  function emptiesView(card, person) {
    if (!leaves(card, true, person)) return null;
    var matched = document.querySelector('[data-count="list-matched"]');
    if (!matched || (parseInt(matched.textContent.replace(/\D/g, ""), 10) || 0) > 1) return null;
    var everyone = document.querySelector(".rail-row.on[data-rail-key]") && document.querySelector("[data-rail-everyone]");
    return everyone ? everyone.href : null;
  }

  // ── ONE message's Done (partials/bubble.hbs, in its top-right corner: it folds just that message) ──
  // THE message-level mark (POST /inbox/done `handled`): what it owed leaves the rail and the head, it folds out, and
  // the card's own Done stops counting it. Once nothing the view is about waits in the card (a person's view: theirs),
  // the card has gone done: it moves tabs as the card's own Done would and folds too (in All it stays, ✓ Done).
  // `finished`: the countdown pressed it, and its button already reads "✓ Done", full: it stays so until the burst (it
  // used to read "Mark done" for the moment X took to answer), and only
  // a failed save reloads the page from the server (DONE IS OPTIMISTIC, above).
  function doneMsg(form, finished) {
    var btn = form.querySelector("button[type=submit]");
    if (btn.disabled) return;
    if (!inInbox()) return doneQuietly(form, !finished);
    countdown(form.closest(".msg"), false, finished); // pressed (or counted down): no second press from the clock
    var sent = post(form, { retry: true });
    saving(sent);
    btn.disabled = true;
    burst(btn); // finishing: the card Done's confetti
    var msg = form.closest(".msg");
    var card = msg.closest(".thread");
    var cardForm = card.querySelector("form[data-done]");
    var person = cardForm && cardForm.getAttribute("data-done-person");
    var id = form.elements.handled.value;
    // Read before anything moves (emptiesView reads the list's count): this message is the view's last.
    var othersOwed = Array.prototype.filter.call(card.querySelectorAll(person ? '[data-owed-by="' + person + '"]' : "[data-owed-by]"), function (m) { return m !== msg; });
    var emptied = !othersOwed.length && emptiesView(card, person);
    sent
      .then(function (body) {
        if (!body.ok) return doneFailed();
        if (body.undo && window.xtoolioToast) window.xtoolioToast(body.text || "Done.", "info", body.undo);
        if (emptied) whenSaved(function () { showView(emptied, { replace: true }); });
      })
      .catch(doneFailed)
      .then(function () { if (btn.isConnected) btn.disabled = false; });
    // The page moves now; an emptied view stays as it is under the confetti until the save lands and Everyone loads.
    if (emptied) return;
    retireMsg(msg, true); // its button keeps the finished look until it folds
  }
  // One message marked done, IN THE PAGE (its own Done, or a rail ✓ taking a person's): out of THE OWED TABLE (the
  // rail, the head, Done N replies follow), out of the card's Done, folded away with your answers to it and the chain it
  // was the only reason to show; a card with nothing left that the view is about moves tabs as its own Done would.
  // `keep`: its Done button keeps the look it has (doneMsg already stopped THE COUNTDOWN).
  function untable(msg, keep) {
    var id = msg.id.slice(1);
    ["data-owed-by", "data-owe-like", "data-owe-reply"].forEach(function (a) { msg.removeAttribute(a); });
    countdown(msg, false, keep);
    modelDrop(function (e) { return e.id === id; });
  }
  function retireMsg(msg, keep) {
    var card = msg.closest(".thread");
    var cardForm = card.querySelector("form[data-done]");
    var person = cardForm && cardForm.getAttribute("data-done-person");
    var id = msg.id.slice(1);
    untable(msg, keep);
    recount();
    if (cardForm) {
      var waiting = (parseInt(cardForm.getAttribute("data-waiting"), 10) || 1) - 1;
      cardForm.setAttribute("data-waiting", String(waiting));
      if (cardForm.elements.handled) cardForm.elements.handled.value = cardForm.elements.handled.value.split(",").filter(function (h) { return h && h !== id; }).join(",");
    }
    var cardGoes = !card.querySelector(person ? '[data-owed-by="' + person + '"]' : "[data-owed-by]");
    var rule = msg.previousElementSibling && msg.previousElementSibling.matches("hr.msg-rule") ? msg.previousElementSibling : null;
    // Your answers to it go with it, as a reload folds them
    // (inbox.splitReopened), except one a still-waiting message answers: it's that one's context.
    card.querySelectorAll('.msg.me[data-reply-of="' + id + '"]').forEach(function (mine) {
      if (card.querySelector('.msg[data-owed-by][data-reply-of="' + mine.id.slice(1) + '"]')) return;
      fold(mine, function () {});
    });
    // And what it ANSWERED, kept in view only as its context (inbox.splitReopened: a waiting message keeps the chain
    // it answers in view; without this, marking someone's reply done left the post of yours it answered in view): up the
    // chain, each post nothing still waiting needs goes too.
    var needed = {};
    card.querySelectorAll(".chat .msg[data-owed-by]").forEach(function (m) {
      if (m === msg) return;
      for (var up = m; up; up = up.getAttribute("data-reply-of") && card.querySelector("#p" + up.getAttribute("data-reply-of"))) needed[up.id] = true;
    });
    for (var up = msg.getAttribute("data-reply-of") && card.querySelector(".chat #p" + msg.getAttribute("data-reply-of")); up && up.offsetParent && !needed[up.id] && !up.hasAttribute("data-owed-by"); ) {
      var above = up.getAttribute("data-reply-of") && card.querySelector(".chat #p" + up.getAttribute("data-reply-of"));
      fold(up, function () {});
      up = above;
    }
    fold(msg, function () {
      if (rule) rule.remove();
      relink(card);
      // A line opens a message only after another one (people.chatOrder): the first left at a list's top loses it.
      card.querySelectorAll("hr.msg-rule").forEach(function (hr) {
        var before = hr.previousElementSibling;
        if (!before || !before.classList.contains("msg")) hr.remove();
      });
      foldCount(card);
      if (!cardGoes) return;
      var leaving = cardTabs(card, true, person);
      if (leaving) return fold(card);
      cardDoneInPlace(card);
    });
  }
  // A card gone done where it stays (the All tab, a conversation's page): it says so, its Done now Reopen.
  function cardDoneInPlace(card) {
    card.classList.add("done");
    var cardForm = card.querySelector("form[data-done]");
    if (!cardForm) return;
    cardForm.elements.on.value = "0";
    cardForm.querySelector("button[type=submit]").classList.add("is-done");
  }
  // THE INBOX IS THE WORKSPACE: only there does finishing a reply celebrate (the countdown, the confetti, the fold).
  // Anywhere else (a conversation's page, a post's page) a reply you've liked AND answered is still marked done, but
  // quietly: its Mark done becomes the finished "✓ Done" in place, as a reload draws it, nothing folds and nothing bursts.
  // Pressed by hand it keeps the toast's Undo; marked by itself it says nothing.
  function inInbox() {
    return !!document.querySelector(".inbox-page");
  }
  function doneQuietly(form, withToast) {
    var btn = form.querySelector("button[type=submit]");
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    var sent = post(form, { retry: true }); // built before the form leaves the page
    saving(sent);
    var msg = form.closest(".msg");
    untable(msg);
    recount();
    var finished = document.createElement("span");
    finished.className = "msg-finished";
    finished.textContent = "✓ Done";
    form.replaceWith(finished);
    sent
      .then(function (body) {
        if (!body.ok) return doneFailed();
        if (withToast && body.undo && window.xtoolioToast) window.xtoolioToast(body.text || "Done.", "info", body.undo);
      })
      .catch(doneFailed);
  }
  // THE COUNTDOWN: a message you've liked AND answered has nothing left to do, so it marks itself done, gracefully: its
  // Mark done reads "✓ Done" while a green fill sweeps across it for a second (app.css .counting-down, its duration set
  // here, the one number), then presses itself (doneMsg: the confetti, the fold, the toast's Undo). It holds while that
  // message's composer is open (you're still writing to them); an unlike stops it (owe → countdown(msg, false));
  // pressing the button does it at once. Nothing starts while a Done is already on its way (the button is disabled
  // then). It stays "✓ Done", the fill full, until the burst. `keep`: stop the clock but leave that look (doneMsg,
  // pressed by the countdown). It used to count "Done in 3, 2, 1" (too long: a second is
  // enough); the toast's Undo is the grace.
  var COUNTDOWN_MS = 1000;
  var clocks = new WeakMap();
  function countdown(msg, on, keep) {
    var btn = msg && msg.querySelector(".msg-done-btn");
    if (!btn) return;
    var label = btn.getAttribute("data-label") || btn.textContent;
    clearTimeout(clocks.get(btn));
    clocks.delete(btn);
    if (keep) return;
    btn.classList.remove("counting-down");
    btn.textContent = label;
    if (!on || btn.disabled) return;
    // Off the Inbox nothing counts down: it's marked done at once, quietly (doneQuietly), once you've stopped writing.
    if (!inInbox()) {
      var whenQuiet = function () {
        if (msg.classList.contains("replying") || msg.hasAttribute("data-pending") || msg.hasAttribute("data-reply-pending")) return clocks.set(btn, setTimeout(whenQuiet, 250));
        clocks.delete(btn);
        if (btn.isConnected && btn.form) doneQuietly(btn.form, false);
      };
      return whenQuiet();
    }
    btn.setAttribute("data-label", label);
    btn.textContent = "✓ Done";
    btn.style.setProperty("animation-duration", COUNTDOWN_MS + "ms");
    void btn.offsetWidth; // restart the sweep
    btn.classList.add("counting-down");
    var tick = function () {
      // Writing to them, or a like or a reply X hasn't confirmed yet (data-pending, markLiked; data-reply-pending,
      // reply): wait.
      if (msg.classList.contains("replying") || msg.hasAttribute("data-pending") || msg.hasAttribute("data-reply-pending")) return clocks.set(btn, setTimeout(tick, 250));
      clocks.delete(btn);
      if (btn.isConnected && btn.form) doneMsg(btn.form, true);
    };
    clocks.set(btn, setTimeout(tick, COUNTDOWN_MS));
  }
  // THE THREAD LINE after messages fold away in place (people.runsOf joinsNext): a message stays joined only while the
  // next message still shown answers it, so no line points at nothing.
  function relink(card) {
    card.querySelectorAll(".chat .msg.joins-next").forEach(function (m) {
      var next = m.nextElementSibling;
      while (next && !(next.matches(".msg") && next.offsetParent)) next = next.nextElementSibling;
      if (!next || next.getAttribute("data-reply-of") !== m.id.slice(1)) m.classList.remove("joins-next", "join-when-open", "join-when-shut");
    });
  }
  // ── "+ Save" on someone else's photo or GIF (partials/media.hbs → POST /media/saved) ──
  // Flips at once ("✓ Saved", or back to "+ Save" when pressed again to remove it), on every copy of that picture on the
  // page, and back if the server says no. Repeat-safe (on=1|0), so it retries like the ♥.
  function showSaved(key, saved) {
    document.querySelectorAll("form[data-media-save]").forEach(function (f) {
      if (f.elements.key.value !== key) return;
      f.elements.on.value = saved ? "0" : "1";
      var b = f.querySelector("button");
      b.classList.toggle("on", saved);
      b.setAttribute("aria-pressed", saved ? "true" : "false");
      b.textContent = saved ? "✓ Saved" : "+ Save";
    });
  }
  function saveMedia(form) {
    var key = form.elements.key.value;
    toggle(form, {
      key: "media:" + key,
      show: function (on) { showSaved(key, on); },
      truth: function (body) { return body.saved === true; },
      done: function (body, sent) { if (sent && window.xtoolioToast) window.xtoolioToast(body.text || "Saved to Media.", "info"); },
    });
  }

  // ── ✕ on a Media page tile (views/media.hbs data-media-remove): a saved one unsaved (POST /media/saved on=0), one
  // of yours removed from your media for good (POST /media/hidden on=1; the post stays on X) ──
  // The tile goes at once, the tabs' counts move (data-count="media-<tab>"), and the toast's Undo puts it back where
  // it was (sent once the removal has answered, so the two can't cross). Its pin went with it (the server drops it), so
  // it comes back unpinned. Refused or unreachable: back as it was, with the toast.
  function removeMedia(form) {
    var tile = form.closest("[data-media-key]");
    if (!tile || !tile.parentNode) return;
    var parent = tile.parentNode;
    var next = tile.nextSibling;
    var pinned = tile.classList.contains("pinned");
    var tabs = ["all", tile.getAttribute("data-media-type")].concat(tile.hasAttribute("data-media-saved") ? ["saved"] : []);
    var removing = form.elements.on.value; // "1" (yours, hidden) or "0" (saved, unsaved)
    var sent = post(form, { retry: true });
    tabs.concat(pinned ? ["pinned"] : []).forEach(function (t) { bump("media-" + t, -1); });
    tile.remove();
    var undone = false;
    function putBack() {
      if (tile.parentNode) return;
      parent.insertBefore(tile, next && next.parentNode === parent ? next : null);
      tabs.forEach(function (t) { bump("media-" + t, 1); });
      if (pinned) {
        tile.classList.remove("pinned");
        var pin = tile.querySelector("[data-media-pin]");
        if (pin) {
          pin.textContent = "☆";
          pin.setAttribute("aria-pressed", "false");
          if (pin.form && pin.form.elements.on) pin.form.elements.on.value = "1";
        }
      }
    }
    if (window.xtoolioToast) {
      window.xtoolioToast("Removed from Media.", "info", function () {
        undone = true;
        putBack();
        sent
          .catch(function () {})
          .then(function () { return post(form, { retry: true, set: { on: removing === "1" ? "0" : "1" } }); })
          .then(function (body) { if (!body.ok) refused(body); })
          .catch(function () { unreachable(NO_ANSWER); });
      });
    }
    sent
      .then(function (body) {
        if (body.ok) return;
        if (!undone) putBack();
        refused(body);
      })
      .catch(function () { unreachable(NO_ANSWER, function () { if (!undone) putBack(); }); });
  }

  // A card's fold ("Show 4 earlier replies", partials/thread.hbs) after a folded message left it: the number follows,
  // and an emptied fold's label goes (its row's "Only this post" stays).
  function foldCount(card) {
    var label = card.querySelector(".fold-label");
    if (!label) return;
    var n = card.querySelectorAll(".chat > .msg.folded").length;
    if (!n) {
      var row = label.parentElement;
      label.remove();
      if (!row.children.length) row.remove(); // its line too; a row keeping "Only this post" stays
      return;
    }
    label.querySelector("[data-fold-n]").textContent = String(n);
    label.querySelector("[data-fold-word]").textContent = n === 1 ? "reply" : "replies";
  }
  // ── the rail (views/inbox.hbs): what each person still has coming from you ──
  // Each of their messages in a card says what it owes (data-owed-by, data-owe-like, data-owe-reply, as
  // services/inbox.js drew them). A like, an unlike, a reply or a card leaving the tab moves that person's number and
  // Everyone's by exactly that; someone at 0 hides (unless they're the one picked) and comes back if it rises again.
  // The rail lists people or posts (by=posts: each card by what it's about), each row with a column per kind (`what`:
  // "like" | "reply"), the first row their totals; its rows are keyed (partials/rail-row.hbs data-rail-key): a person's
  // id, "post-<conversation id>". Whichever is drawn moves.
  function countOf(name) {
    var el = document.querySelector('[data-count="' + name + '"]');
    return el ? parseInt(el.textContent.replace(/\D/g, ""), 10) || 0 : 0;
  }
  // One message on the page now owes a like or a reply (true), or not (false): THE OWED TABLE, and every number off it.
  function owe(msg, what, owed) {
    if (!msg || !msg.hasAttribute("data-owed-by") || msg.hasAttribute("data-owe-" + what) === owed) return;
    msg.toggleAttribute("data-owe-" + what, owed);
    modelSet(msg.id.slice(1), what, owed);
    // Liked AND answered: nothing left to do with it (a reload draws it finished, inbox.standingOf), so in place it
    // marks itself done after THE COUNTDOWN. An unlike stops it.
    countdown(msg, !msg.hasAttribute("data-owe-like") && !msg.hasAttribute("data-owe-reply"));
    recount();
  }
  // Messages marked done owe nothing: the whole card's, or just one person's (their view of it). They leave THE OWED
  // TABLE (its messages on the page and any folded or capped away alike), so they stop counting.
  function handledRail(card, person) {
    var conv = card.getAttribute("data-conversation") || (card.closest("[data-conversation]") || card).getAttribute("data-conversation");
    batch(function () {
      // untable stops THE COUNTDOWN on each: this Done already covers it (a card that stays on the page, the All tab,
      // once sent one more /inbox/done per message a second later).
      card.querySelectorAll(person ? '[data-owed-by="' + person + '"]' : "[data-owed-by]").forEach(function (msg) { untable(msg); });
      if (conv) modelDrop(function (e) { return e.c === conv && (!person || e.p === person); });
    });
  }

  // ── BULK LIKE (views/partials/like-all.hbs, a rail row's ♥, a card's ♥ → POST /inbox/like-all) ──
  // THE PRESS IS THE ACTION: THE OWED TABLE says which messages the server will take (the same ones, in its order, at
  // most X's window and the per-press cap), and they're liked on the page at once: every heart of theirs here flips,
  // the rail, the head and every ♥'s N move, THE COUNTDOWN starts on what's now liked and answered (it presses itself
  // only once X confirms: data-pending), and the toast says how many. X takes them one by one behind the page. Its answer
  // says which it took: any it didn't (its limit came sooner, the balance ran out, a post deleted since) flip back, with
  // X's reason in the toast. No answer at all: the page reloads to show what went through. Never retried: a second send
  // likes the NEXT ones. (It used to spin, counting down on the button, and flip everything at the end.)
  function likeAll(form) {
    var scope = { person: form.elements.person.value, post: form.elements.post.value };
    var ids = likeTargetsOf(scope).slice(0, pressN(scope));
    if (!ids.length) return;
    var sent = postStream(form, function () {}); // the stream's lines only keep a long press's connection alive
    batch(function () {
      ids.forEach(function (id) { markLiked(id, true, true); });
      spend(ids.length);
    });
    // lib/notices.js "liked-many", said now.
    if (window.xtoolioToast) window.xtoolioToast("Liked " + ids.length.toLocaleString("en-US") + " " + (ids.length === 1 ? "reply" : "replies") + ".", "info");
    function settleAll() { ids.forEach(settled); }
    sent
      .then(function (body) {
        if (!body.ok) {
          batch(function () {
            ids.forEach(function (id) { markLiked(id, false); });
            spend(-ids.length); // nothing went: X's window is as it was
          });
          settleAll();
          return refused(body);
        }
        var took = {};
        (body.liked || []).forEach(function (id) { took[id] = true; });
        var missed = ids.filter(function (id) { return !took[id]; });
        batch(function () {
          missed.forEach(function (id) { markLiked(id, false); });
          // One the page didn't predict (the Inbox changed under it): liked all the same.
          (body.liked || []).forEach(function (id) { if (ids.indexOf(id) === -1) markLiked(id, true); });
        });
        settleAll();
        (body.liked || []).forEach(function (id) {
          forgetToggle("/posts/" + id + "/like");
          if (document.querySelector('[data-likes-for="' + id + '"]')) redrawLikes(id); // your face joins the others'
        });
        missed.forEach(function (id) { forgetToggle("/posts/" + id + "/like"); });
        allowance(body.likes);
        balance(body);
        // Only when it isn't what the page already said (X stopped early: its words; nothing taken: why).
        if (missed.length && window.xtoolioToast && body.text) window.xtoolioToast(body.text, body.kind || "info");
      })
      .catch(function () {
        settleAll();
        reloadWith("likes-lost");
      });
  }

  // ── LIKE THEIR LATEST POSTS (views/partials/like-latest.hbs → POST /people/:id/like-latest) ──
  // None of the posts it likes are on the page, so there's nothing to flip: the BUTTON says the progress, its heart
  // filled while X takes them (.counting, as a bulk ♥): "Reading their posts…", then "Liking · 12 to go" off the
  // stream's lines, then the toast with how many X took, and the button as X's window now leaves it ("Like latest 2",
  // or a disabled "More at 3:42 PM"). No answer at all: the page reloads to show what went through. Never retried.
  // THE LIKESTORM's page (views/likestorm.hbs, its second step) adds a SLIDER (how many: `n`) whose every move re-prices
  // the button from the server's own estimates (`data-prices`, one per n), and THE CELEBRATION on their card (drawn by
  // the server, the confirmation: `[data-storm-who]`): its status line counts the likes as they land, then it goes
  // green and bursts with confetti when X is done.
  function stormPrices(form) {
    try {
      return JSON.parse(form.getAttribute("data-prices") || "[]");
    } catch (e) {
      return [];
    }
  }
  function stormLabel(form) {
    var range = form.querySelector("[data-storm-range]");
    var label = form.querySelector("[data-like-latest-label]");
    var n = range ? Number(range.value) : null;
    if (!label || !n) return;
    var price = stormPrices(form)[n - 1];
    label.textContent = "Like " + n + (price ? " · ≈ " + price : "");
    var shown = form.querySelector("[data-storm-n]");
    if (shown) shown.textContent = String(n);
  }
  document.addEventListener("input", function (e) {
    if (e.target.matches && e.target.matches("[data-storm-range]")) stormLabel(e.target.form);
  });
  // Spent, the page comes back by itself a moment after X's window reopens (`ends`, ms), drawn fresh with the likes
  // free then; not while you're typing a handle.
  function stormBack(ends) {
    var wait = Number(ends) - Date.now() + 1500;
    if (!isFinite(wait)) return;
    setTimeout(function again() {
      var typing = document.activeElement && document.activeElement.matches("input[name=handle]");
      if (typing) return setTimeout(again, 5000);
      location.reload();
    }, Math.max(1000, wait));
  }
  document.querySelectorAll("form[data-storm-back]").forEach(function (f) { stormBack(f.getAttribute("data-storm-back")); });
  function likeLatest(form) {
    var btn = form.querySelector("button[type=submit], button");
    var label = form.querySelector("[data-like-latest-label]");
    if (!label || btn.disabled) return;
    var was = label.textContent;
    var max = Number(form.getAttribute("data-max")) || 50;
    var card = form.parentNode.querySelector("[data-storm-who]");
    var line = card && card.querySelector("[data-storm-status]");
    var status = function (t) {
      if (!line) return;
      line.textContent = t;
      line.hidden = !t;
    };
    var total = 0;
    btn.disabled = true;
    btn.classList.add("counting");
    label.textContent = "Reading their posts…";
    if (card) card.classList.remove("done");
    status("Reading their latest posts…");
    postStream(form, function (m) {
      if (m.total) {
        total = m.total;
        label.textContent = "Liking · " + m.total + " to go";
        status("Liking 0 of " + total + "…");
      }
      if (m.left) {
        label.textContent = "Liking · " + m.left + " to go";
        status("Liking " + (total - m.left) + " of " + total + "…");
      }
    })
      .then(function (body) {
        btn.classList.remove("counting");
        if (!body.ok) {
          btn.disabled = false;
          label.textContent = was;
          status("");
          return refused(body);
        }
        if (window.xtoolioToast) window.xtoolioToast(body.text, body.kind || "info");
        balance(body);
        var got = (body.liked || []).length;
        status(got ? "♥ Liked " + got + " of their latest posts" : body.text);
        if (card && got) {
          card.classList.add("done");
          burst(card, true); // THE CELEBRATION
        }
        // What a storm may take now (the answer's `room`: every like X's window has left, at most LIKE_ALL_MAX,
        // routes/pages.js stormRoom), with X's reset for when it's none.
        var l = { left: body.room || 0, at: (body.likes || {}).at, ends: (body.likes || {}).ends };
        var range = form.querySelector("[data-storm-range]");
        var cap = form.querySelector("[data-storm-cap]");
        btn.disabled = !l.left;
        // The Likestorm page offers only what X has free NOW: the slider shrinks to it, and once it's spent the slider
        // and the button go and the page says when likes are back (its own words: data-left-text / data-spent-text).
        if (range) {
          var slider = range.closest(".storm-slider");
          if (!l.left) {
            if (slider) slider.hidden = true;
            btn.hidden = true;
            if (cap) cap.textContent = (form.getAttribute("data-spent-text") || "").replace("{at}", l.at || "later");
            if (l.ends) stormBack(l.ends);
          } else {
            range.max = String(Math.min(Number(range.max), l.left, max));
            range.value = String(Math.min(Number(range.value), Number(range.max)));
            if (slider) slider.hidden = Number(range.max) < 2;
            if (cap) cap.textContent = (form.getAttribute("data-left-text") || "").replace("{left}", String(Math.min(l.left, max)));
            stormLabel(form);
          }
        } else if (!l.left) label.textContent = "More " + (l.at || "later");
        else label.textContent = "Like latest " + Math.min(l.left, max);
      })
      .catch(function () { reloadWith("likes-lost"); });
  }

  // ── MARK ALL DONE, IN PLACE (the toolbar's "Mark N done", a rail row's ✓ → POST /inbox/done-all) ──
  // The page moves at once, as a card's Done does: a person's (their replies on the page fold away, and any card left
  // with nothing goes), a post's (that card goes), everyone's (every card on the page goes) out of THE OWED TABLE, the
  // confetti from the button. The save goes behind it; its answer brings the toast's Undo, and where the press empties
  // more than the page holds (everyone's, or the view it was pressed in is gone), the page the server says to be on.
  // A save that fails reloads the page from the server (DONE IS OPTIMISTIC). Not retried (its Undo snapshots the marks).
  function viewKey(href) {
    var u = new URL(href, location.href);
    ["n", "u", "page"].forEach(function (k) { u.searchParams.delete(k); });
    u.searchParams.sort();
    return u.pathname + "?" + u.searchParams.toString();
  }
  function doneAll(form) {
    if (form.hasAttribute("data-sending")) return;
    form.setAttribute("data-sending", "");
    var btn = form.querySelector("button[type=submit]");
    var scope = { person: form.elements.person.value, post: form.elements.post.value };
    var everything = !scope.person && !scope.post;
    var sent = post(form); // built before anything moves
    saving(sent);
    if (btn) burst(btn);
    if (everything) {
      // Everyone's: every card on the page leaves Waiting (the server marks every page's; the next page says so).
      var matched = countOf("list-matched");
      bump("tab-waiting", -matched);
      bump("tab-done", matched);
      document.querySelectorAll("[data-inbox-show] .thread").forEach(function (card) {
        handledRail(card, null);
        if (leaves(card, true, null)) fold(card, function () {});
        else cardDoneInPlace(card);
      });
    } else if (!scope.person) {
      // One post's: its card, as its own Done.
      var card = document.querySelector('.thread[data-conversation="' + scope.post + '"]');
      if (card) {
        handledRail(card, null);
        if (cardTabs(card, true, null)) fold(card);
        else cardDoneInPlace(card);
      }
    } else {
      // One person's: their replies, each as its own Done (one recount for them all).
      batch(function () {
        document.querySelectorAll('.thread .msg[data-owed-by="' + scope.person + '"]').forEach(function (msg) {
          if (!scope.post || msg.closest(".thread").getAttribute("data-conversation") === scope.post) retireMsg(msg);
        });
      });
    }
    modelDrop(function (e) { return (e.f & IN_VIEW) && inScope(e, scope); });
    recount();
    sent
      .then(function (body) {
        if (!body.ok) return doneFailed();
        form.removeAttribute("data-sending");
        if (window.xtoolioToast) window.xtoolioToast(body.text || "Marked done.", "info", body.undo);
        // The view the server says to be on, in place (VIEWS IN PLACE): everyone's empties more than this page held,
        // and a view pressed away (a person's own, emptied) is Everyone now. `partial`: the server left alone something
        // newer than the page that the page had folded, so it's drawn again even when the view is the same.
        if (everything || body.partial || viewKey(body.href) !== viewKey(location.href)) {
          navigating = true; // leftList's own view change stands aside
          whenSaved(function () { showView(body.href, { replace: true }); });
        }
      })
      .catch(doneFailed);
  }
  // THE bulk ♥'s click-again: only a press over the WHOLE view (`whole`: the rail's Everyone / Every post, the
  // toolbar's with nobody and no post picked), and only for two or more; a person's, a post's or a card's is one click,
  // like the ♥ under a post. The partials draw it by the same rule.
  function likeConfirm(btn, n, whole) {
    if (whole && n > 1) btn.setAttribute("data-confirm", "Click again to like " + n);
    else btn.removeAttribute("data-confirm");
  }
  // What ONE press of a ♥ likes: its confirm, and a card's label ("Like 50", [data-like-n]: the cap, not what's owed).
  function pressLikes(btn, n, whole) {
    likeConfirm(btn, n, whole);
    var label = btn.querySelector("[data-like-n]");
    if (label) label.textContent = n.toLocaleString("en-US");
  }
  // A card (or one message, doneMsg) leaves the page; then `after` (default: the Inbox's list bookkeeping, leftList).
  // Everything folding in the same moment folds together, on the next frame: every height read first, then every
  // change written (one press folding a dozen replies read each height between the others' changes, a fresh layout
  // each time: seconds on a phone).
  var folding = [];
  function fold(card, after) {
    var gone = function () { card.remove(); (after || leftList)(); };
    if (reduced) return gone();
    folding.push({ card: card, gone: gone });
    if (folding.length === 1) requestAnimationFrame(foldAll);
  }
  function foldAll() {
    var batchOf = folding;
    folding = [];
    var heights = batchOf.map(function (f) { return f.card.offsetHeight; }); // from its height, so the fold can animate to nothing
    batchOf.forEach(function (f, i) { f.card.style.height = heights[i] + "px"; });
    void document.body.offsetWidth;
    batchOf.forEach(function (f) {
      f.card.classList.add("folding");
      f.card.style.height = "0px";
    });
    setTimeout(function () { batchOf.forEach(function (f) { f.gone(); }); }, 380);
  }
  // Confetti from the middle of `el`: appended to the body at a fixed point (a card would clip it, and the card is about
  // to fold); each piece flies to its own --dx/--dy (CSSOM, which the CSP allows; a style="" attribute it wouldn't).
  // The grammar: 💥 is for deleting, confetti for finishing, and only in THE INBOX, the workspace (inInbox), and a
  // finished LIKESTORM (`big`: more of it, further: the celebration). Nothing under reduced motion.
  function burst(el, big) {
    if (reduced || (!big && !inInbox())) return;
    var r = el.getBoundingClientRect();
    var host = document.createElement("div");
    host.className = "burst";
    host.style.setProperty("left", r.left + r.width / 2 + "px");
    host.style.setProperty("top", r.top + r.height / 2 + "px");
    for (var i = 0; i < (big ? 60 : 18); i++) {
      var p = document.createElement("i");
      var ang = Math.random() * Math.PI * 2, dist = big ? 80 + Math.random() * 200 : 40 + Math.random() * 60;
      p.style.setProperty("--dx", (Math.cos(ang) * dist).toFixed(1) + "px");
      p.style.setProperty("--dy", (Math.sin(ang) * dist - 18).toFixed(1) + "px"); // a little upward: a pop, not a drop
      p.style.setProperty("--r", Math.round(Math.random() * 540 - 270) + "deg");
      p.style.setProperty("animation-delay", Math.floor(Math.random() * 80) + "ms");
      host.appendChild(p);
    }
    document.body.appendChild(host);
    setTimeout(function () { host.remove(); }, 900);
  }

  // ── ON X (`data-on-x`): a post's On X (partials/post-foot.hbs), the ↻ menu's Quote (X's API quotes are Enterprise
  // only: repost-button.hbs), and Reply or a draft's line without Replying. On a computer they open as a small window
  // beside the page, as X's own share buttons do; on a phone the link opens as it is (the X app, usually). X sends what
  // you did back (the like line redraws itself, a reply arrives), so the page catches up by itself. ──
  document.addEventListener("click", function (e) {
    var link = e.target.closest && e.target.closest("a[data-on-x]");
    if (!link || PHONE.matches || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault(); // (a Reply with `data-on-x` has no composer: the Reply handler below leaves the click alone)
    var w = 600, h = 700;
    var left = Math.max(0, (window.screenX || 0) + (window.outerWidth - w) / 2);
    var top = Math.max(0, (window.screenY || 0) + (window.outerHeight - h) / 2);
    window.open(link.href, "on-x", "popup=yes,noopener,width=" + w + ",height=" + h + ",left=" + Math.round(left) + ",top=" + Math.round(top));
  });

  // ── ↩ Reply under a message: opens (or closes) its own composer, a <dialog> (partials/bubble.hbs). Only when the
  // message has one (Replying on); otherwise the link goes to X's reply window, as it does without script.
  // A wide screen: in place, right below the message. A PHONE: X's reply screen (the inline composer was cramped
  // on a phone and zoomed in; a screen of its own, Reply at the top right): the same dialog shown modal and full screen (`.sheet`), the message you're answering
  // above the box, your face beside it. Modal puts it in the top layer, so the page's containers (.shell-main is a
  // CSS container, which pins anything fixed inside it) can't hold it, and the form never moves, so everything that
  // finds the message from the form (closest(".msg")) still does. ──
  var PHONE = window.matchMedia ? window.matchMedia("(max-width: 720px)") : { matches: false };
  function node(tag, cls) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  }
  // The message being answered, as X's reply screen shows it: its author's face, name, @handle and when, its words
  // (and pictures), then "Replying to @a @b and N others": a copy of the box's own line (partials/reply-box.hbs,
  // people.replyingView: whom X tags), hidden in its usual place while the sheet is open. Copied from the page's own
  // markup (the server's escaped partials), inert: it's to read, not to press.
  function sheetContext(form, msg) {
    var head = msg; // a post in the box (.seed-post) is its own head; a chat message's is its run's first
    while (head && !head.matches(".seed-post") && !(head.matches(".msg") && head.classList.contains("run-start"))) head = head.previousElementSibling;
    var ctx = node("div", "reply-ctx");
    ctx.setAttribute("data-sheet-only", ""); // removed when the sheet closes
    ctx.inert = true;
    var av = node("span", "reply-ctx-av");
    var face = head && head.querySelector(".msg-av .avatar, :scope > .who-av .avatar");
    if (face) av.appendChild(face.cloneNode(true));
    var col = node("div", "reply-ctx-col");
    var who = node("p", "reply-ctx-who");
    var nameEl = head && head.querySelector(".post-name, .msg-name"); // .msg-name: "You", a post of yours in the chat
    var name = document.createElement("b");
    name.textContent = nameEl ? nameEl.textContent : form.getAttribute("data-reply-name");
    who.appendChild(name);
    var copy = head && head.querySelector("[data-copy]");
    var handle = copy ? copy.getAttribute("data-copy") : "";
    var time = head === msg && head.querySelector(".post-time");
    var rest = [handle, time ? time.textContent : ""].filter(Boolean).join(" · ");
    if (rest) who.appendChild(document.createTextNode(" " + rest));
    col.appendChild(who);
    var bubble = msg.querySelector(".bubble, .seed-body");
    Array.prototype.forEach.call(bubble ? bubble.querySelectorAll(":scope > .text, :scope > .post-media") : [], function (part) {
      var c = part.cloneNode(true);
      c.classList.remove("folded");
      col.appendChild(c);
    });
    var line = form.querySelector("[data-reply-to-line]");
    if (line) col.appendChild(line.cloneNode(true));
    ctx.appendChild(av);
    ctx.appendChild(col);
    return ctx;
  }
  function openReply(link, here) {
    var msg = link.closest(".msg, .seed-post"); // a chat message, or a post in the box (topic-post.hbs)
    var form = here.querySelector("form");
    link.classList.add("on");
    if (PHONE.matches) {
      var text = form.elements.text.closest(".compose"); // the box and its @handle layer, one child of the form
      form.insertBefore(sheetContext(form, msg), text);
      var me = node("span", "reply-me");
      me.setAttribute("data-sheet-only", "");
      var mine = document.querySelector(".top-me .avatar");
      if (mine) me.appendChild(mine.cloneNode(true));
      form.insertBefore(me, text);
      here.classList.add("sheet");
      document.documentElement.classList.add("sheet-open"); // the page behind doesn't scroll
      here.showModal();
      fitSheet();
    } else {
      here.show();
      // The message widens to the card while its composer is open (.msg.replying: a class, not :has(), which iOS
      // Safari doesn't re-check when something inside changes).
      msg.classList.add("replying");
    }
    form.elements.text.focus();
    meta(form);
  }
  // The sheet fills what you can SEE (app.css `.reply-here.sheet`): iOS keeps the page full height under the keyboard
  // and pans it to show the caret, so a sheet sized to the page went up with the pan, its Cancel and Reply off the top.
  // Sized and placed by the visual viewport on every change (the keyboard opening, the pan, a rotation), the box always
  // ends at the keyboard and the bar stays at the top; the sheet scrolls inside itself.
  var VV = window.visualViewport;
  function fitSheet() {
    var here = document.querySelector(".reply-here.sheet[open]");
    if (!here || !VV) return;
    here.style.setProperty("--sheet-top", VV.offsetTop + "px");
    here.style.setProperty("--sheet-h", VV.height + "px");
  }
  if (VV) {
    VV.addEventListener("resize", function () {
      fitSheet();
      // The keyboard opening shrinks the sheet: what you're typing comes back above it.
      var form = document.querySelector(".reply-here.sheet[open] form");
      if (form) keepInView(form);
    });
    VV.addEventListener("scroll", fitSheet);
  }
  document.addEventListener("click", function (e) {
    var cancel = e.target.closest && e.target.closest("[data-reply-cancel]");
    if (cancel) return cancel.closest("dialog").close();
    var link = e.target.closest && e.target.closest("[data-reply-to]");
    if (!link) return;
    var col = link.closest(".msg-col, .seed-body"); // its composer is in the same column
    var here = col && col.querySelector(".reply-here");
    if (!here || !here.showModal) return;
    e.preventDefault();
    if (here.open) here.close();
    else openReply(link, here);
  });
  // However it closes (sent, Cancel, ↩ Reply again, Esc): back as it was. "close" doesn't bubble, so it's caught on the
  // way down. What you typed stays in the box for next time.
  document.addEventListener("close", function (e) {
    var here = e.target;
    if (!here.classList || !here.classList.contains("reply-here")) return;
    var msg = here.closest(".msg, .seed-post");
    // Its Reply, or its draft's line (either opens it).
    Array.prototype.forEach.call(msg ? msg.querySelectorAll("[data-reply-to].on") : [], function (link) { link.classList.remove("on"); });
    if (msg) msg.classList.remove("replying");
    if (!here.classList.contains("sheet")) return;
    here.classList.remove("sheet");
    here.style.removeProperty("--sheet-top");
    here.style.removeProperty("--sheet-h");
    Array.prototype.forEach.call(here.querySelectorAll("[data-sheet-only]"), function (n) { n.remove(); });
    document.documentElement.classList.remove("sheet-open");
  }, true);
  // A press anywhere else closes an EMPTY composer, as a modal would; one with words or pictures in it stays until it's
  // sent or cancelled. Only the box shown in place (the phone's sheet is the whole screen). pointerdown, not click: a
  // press inside it can redraw what was pressed (a picture's ✕, the 📎 panel's tiles) before the click lands, and a
  // node already gone would read as outside. A Reply link is left to its own click (it toggles its box, and opening
  // another message's closes this one here first).
  function composerEmpty(form) {
    var A = window.xtoolioAttach;
    return !form.elements.text.value.trim() && !(A && (A.files(form).length || A.picked(form).length));
  }
  document.addEventListener("pointerdown", function (e) {
    var t = e.target;
    if (t.closest && t.closest("dialog.modal")) return; // a modal over it (the 📎's media picker, the viewer) isn't "elsewhere"
    Array.prototype.forEach.call(document.querySelectorAll(".reply-here[open]:not(.sheet)"), function (here) {
      if (here.contains(t)) return;
      var msg = here.closest(".msg, .seed-post");
      var link = t.closest && t.closest("[data-reply-to]");
      if (link && msg && msg.contains(link)) return; // its own Reply (or draft line): the click toggles it
      var form = here.querySelector("form");
      if (form && composerEmpty(form)) here.close();
    });
  });

  // ── VIEWS IN PLACE ──
  // The Inbox's views (a person or post picked on the rail, the tabs, People | Posts, the pager, "← Inbox", the next
  // page's cards when one empties, Everyone after a view empties, Mark all done's view, the "N new · Show" pill, a
  // Done's Undo) and a conversation's page's (a person picked on its rail) come IN PLACE: the server draws the view (the
  // same GET a link makes) and its <main> replaces this one; the header, the sidebar, the live stream and every script
  // stay. They used to be whole page loads: the stall after a press. The click acts at once (the pressed rail row or tab
  // is selected, the old view steps back, main.view-going in app.css, the header's loading bar runs), and the view is
  // fetched as the pointer goes down, or rests on the link with a mouse, so most clicks arrive already fetched. A view
  // fetched before a press (`pressed`) is never used, and none is fetched until every Done is saved (whenSaved), so
  // it's drawn with them; likes X hasn't confirmed yet are put back on it (pendingLikes). Back and Forward walk the
  // views. Any failure: a plain load of that address. Only on pages carrying THE OWED TABLE, whose scripts all set up
  // again on "app:swapped" (as for the search's own swap, search.js).
  function viewsHere() { return !!document.querySelector("main [data-owed-model]"); }
  var viewSeq = 0;
  var early = null; // a view fetched ahead: { href, pressed, at, html }
  var EARLY_MS = 15000;
  function pathOf(href) { var u = new URL(href, location.href); return u.pathname + u.search; }
  function fetchView(href) {
    return fetch(href, { credentials: "same-origin", headers: { Accept: "text/html" } }).then(function (res) {
      if (!res.ok) throw new Error(String(res.status));
      return res.text();
    });
  }
  function fresh(e, href) { return e && e.href === href && e.pressed === pressed && Date.now() - e.at < EARLY_MS; }
  function fetchEarly(href) {
    if (fresh(early, href)) return;
    var e = { href: href, pressed: pressed, at: Date.now() };
    e.html = inFlight.then(function () { return fetchView(href); });
    e.html.catch(function () {});
    early = e;
  }
  // `opts`: replace (no new history entry), keepScroll (stay where you are), pop ({ y }: Back / Forward, the address
  // already moved).
  function showView(href, opts) {
    opts = opts || {};
    href = pathOf(href);
    var mine = ++viewSeq;
    var bar = document.querySelector("[data-nav-progress]");
    if (bar) bar.classList.add("on");
    var main = document.querySelector("main");
    if (main) main.classList.add("view-going");
    var got = fresh(early, href) ? early.html : null;
    early = null;
    (got || inFlight.then(function () { return fetchView(href); }))
      .then(function (html) {
        if (mine !== viewSeq) return; // a newer view was asked for
        var doc = new DOMParser().parseFromString(html, "text/html");
        var next = doc.querySelector("main");
        main = document.querySelector("main");
        if (!next || !main || !next.querySelector("[data-owed-model]")) throw new Error("not a view");
        if (!window.xtoolioSameAccount(doc)) throw new Error("another account"); // swap.js: the whole page loads instead
        var y = window.scrollY;
        if (opts.pop) {
          // the address is already the view's
        } else if (opts.replace) {
          history.replaceState({ view: true, y: 0 }, "", href);
        } else {
          history.replaceState({ view: true, y: y }, "", location.pathname + location.search);
          history.pushState({ view: true, y: 0 }, "", href);
          if ("scrollRestoration" in history) history.scrollRestoration = "manual"; // Back puts you back (popstate)
        }
        Array.prototype.forEach.call(next.querySelectorAll("script"), function (s) { s.remove(); }); // set up by "app:swapped"
        Array.prototype.slice.call(main.attributes).forEach(function (a) { main.removeAttribute(a.name); });
        Array.prototype.forEach.call(next.attributes, function (a) { main.setAttribute(a.name, a.value); });
        main.replaceChildren.apply(main, Array.prototype.map.call(next.childNodes, function (c) { return document.importNode(c, true); }));
        window.scrollTo(0, opts.pop ? opts.pop.y || 0 : opts.keepScroll ? y : 0);
        navigating = false;
        document.dispatchEvent(new CustomEvent("app:swapped", { detail: { root: main, view: true } })); // → afresh
      })
      .catch(function () { if (mine === viewSeq) location.assign(href); })
      .then(function () {
        if (mine !== viewSeq) return;
        if (bar) bar.classList.remove("on");
        var m = document.querySelector("main");
        if (m) m.classList.remove("view-going");
      });
  }
  window.xtoolioView = { here: viewsHere, refresh: function () { showView(location.href, { replace: true }); } };
  // Any swap (a view here, or a search's, search.js): the page's own state comes from what's now drawn, THE OWED TABLE
  // and X's window, toggles not in flight; and the likes X hasn't confirmed yet go back on it.
  document.addEventListener("app:swapped", function afresh() {
    Object.keys(toggles).forEach(function (k) { if (!toggles[k].busy) delete toggles[k]; });
    loadModel();
    armWindow();
    batch(function () { Object.keys(pendingLikes).forEach(function (id) { markLiked(id, pendingLikes[id], true); }); });
  });
  // A link to another view of THIS page (the same address, another query): the rail's, the tabs', the pager's, "← Inbox".
  function viewLink(target) {
    var a = target && target.closest && target.closest("main a[href]");
    if (!a || !viewsHere() || a.target || a.hasAttribute("download") || a.hasAttribute("data-on-x")) return null;
    var u = new URL(a.href, location.href);
    if (u.origin !== location.origin || u.pathname !== location.pathname) return null;
    if (u.hash && u.search === location.search) return null; // a jump within the view
    return a;
  }
  // The click is the action: what's picked is selected now, while the view comes.
  function selectNow(a) {
    var row = a.closest(".rail-row");
    var group = row ? a.closest(".rail") : a.closest(".seg-tabs");
    if (!group) return;
    group.querySelectorAll(row ? ".rail-row.on, .rail-row a.on" : "a.on").forEach(function (el) {
      el.classList.remove("on");
      el.removeAttribute("aria-current");
    });
    if (row) row.classList.add("on");
    a.classList.add("on");
    a.setAttribute("aria-current", "page");
  }
  document.addEventListener("click", function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = viewLink(e.target);
    if (!a) return;
    e.preventDefault();
    selectNow(a);
    showView(a.href);
  });
  document.addEventListener("pointerdown", function (e) {
    var a = viewLink(e.target);
    if (a) fetchEarly(pathOf(a.href));
  });
  var restTimer = null;
  document.addEventListener("pointerover", function (e) {
    if (e.pointerType !== "mouse") return;
    clearTimeout(restTimer);
    var a = viewLink(e.target);
    if (a) restTimer = setTimeout(function () { fetchEarly(pathOf(a.href)); }, 120);
  });
  window.addEventListener("popstate", function (e) {
    if (e.state && e.state.view && viewsHere()) showView(location.href, { pop: { y: e.state.y } });
  });
  if (viewsHere() && !(history.state && history.state.view)) history.replaceState({ view: true, y: 0 }, "", location.pathname + location.search + location.hash);
  // A Done's Undo (the toast's, views/partials/toast.hbs → POST /inbox/undo): the marks put back, then the view as the
  // server has it now, in place, where you are.
  function undo(form) {
    var toast = form.closest("[data-toast]");
    var sent = post(form);
    if (toast) toast.remove();
    sent
      .then(function (body) {
        if (window.xtoolioToast && body.text) window.xtoolioToast(body.text, body.kind || "info");
        showView(location.href, { replace: true, keepScroll: true });
      })
      .catch(function () { unreachable(NO_ANSWER); });
  }

  document.addEventListener("submit", function (e) {
    if (e.target.matches && e.target.matches("form[data-toast-undo]")) {
      if (!viewsHere()) return; // elsewhere, the plain form
      e.preventDefault();
      return undo(e.target);
    }
    var form = e.target.closest && e.target.closest("form.like-form, form[data-repost], form[data-reply], form[data-done], form[data-done-msg], form[data-media-save], form[data-follow], form[data-refresh], form[data-unfollow-many], form[data-like-all-form], form[data-done-all], form[data-follow-all], form[data-draft-discard], form[data-media-remove], form[data-like-latest]");
    if (!form) return;
    e.preventDefault();
    if (form.hasAttribute("data-draft-discard")) discardDraft(form);
    else if (form.hasAttribute("data-like-latest")) likeLatest(form);
    else if (form.hasAttribute("data-media-remove")) removeMedia(form);
    else if (form.hasAttribute("data-done-all")) doneAll(form);
    else if (form.hasAttribute("data-unfollow-many")) unfollowMany(form);
    else if (form.hasAttribute("data-like-all-form")) likeAll(form);
    else if (form.hasAttribute("data-follow-all")) followAll(form);
    else if (form.hasAttribute("data-repost")) repost(form);
    else if (form.hasAttribute("data-reply")) reply(form);
    else if (form.hasAttribute("data-done")) done(form);
    else if (form.hasAttribute("data-done-msg")) doneMsg(form);
    else if (form.hasAttribute("data-media-save")) saveMedia(form);
    else if (form.hasAttribute("data-follow")) follow(form);
    else if (form.hasAttribute("data-refresh")) refresh(form);
    else like(form);
  });
  document.addEventListener("input", function (e) {
    var form = e.target.closest && e.target.closest("form[data-reply]");
    if (form) meta(form);
  });
  // X's like window's clock, from the page as drawn.
  armWindow();

  // ⌘/Ctrl + Enter sends.
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
    var form = e.target.closest && e.target.closest("form[data-reply]");
    if (form) { e.preventDefault(); reply(form); }
  });
})();
