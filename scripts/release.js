// RELEASE: publish a snapshot of this repo's committed code to the public repository. The private repo is the
// workshop (every commit, every message); the public one gets a release when the operator chooses: ONE commit per
// release ("Release v0.2.0"), tagged, on top of the previous releases. Stopping is just not running this again.
//
//   npm run release -- 0.2.0           build the release in RELEASE_DIR and stop there (look at it before pushing)
//   npm run release -- 0.2.0 --push    the same, then push the commit and its tag to the public repository
//
// Settings, in .env (never committed):
//   RELEASE_AUTHOR  "Name <email>": the public commits' author and committer, so the operator's own git identity never
//                   reaches the public repo. Required.
//   RELEASE_DIR     where the public repo's checkout lives (default: a sibling folder, ../xtoolio-public).
//   PUBLIC_REPO     the public repository's git URL (needed to push; cloned from when RELEASE_DIR doesn't exist yet).
//
// What's published is HEAD's tracked files, except that release/<path> REPLACES <path>: CLAUDE.md here is the long
// private notebook, and the public copy gets release/CLAUDE.md, the short guide.
//
// It refuses (and changes nothing public) on: uncommitted changes here, a failing verify (people, security, billing:
// the security suite includes the PRIVATE_WORDS check), a version already released, nothing changed since the last
// release, or a PRIVATE_WORDS hit or a secret (lib/secretScan.js) anywhere in the snapshot (package-lock and every
// other file included).
"use strict";

require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const args = process.argv.slice(2);
const version = args.find((a) => !a.startsWith("--"));
const push = args.includes("--push");

const fail = (msg) => {
  console.error(`release: ${msg}`);
  process.exit(1);
};
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

if (!/^\d+\.\d+\.\d+$/.test(version || "")) fail("give a version: npm run release -- 0.2.0 [--push]");
const tag = `v${version}`;
const author = (process.env.RELEASE_AUTHOR || "").match(/^\s*([^<]+?)\s*<([^>]+)>\s*$/);
if (!author) fail('set RELEASE_AUTHOR="Name <email>" in .env (the public commits\' author)');
const dir = path.resolve(root, process.env.RELEASE_DIR || "../xtoolio-public");
const remote = process.env.PUBLIC_REPO || "";
if (push && !remote) fail("set PUBLIC_REPO in .env to push");

// 1. This repo: everything committed, and the suites pass.
if (git(root, "status", "--porcelain")) fail("uncommitted changes here: commit first (a release is of HEAD)");
for (const suite of ["verify-people.js", "verify-security.js", "verify-billing.js"]) {
  const r = spawnSync(process.execPath, [path.join(root, "scripts", suite)], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) fail(`${suite} failed`);
}
const head = git(root, "rev-parse", "--short", "HEAD");

// 2. The public checkout: cloned or started the first time, clean and up to date after that.
if (!fs.existsSync(dir)) {
  if (remote) execFileSync("git", ["clone", remote, dir], { stdio: "inherit" });
  else {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, "init", "-b", "main");
  }
}
if (!fs.existsSync(path.join(dir, ".git"))) fail(`${dir} isn't a git checkout`);
if (git(dir, "status", "--porcelain")) fail(`${dir} has uncommitted changes`);
if (remote && !git(dir, "remote")) git(dir, "remote", "add", "origin", remote);
if (git(dir, "remote") && git(dir, "ls-remote", "--heads", "origin", "main")) git(dir, "pull", "--ff-only", "origin", "main");
// Built before (a run without --push) but not published: --push publishes that build as it is.
const builtHere = !!git(dir, "tag", "--list", tag);
const published = builtHere && remote && !!git(dir, "ls-remote", "--tags", "origin", `refs/tags/${tag}`);
if (published) fail(`${tag} is already released`);
if (builtHere && !push) fail(`${tag} is already built in ${dir}: look it over, then run with --push to publish it`);
if (builtHere && push) {
  publish();
  process.exit(0);
}

