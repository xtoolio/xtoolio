// One account's own multiplier on X's cost (a design partner at cost, say), or back to the platform's:
//
//   npm run margin -- someone 1 "design partner, at cost"   # this account pays X's cost × 1
//   npm run margin -- someone clear                         # back to MARGIN_MARKUP_PCT
//   npm run margin -- someone                               # show what it is now
//
// A DISCOUNT only (services/balance.js multiplierFor): from 1 (X's cost) up to the platform's own rate, never above
// it. Applies to units charged after it.
"use strict";

const mongoose = require("mongoose");
const config = require("../config");
const { connect } = require("../lib/db");
const Account = require("../models/Account");
const { MIN_MULTIPLIER } = require("../services/balance");
const billing = require("../services/billing");

async function main() {
  const [name, value, ...note] = process.argv.slice(2);
  if (!name) throw new Error("usage: npm run margin -- <username> [multiplier | clear] [note]");
  await connect(config);
  const username = name.replace(/^@/, "");
  const acct = await Account.findOne({ username: new RegExp(`^${username.replace(/[^\w]/g, "")}$`, "i") }, "username marginMultiplier marginNote").lean();
  if (!acct) throw new Error(`no account @${username}`);
  if (value !== undefined) {
    if (value === "clear") {
      await Account.updateOne({ _id: acct._id }, { $unset: { marginMultiplier: 1, marginNote: 1 } });
    } else {
      const m = Number(value);
      if (!(m >= MIN_MULTIPLIER && m <= config.billing.multiplier)) throw new Error(`the multiplier must be between ${MIN_MULTIPLIER} (X's cost) and ${config.billing.multiplier} (the platform's rate): a discount, never more`);
      await Account.updateOne({ _id: acct._id }, { $set: { marginMultiplier: m, marginNote: note.join(" ").slice(0, 200) } });
    }
  }
  const now = await Account.findById(acct._id, "marginMultiplier marginNote").lean();
  const own = typeof now.marginMultiplier === "number";
  console.log(`@${acct.username}: ×${billing.multiplierFor(now)} ${own ? `(its own${now.marginNote ? `: ${now.marginNote}` : ""})` : "(the platform's)"}`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
