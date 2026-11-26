// lib/assetVersion.js — THE DEPLOY'S ASSET VERSION.
//
// Every /js and /css URL a view emits carries `?v=<this>` (the {{assetV}} helper, lib/hbs.js), and app.js serves a
// VERSIONED request with a year-long immutable cache. Without it, express.static's default (max-age=0) makes the
// browser re-check every file on every page load, and a deploy needs a hard refresh.
//
// The version is the deploy's git commit: a deploy is `git pull` + restart, so the URL changes exactly when the
// files can have. Read ONCE at boot. No git (a tarball deploy) → the boot time, which still changes per restart:
// never a constant, because a constant version under an immutable cache is a file that can never update.
"use strict";

const { execSync } = require("child_process");
const path = require("path");

function compute() {
  try {
    const sha = execSync("git rev-parse --short=10 HEAD", { cwd: path.join(__dirname, ".."), stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    if (/^[0-9a-f]{7,40}$/.test(sha)) return sha;
  } catch (_) {
    /* no git here — fall through */
  }
  return `b${Date.now().toString(36)}`;
}

const ASSET_V = compute();

module.exports = { ASSET_V };
