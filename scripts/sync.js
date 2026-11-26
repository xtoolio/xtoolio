// Sync one account from the command line, with the full report. The app's scheduler runs the same engine for
// every account every SYNC_EVERY_MINUTES (services/scheduler.js); this is for a one-off, usually a big pull:
//
//   npm run sync -- your_username               # caps from SYNC_READ_CAP / SYNC_USER_CAP
//   npm run sync -- your_username --cap 4000    # a bigger post cap for this run only
//
// The account must have signed in with X (its token is what the sync reads with). With only one account, the
// username can be left out. What a run does, and why it can't overlap the scheduler: services/sync.js.
"use strict";

const mongoose = require("mongoose");
const config = require("../config");
const { connect } = require("../lib/db");
const Account = require("../models/Account");
const { runSync } = require("../services/sync");
const { syncSettings } = require("../services/accounts");

function argCap() {
  const i = process.argv.indexOf("--cap");
  if (i === -1) return null;
  const n = Number(process.argv[i + 1]);
  if (!Number.isInteger(n) || n < 5) throw new Error("--cap needs a whole number of at least 5");
  return n;
}

// The username argument: whatever isn't --cap or its value.
function argUsername() {
  const args = process.argv.slice(2);
  const capAt = args.indexOf("--cap");
  const rest = args.filter((a, i) => capAt === -1 || (i !== capAt && i !== capAt + 1));
  return rest[0] ? rest[0].replace(/^@/, "").toLowerCase() : null;
}

async function pickAccount() {
  const all = await Account.find({}, "username").lean();
  const name = argUsername();
  if (name) {
    const acct = all.find((a) => a.username.toLowerCase() === name);
    if (!acct) throw new Error(`no account @${name} (it has to sign in with X first)`);
    return acct;
  }
  if (all.length === 1) return all[0];
  throw new Error(all.length ? `which account? ${all.map((a) => a.username).join(", ")}` : "no accounts yet: sign in with X first");
}

async function main() {
  const readCap = argCap() || config.sync.readCap;
  await connect(config);
  const acct = await pickAccount();
  console.log(`Syncing @${acct.username}, read cap ${readCap} posts.`);

  const r = await runSync(syncSettings(acct._id, readCap));
  if (r.skipped) {
    console.log(`Not run: ${r.skipped}.`);
    return;
  }
  for (const s of r.streams) console.log(`  ${s.label}: read ${s.read}, new ${s.added}${s.complete ? ", history complete" : ""}`);
  console.log(`  posts: ${r.postsStop}.`);
  console.log(`  thread context: ${r.context.fetched} fetched, ${r.context.gone} unavailable; ${r.contextStop}.`);
  console.log(`  profiles: ${r.profiles.fetched} fetched, ${r.profiles.gone} not on X, of ${r.profiles.due} due; ${r.profilesStop}.`);
  console.log(`This run: ${r.usage.posts} posts + ${r.usage.users} user lookups in ${r.usage.requests} requests. Its estimate is on the Usage page (/usage), with X's balance just after it.`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
