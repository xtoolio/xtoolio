// npm run feedback [-- --live] [--all] [--n 50]: the newest feedback people sent (routes/feedback.js), for reading it
// together in a working session. Read-only. --live reads the deployment's database through MONGO_LIVE_READ_URI (a
// developer's machine, `.env.example`), else MONGO_URI. Only what isn't handled yet, unless --all.
"use strict";

const mongoose = require("mongoose");
const config = require("../config");

const args = process.argv.slice(2);
const live = args.includes("--live");
const all = args.includes("--all");
const n = Number(args[args.indexOf("--n") + 1]) || 50;

(async () => {
  const uri = live ? config.liveReadUri : config.mongoUri;
  if (!uri) throw new Error("--live needs MONGO_LIVE_READ_URI");
  const conn = await mongoose.createConnection(uri).asPromise();
  const rows = await conn.db.collection("feedbacks").find(all ? {} : { doneAt: { $exists: false } }).sort({ at: -1 }).limit(n).toArray();
  if (!rows.length) console.log(all ? "No feedback yet." : "Nothing waiting (--all shows what's handled).");
  for (const r of rows) {
    console.log(`\n@${r.username || r.accountId} · ${new Date(r.at).toISOString().slice(0, 16).replace("T", " ")} UTC · ${r.page || "?"}${r.doneAt ? " · done" : ""}`);
    console.log(String(r.text).replace(/^/gm, "  "));
    const shots = (r.shots || []).length;
    if (shots) console.log(`  [${shots} screenshot${shots === 1 ? "" : "s"}: Admin → Feedback, ${config.appOrigin}/admin?tab=feedback#f${r._id}]`);
  }
  await conn.close();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
