// THE characters a person's words never need, and that can make text read differently on screen from what's stored
// (or posted): C0 and C1 control characters, and the bidirectional marks, embeddings, overrides and isolates
// (U+200E/F, U+202A–E, U+2066–9), which can reverse how a line reads. Zero-width joiners stay: emoji sequences need
// them. One rule for every text a stranger or an agent hands the site: feedback (routes/feedback.js), an agent app's
// self-chosen name (services/agentOAuth.js), an agent's draft reply (services/agentTools.js).
"use strict";

const BIDI = "\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069";
const ALL = new RegExp(`[\\u0000-\\u001F\\u007F-\\u009F${BIDI}]`, "g");
// `keepLines`: line breaks and tabs stay (after \r\n and \r become \n): a reply or a note can have paragraphs.
const KEEP_LINES = new RegExp(`[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F${BIDI}]`, "g");

function withoutUnsafe(s, { keepLines = false } = {}) {
  const text = String(s == null ? "" : s);
  return keepLines ? text.replace(/\r\n?/g, "\n").replace(KEEP_LINES, "") : text.replace(ALL, "");
}

module.exports = { withoutUnsafe };
