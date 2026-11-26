// lib/crypto.js — AES-256-GCM for secrets at rest (each account's X tokens), with a versioned-key seam: every sealed
// value records which key version sealed it, so a future rotation adds a key + bumps CURRENT without a migration.
//
// The key is passed in (config.tokenKey), not read here, so verify can test the round trip with a throwaway key.
// Open a token only right before calling X; never log one, never send one to the browser.
"use strict";

const crypto = require("crypto");

const CURRENT = 1;

function createSealer(keyBase64) {
  const key = Buffer.from(String(keyBase64 || ""), "base64");
  if (key.length !== 32) {
    throw new Error(
      'TOKEN_KEY must decode to 32 bytes. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
    );
  }
  const keys = { 1: key };

  // → { v, iv, tag, data }, all base64 except v.
  function seal(plaintext) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", keys[CURRENT], iv);
    const data = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
    return { v: CURRENT, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
  }

  // Throws if the value was tampered with (GCM's auth tag) or sealed under an unknown key version.
  function open(sealed) {
    const k = keys[sealed.v];
    if (!k) throw new Error(`no key for sealed version ${sealed.v}`);
    // authTagLength pins the full 16-byte tag: without it, a shortened tag would be accepted (an easier forgery).
    const decipher = crypto.createDecipheriv("aes-256-gcm", k, Buffer.from(sealed.iv, "base64"), { authTagLength: 16 });
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]).toString("utf8");
  }

  return { seal, open };
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const randomToken = (bytes = 32) => b64url(crypto.randomBytes(bytes));

// Constant-time string compare (OAuth state).
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = { createSealer, randomToken, safeEqual, b64url };
