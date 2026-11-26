// PICTURES IN A REPLY (views/partials/reply-box.hbs with data-pictures: the Pictures add-on). Every composer that may
// carry them gets a 📎 beside the 😊, and takes photos or a GIF four ways:
//   - the 📎 opens THE MEDIA PICKER (a drawer, views/partials/media-picker.hbs, serving whichever composer asked):
//     "From your computer" (a file picker) and YOUR MEDIA, every photo and GIF from your own posts, pins first (GET
//     /media/library, the server's partial views/media-library.hbs, fetched once); a tile adds it, its ☆ pins it
//     (POST /media/pins);
//   - dragging files onto the box; pasting an image.
// They show as small previews above the box's foot, each with a ✕. The box says no at once, in the server's own words
// (data-pictures: lib/media.js's limits and lib/notices.js's messages), and the server checks again regardless.
//
// Each form holds what's attached: form.xtoolioFiles (File objects) and form.xtoolioPicked (your media: { key, type,
// thumb }; the server fetches X's own copy as the reply is sent). post-actions.js sends both (multipart) and clears
// them once it went out (window.xtoolioAttach). File previews are data: URLs (FileReader), your media's are X's own
// thumbnails: the CSP's img-src already allows both. Without this script the box is text only, as before.
"use strict";

(function () {
  var TYPES = { "image/jpeg": "photo", "image/png": "photo", "image/webp": "photo", "image/gif": "gif", "video/mp4": "video" };

  function rulesOf(form) {
    try {
      return JSON.parse(form.getAttribute("data-pictures"));
    } catch (e) {
      return null;
    }
  }
  function say(text) {
    if (window.xtoolioToast) window.xtoolioToast(text, "error");
  }
  // Everything attached to a form, as kinds: [{ kind: "photo" | "gif", size? }].
  function kinds(form) {
    return form.xtoolioFiles.map(function (f) { return { kind: TYPES[f.type], size: f.size }; }).concat(form.xtoolioPicked.map(function (p) { return { kind: p.type }; }));
  }
  // Would attaching `more` (kinds) keep to X's rules? → the message if not.
  function refusal(form, more) {
    var rules = rulesOf(form);
    if (more.some(function (m) { return !m.kind; })) return rules.say["media-type"];
    var all = kinds(form).concat(more);
    // A GIF or a video goes alone (lib/media.js checkAttachments, the same rule).
    var alone = all.filter(function (m) { return m.kind === "gif" || m.kind === "video"; }).length;
    if (alone && all.length > 1) return rules.say["media-mix"];
    if (all.length > rules.photos) return rules.say["media-many"];
    var cap = { photo: rules.photoBytes, gif: rules.gifBytes, video: rules.videoBytes };
    if (more.some(function (m) { return m.size > cap[m.kind]; })) return rules.say["media-big"];
    return null;
  }

  function addFiles(form, files) {
    var picked = Array.prototype.slice.call(files || []);
    if (!picked.length) return;
    var no = refusal(form, picked.map(function (f) { return { kind: TYPES[f.type], size: f.size }; }));
    if (no) return say(no);
    form.xtoolioFiles = form.xtoolioFiles.concat(picked);
    draw(form);
  }
  // → whether it was added.
  function addPicked(form, item) {
    if (form.xtoolioPicked.some(function (p) { return p.key === item.key; })) return false; // already in
    var no = refusal(form, [{ kind: item.type }]);
    if (no) {
      say(no);
      return false;
    }
    form.xtoolioPicked.push(item);
    draw(form);
    return true;
  }

  // The previews (files, then your media), and the text no longer required while there's a picture (X: "text is
  // required unless media is provided"). `kind`: "gif" (or true) badges it GIF; "video" is a plain tile badged ▶ Video
  // (its picture would need a blob: address, which the CSP's media-src doesn't allow; the file goes as it is).
  function preview(src, remove, kind) {
    var item = document.createElement("div");
    item.className = "attach-item" + (kind === "video" ? " attach-video" : "");
    if (kind !== "video") {
      var img = document.createElement("img");
      img.alt = "";
      img.referrerPolicy = "no-referrer";
      if (typeof src === "string") img.src = src;
      else {
        var reader = new FileReader();
        reader.onload = function () { img.src = reader.result; };
        reader.readAsDataURL(src);
      }
      item.appendChild(img);
    }
    if (kind === true || kind === "gif" || kind === "video") {
      var badge = document.createElement("span");
      badge.className = "media-badge";
      badge.textContent = kind === "video" ? "▶ Video" : "GIF";
      item.appendChild(badge);
    }
    var x = document.createElement("button");
    x.type = "button";
    x.className = "attach-remove";
    x.setAttribute("data-attach-remove", remove);
    x.setAttribute("aria-label", "Remove this picture");
    x.textContent = "✕";
    item.appendChild(x);
    return item;
  }
  function draw(form) {
    var strip = form.querySelector("[data-attach-strip]");
    strip.textContent = "";
    form.xtoolioFiles.forEach(function (file, i) { strip.appendChild(preview(file, "f" + i, TYPES[file.type])); });
    form.xtoolioPicked.forEach(function (p, i) { strip.appendChild(preview(p.thumb, "p" + i, p.type === "gif")); });
    var any = form.xtoolioFiles.length + form.xtoolioPicked.length > 0;
    strip.hidden = !any;
    form.elements.text.required = !any;
    form.elements.text.dispatchEvent(new Event("input", { bubbles: true })); // post-actions.js redraws the meta line
    if (panel && panel.form === form) markChosen();
  }

  window.xtoolioAttach = {
    preview: preview, // THE preview tile (the feedback box's screenshots use it too: public/js/feedback.js)
    files: function (form) { return (form && form.xtoolioFiles) || []; },
    picked: function (form) { return ((form && form.xtoolioPicked) || []).map(function (p) { return p.key; }); },
    clear: function (form) {
      if (!form || !form.xtoolioFiles) return;
      form.xtoolioFiles = [];
      form.xtoolioPicked = [];
      draw(form);
      close();
    },
  };

  // ── THE MEDIA PICKER (views/partials/media-picker.hbs: THE modal as a drawer, drawn once by the layout) ──
  // It serves one composer at a time (`panel.form`), and never covers it: a drawer at the window's right on a computer,
  // the whole screen on a phone (it opens over the phone's reply sheet, itself a modal, and closes back to it).
  // (It was a panel moved into the composer's foot, opening above the box and covering what was being written.)
  var panel = document.getElementById("media-picker");
  var library = null; // the grid's HTML, fetched once
  function load() {
    var body = panel.querySelector("[data-media-body]");
    if (library !== null) return;
    library = "";
    fetch("/media/library", { credentials: "same-origin" })
      .then(function (res) { return res.ok ? res.text() : Promise.reject(res.status); })
      .then(function (html) {
        library = html;
        body.innerHTML = html; // the server's own escaped partial
        markChosen();
      })
      .catch(function () {
        library = null; // try again next time
        body.textContent = "Couldn't load your media. Try again in a moment.";
      });
  }
  // Tiles already attached to the composer the picker serves look chosen.
  function markChosen() {
    var keys = panel.form ? panel.form.xtoolioPicked.map(function (p) { return p.key; }) : [];
    Array.prototype.forEach.call(panel.querySelectorAll("[data-media-key]"), function (tile) {
      tile.classList.toggle("chosen", keys.indexOf(tile.getAttribute("data-media-key")) !== -1);
    });
  }
  function openFor(form) {
    if (!panel || !panel.showModal) return form.querySelector("[data-attach-input]").click(); // no picker: the files
    panel.form = form;
    load();
    markChosen();
    if (!panel.open) panel.showModal();
  }
  function close() {
    if (panel && panel.open) panel.close();
  }
  if (panel) panel.addEventListener("close", function () { panel.form = null; });

  // ── each composer: the page's, and the ones a search swaps in ("app:swapped", after emoji.js's 😊: it loads first) ──
  function setUpIn(root) {
    Array.prototype.forEach.call(root.querySelectorAll("form[data-reply][data-pictures]"), setUp);
  }
  setUpIn(document);
  document.addEventListener("app:swapped", function (e) { setUpIn(e.detail.root); });
  function setUp(form) {
    var rules = rulesOf(form);
    if (!rules || form.xtoolioFiles) return;
    form.xtoolioFiles = [];
    form.xtoolioPicked = [];
    var foot = form.querySelector(".reply-foot");
    var input = document.createElement("input");
    input.type = "file";
    input.accept = rules.accept;
    input.multiple = true;
    input.hidden = true;
    input.setAttribute("data-attach-input", "");
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "emoji-btn attach-btn";
    btn.setAttribute("data-attach", "");
    btn.setAttribute("aria-label", "Add photos, a GIF or a video");
    btn.setAttribute("data-tip", "Add media");
    btn.textContent = "📎";
    // Right after the 😊 when it's there (emoji.js runs first: the layout loads it before this file).
    var emoji = foot.querySelector(".emoji-btn");
    foot.insertBefore(btn, emoji ? emoji.nextSibling : foot.firstChild);
    foot.appendChild(input);
    var strip = document.createElement("div");
    strip.className = "attach-strip";
    strip.hidden = true;
    strip.setAttribute("data-attach-strip", "");
    form.insertBefore(strip, foot);

    input.addEventListener("change", function () {
      addFiles(form, input.files);
      input.value = ""; // the same file can be picked again after removing it
    });
    // Drop onto the box: only file drags light it up (text dragged in is the textarea's business).
    var hasFiles = function (e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") !== -1; };
    form.addEventListener("dragover", function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      form.classList.add("dropping");
    });
    form.addEventListener("dragleave", function (e) {
      if (!form.contains(e.relatedTarget)) form.classList.remove("dropping");
    });
    form.addEventListener("drop", function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      form.classList.remove("dropping");
      addFiles(form, e.dataTransfer.files);
    });
    // Paste a copied image straight into the text.
    form.elements.text.addEventListener("paste", function (e) {
      var files = e.clipboardData && e.clipboardData.files;
      if (!files || !files.length) return;
      e.preventDefault();
      addFiles(form, files);
    });
  }

  // ── clicks: the 📎, the panel, the ✕ ──
  // THE token every signed-in page carries (the sidebar's forms).
  function csrf() {
    var input = document.querySelector('input[name="_csrf"]');
    return input ? input.value : "";
  }
  document.addEventListener("click", function (e) {
    var t = e.target;
    if (!t.closest) return;
    // The Media page's ☆ (views/media.hbs: a form each, so it works without script): pinned in place, like the panel's.
    var pagePin = t.closest(".media-wall [data-media-pin]");
    if (pagePin) {
      e.preventDefault();
      var wallTile = pagePin.closest("[data-media-key]");
      return pinTile(wallTile, wallTile.getAttribute("data-media-key"));
    }
    var toggle = t.closest("[data-attach]");
    if (toggle) return openFor(toggle.closest("form[data-reply]"));
    var x = t.closest("[data-attach-remove]");
    if (x) {
      var form = x.closest("form[data-reply]");
      var which = x.getAttribute("data-attach-remove");
      (which[0] === "f" ? form.xtoolioFiles : form.xtoolioPicked).splice(Number(which.slice(1)), 1);
      return draw(form);
    }
    if (panel && panel.form && panel.contains(t)) {
      if (t.closest("[data-media-upload]")) {
        var input = panel.form.querySelector("[data-attach-input]");
        close(); // the files land in the composer, which is where you'll be
        return input.click();
      }
      var tile = t.closest("[data-media-key]");
      if (!tile) return;
      var key = tile.getAttribute("data-media-key");
      if (t.closest("[data-media-pin]")) return pinTile(tile, key);
      if (t.closest("[data-media-pick]")) {
        if (tile.classList.contains("chosen")) {
          panel.form.xtoolioPicked = panel.form.xtoolioPicked.filter(function (p) { return p.key !== key; });
          return draw(panel.form);
        }
        var added = addPicked(panel.form, { key: key, type: tile.getAttribute("data-media-type"), thumb: tile.getAttribute("data-media-thumb") });
        // A GIF goes alone: once one is in, picking is done.
        if (added && tile.getAttribute("data-media-type") === "gif") close();
      }
      return;
    }
  });

  // ☆ / ★: pin to the top of your media, or unpin (the order applies the next time the panel loads). The panel's tiles
  // and the Media page's alike; a page tile's form keeps its `on` in step for a press without script.
  function pinTile(tile, key) {
    var on = !tile.classList.contains("pinned");
    var btn = tile.querySelector("[data-media-pin]");
    var onField = btn.form && btn.form.elements.on;
    if (onField) onField.value = on ? "0" : "1";
    tile.classList.toggle("pinned", on);
    btn.textContent = on ? "★" : "☆";
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.setAttribute("aria-label", on ? "Unpin" : "Pin to the top");
    var body = new URLSearchParams();
    body.set("_csrf", csrf());
    body.set("key", key);
    body.set("on", on ? "1" : "0");
    fetch("/media/pins", { method: "POST", body: body, credentials: "same-origin", headers: { Accept: "application/json" } })
      .then(function (res) { if (!res.ok) throw new Error(res.status); library = null; })
      .catch(function () {
        tile.classList.toggle("pinned", !on);
        btn.textContent = on ? "☆" : "★";
        btn.setAttribute("aria-pressed", on ? "false" : "true");
        if (onField) onField.value = on ? "1" : "0";
        say("Couldn't pin that. Try again.");
      });
  }
})();
