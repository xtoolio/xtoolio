// THE SECRET CHECK for anything published: scripts/verify-security.js runs it on every tracked file before a commit,
// scripts/release.js on the whole snapshot (package-lock included) before a release leaves the machine.
//
// Two layers, the exact one first:
//   1. EXACT VALUES: every secret-named setting in the operator's own .env (its value, and a database address's password
//      on its own). A file containing one fails, by the setting's NAME (the value is never printed). This is the check
//      that knows: it misses only secrets that aren't in this machine's .env (the server's own, say).
//   2. SHAPES: the formats well-known secrets are issued in (a live Stripe key, a database address with a password in it,
//      this app's own agent tokens, a private key block). A backstop for the server's secrets and anything pasted from
//      elsewhere; it can't know a secret with no recognisable format (an X client secret, a session secret), which is
//      what layer 1 is for. GitHub's secret scanning with push protection on the public repository is the third net.
//
// The patterns are written so this file doesn't match them itself.
"use strict";

const dotenv = require("dotenv");

// A setting whose value is a secret, by its name.
const SECRET_NAME = /SECRET|TOKEN|PASS|_KEY$|_URI$/;
const MIN_LEN = 16; // shorter values ("true", a port) would match ordinary text

// A database address's user:password, and what counts as a placeholder for the password (.env.example's "PASS").
const DB_CREDENTIALS = /mongodb(?:\+srv)?:\/\/([^\s:/@"'`<>]+):([^\s@"'`<>]+)@/g;
const PLACEHOLDER = /^(?:[A-Z_]+|<[^>]*>|\$\{[^}]*\}|\*+)$/;

const SHAPES = [
  ["a Stripe live key", /\b[rs]k_live_[A-Za-z0-9]{16,}/],
  ["a Stripe test key", /\b[rs]k_test_[A-Za-z0-9]{16,}/],
  ["a Stripe webhook secret", /\bwhsec_[A-Za-z0-9]{20,}/],
  ["an agent token", /\bxt[oar]_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/],
  ["an X app Bearer token", /A{20}[A-Za-z0-9%]{20,}/],
  ["a GitHub token", /\b(?:gh[opsur]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/],
  ["an Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["an OpenAI API key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ["an AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["a Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["a private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

// The exact secrets in an .env file's text: [{ name, value }], a database password listed on its own as well.
function envSecrets(envText) {
  const out = [];
  for (const [name, raw] of Object.entries(dotenv.parse(envText || ""))) {
    const value = String(raw).trim();
    if (!SECRET_NAME.test(name) || value.length < MIN_LEN) continue;
    out.push({ name, value });
    for (const m of value.matchAll(DB_CREDENTIALS)) {
      const password = decodeURIComponent(m[2]);
      if (password.length >= 8 && !PLACEHOLDER.test(password)) out.push({ name: `${name}'s password`, value: password });
    }
  }
  return out;
}

// What looks like a secret in one file's text: a list of plain descriptions, never the secret itself.
function secretsIn(text, exact = []) {
  const found = [];
  for (const { name, value } of exact) if (text.includes(value)) found.push(`the value of ${name} from .env`);
  for (const [what, re] of SHAPES) if (re.test(text)) found.push(what);
  for (const m of text.matchAll(DB_CREDENTIALS)) {
    if (!PLACEHOLDER.test(m[2])) {
      found.push("a database address with a password in it");
      break;
    }
  }
  return found;
}

// Published files the PRIVATE_WORDS check skips (verify-security and the release alike): generated wholly from a public
// third-party dataset, with no words of ours in them, whose ordinary vocabulary can hold a word on that list (Unicode's
// emoji keywords name places, faiths and given names, e.g. ✡️ "star of …"). The secret scan still reads them.
const NOT_OURS = new Set(["public/emoji.json"]);
function notOurs(rel) {
  return NOT_OURS.has(String(rel).split(/[\\/]/).join("/"));
}

module.exports = { envSecrets, secretsIn, notOurs };
