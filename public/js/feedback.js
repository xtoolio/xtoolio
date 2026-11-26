// SCREENSHOTS IN FEEDBACK (views/partials/feedback-modal.hbs, routes/feedback.js): up to the form's data-shots `max`
// images, added by the 📎 (a file picker), by pasting one into the box, or by dropping files onto the form. They show
// as THE preview tiles (attach.js's, each with a ✕) above Send. The rules and their words are the server's (data-shots);
// the server checks again regardless.
//
// Sending: with no screenshot the form posts as it always did. With some, it goes as multipart through fetch (the
// CSRF token in x-csrf-token: the server's check runs before it parses a multipart body), and the page moves to where
// the server says, the toast with it. A failure to reach the server says so and keeps what was typed and attached.
"use strict";

(function () {
  var form = document.querySelector("form.feedback-form[data-shots]");
  if (!form || !window.FormData || !window.fetch) return;
  var rules;
  try {
    rules = JSON.parse(form.getAttribute("data-shots"));
  } catch (e) {
    return;
  }
  var input = form.querySelector("[data-shots-input]");
  var strip = form.querySelector("[data-attach-strip]");
  var text = form.elements.text;
  var types = rules.accept.split(",");
  var shots = [];
  input.accept = rules.accept;

  function say(t) {
    if (window.xtoolioToast) window.xtoolioToast(t, "error");
  }
  function draw() {
    strip.textContent = "";
    shots.forEach(function (f, i) { strip.appendChild(window.xtoolioAttach.preview(f, String(i), false)); });
    strip.hidden = !shots.length;
  }
  function add(files) {
    var more = Array.prototype.slice.call(files || []);
    if (!more.length) return;
    if (more.some(function (f) { return types.indexOf(f.type) === -1; })) return say(rules.say["feedback-shot-type"]);
    if (more.some(function (f) { return f.size > rules.bytes; })) return say(rules.say["feedback-shot-big"]);
    if (shots.length + more.length > rules.max) return say(rules.say["feedback-shot-many"]);
    shots = shots.concat(more);
    draw();
  }

  form.querySelector("[data-shots-add]").addEventListener("click", function () { input.click(); });
  input.addEventListener("change", function () {
    add(input.files);
    input.value = ""; // the same file can be picked again after removing it
  });
  text.addEventListener("paste", function (e) {
    var files = e.clipboardData && e.clipboardData.files;
    if (!files || !files.length) return;
    e.preventDefault();
    add(files);
  });
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
    add(e.dataTransfer.files);
  });
  strip.addEventListener("click", function (e) {
    var x = e.target.closest && e.target.closest("[data-attach-remove]");
    if (!x) return;
    shots.splice(Number(x.getAttribute("data-attach-remove")), 1);
    draw();
  });

  // The form's own listener runs before busy.js's (on the document), which skips a submit already prevented: the Send
  // button is set busy here instead.
  form.addEventListener("submit", function (e) {
    if (!shots.length) return; // the plain post
    e.preventDefault();
    var send = form.querySelector("button[type=submit]");
    var idle = function () {
      send.disabled = false;
      send.classList.remove("busy");
    };
    send.disabled = true;
    send.classList.add("busy");
    var body = new FormData();
    body.set("text", text.value);
    body.set("page", form.elements.page.value);
    shots.forEach(function (f) { body.append("shots", f); });
    fetch(form.action, { method: "POST", body: body, credentials: "same-origin", headers: { Accept: "application/json", "x-csrf-token": form.elements._csrf.value } })
      .then(function (res) { return res.ok ? res.json() : Promise.reject(res.status); })
      .then(function (answer) {
        if (answer.ok) location.href = answer.href; // the page again, with the toast
        else {
          idle(); // refused (too many today, a file the server won't take): said here, the words and pictures kept
          say(answer.text);
        }
      })
      .catch(function () {
        idle();
        say(window.xtoolioNoAnswer || "Try again.");
      });
  });
})();
