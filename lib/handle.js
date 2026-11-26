// THE HANDLE as someone types or pastes it: "maya", "@Maya", " @maya ", or a link to their profile on X
// ("https://x.com/maya", "twitter.com/@maya/status/…", with or without https:// or www. / mobile.). One rule for every
// box that takes a handle (the front page's cost estimate, Who they tag, Admin's Invite) and for THE SEARCH, which
// reads a pasted profile link as its handle (services/listing.js searchTerms).
"use strict";

const HANDLE = /^[A-Za-z0-9_]{1,15}$/; // X's handles: letters, digits, underscore, at most 15
const isHandle = (s) => HANDLE.test(String(s)); // exactly a handle, nothing to clean (an address's /@maya). Pure.
const PROFILE_LINK = /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/@?([A-Za-z0-9_]{1,15})(?:[/?#].*)?$/i;

// The handle in a profile link, or null. Pure.
const handleInLink = (raw) => {
  const m = PROFILE_LINK.exec(String(raw || "").trim());
  return m ? m[1] : null;
};

// The handle, cleaned (its case kept), or null when it can't be one on X. Pure.
function handleOf(raw) {
  const s = String(raw || "").trim();
  const h = handleInLink(s) || s.replace(/^@/, "");
  return HANDLE.test(h) ? h : null;
}

module.exports = { handleOf, handleInLink, isHandle };