// 3. The snapshot: exactly HEAD's tracked files (git archive), replacing everything but .git.
for (const e of fs.readdirSync(dir)) if (e !== ".git") fs.rmSync(path.join(dir, e), { recursive: true, force: true });
const tarball = execFileSync("git", ["archive", "--format=tar", "HEAD"], { cwd: root, maxBuffer: 512 * 1024 * 1024 });
const untar = spawnSync("tar", ["-x", "-f", "-", "-C", dir], { input: tarball });
if (untar.status !== 0) fail(`extracting the snapshot failed: ${String(untar.stderr || "")}`);
// The PUBLIC versions of files that stay private here: release/<path> replaces <path> in the snapshot (CLAUDE.md: the
// workshop's long notebook stays in this repo; the public one is the short guide in release/CLAUDE.md). The release/
// folder itself isn't published.
const publicDir = path.join(dir, "release");
if (!fs.existsSync(path.join(publicDir, "CLAUDE.md"))) fail("release/CLAUDE.md isn't in HEAD: the private notebook would be published");
for (const f of walkFiles(publicDir)) fs.copyFileSync(f, path.join(dir, path.relative(publicDir, f)));
fs.rmSync(publicDir, { recursive: true, force: true });

// 4. Nothing private in it, every file read (the security suite skips package-lock and binaries; this doesn't skip text).
const words = (process.env.PRIVATE_WORDS || "").split(",").map((w) => w.trim().toLowerCase()).filter(Boolean); // .env, via dotenv
if (!words.length) fail("PRIVATE_WORDS isn't set in .env: refusing to publish without the check");
const leaks = [];
const { notOurs } = require("../lib/secretScan");
for (const f of walkFiles(dir)) {
  if (/\.(woff2?|png|jpe?g|gif|ico)$/i.test(f)) continue;
  if (notOurs(path.relative(dir, f))) continue; // a public dataset's own words (lib/secretScan.js NOT_OURS)
  const text = fs.readFileSync(f, "utf8").toLowerCase();
  for (const w of words) if (text.includes(w)) leaks.push(`${path.relative(dir, f)}: "${w}"`);
}
if (leaks.length) fail(`private words in the snapshot, nothing committed:\n  ${leaks.join("\n  ")}`);
// And no secret (lib/secretScan.js: this .env's own secret values exactly, then known secret formats), every text file.
const { envSecrets, secretsIn } = require("../lib/secretScan");
const envFile = path.join(root, ".env");
const mine = fs.existsSync(envFile) ? envSecrets(fs.readFileSync(envFile, "utf8")) : [];
const secrets = [];
for (const f of walkFiles(dir)) {
  if (/\.(woff2?|png|jpe?g|gif|ico|ttf)$/i.test(f)) continue;
  const hits = secretsIn(fs.readFileSync(f, "utf8"), mine);
  if (hits.length) secrets.push(`${path.relative(dir, f)}: ${hits.join(", ")}`);
}
if (secrets.length) fail(`a secret in the snapshot, nothing committed:\n  ${secrets.join("\n  ")}`);

// 5. One commit, one tag, as RELEASE_AUTHOR. NO HISTORY: the public repo is only these release commits, each a snapshot
// (git archive of HEAD), never the private repo's commits, messages or dates.
git(dir, "add", "-A");
if (!git(dir, "status", "--porcelain")) fail("nothing changed since the last release");
const as = ["-c", `user.name=${author[1]}`, "-c", `user.email=${author[2]}`];
// The commit's date is the release DAY at midnight UTC: no time of day, no timezone (a local offset would say where the
// operator is). GitHub shows when it was pushed anyway.
const day = `${new Date().toISOString().slice(0, 10)}T00:00:00+00:00`;
execFileSync("git", [...as, "commit", "-q", "-m", `Release ${tag}`], { cwd: dir, env: { ...process.env, GIT_COMMITTER_NAME: author[1], GIT_COMMITTER_EMAIL: author[2], GIT_AUTHOR_NAME: author[1], GIT_AUTHOR_EMAIL: author[2], GIT_AUTHOR_DATE: day, GIT_COMMITTER_DATE: day } });
git(dir, ...as, "tag", tag);
console.log(`release: ${tag} built in ${dir} from ${head}: ${git(dir, "ls-files").split("\n").length} files, author ${author[1]} <${author[2]}>`);

// 6. Out, only when asked.
if (!push) {
  console.log(`release: not pushed. Look it over in ${dir}, then: npm run release -- ${version} --push`);
  process.exit(0);
}
publish();

function walkFiles(d) {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name === ".git" ? [] : e.isDirectory() ? walkFiles(path.join(d, e.name)) : [path.join(d, e.name)]));
}

function publish() {
  execFileSync("git", ["push", "origin", "main"], { cwd: dir, stdio: "inherit" });
  execFileSync("git", ["push", "origin", tag], { cwd: dir, stdio: "inherit" });
  console.log(`release: ${tag} pushed to ${remote}`);
}
