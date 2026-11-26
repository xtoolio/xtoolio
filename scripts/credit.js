// Credit an account's balance BY HAND (the operator's own accounts, a refund made good, a design partner's start), or
// take a REFUND back off it:
//
//   npm run credit -- someone 1000 "the site's own account"   # adds $1,000.00, a "credit" row on its statement
//   npm run credit -- someone -25 "refunded in Stripe"         # takes $25.00 off, a "refund" row on its statement
//   npm run credit -- someone                                  # shows the balance now
//
// REFUNDS ARE BY HAND, ONE BY ONE (never automatic, each granted by the operator): nothing acts on
// Stripe's refund or dispute events. Grant it in Stripe, then take the same amount off here, or the account keeps the
// credit too. The balance may go below zero (syncing then pauses until a top-up).
//
// Through THE one mover (services/balance.js credit → move): the balance and its BalanceEntry row ("credit", the note
// as its label) in one exactly-once write, keyed by the account, the day and the amount, so the same command pasted
// twice credits once (a second credit of the same amount the same day: add --again). At most MAX_USD at a time. Never
// for the owner (it isn't charged). Billing on or off, the balance moves (off, it's a shadow bill; nothing gates).
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");
const config = require("../config");
const { connect } = require("../lib/db");
const Account = require("../models/Account");
const billing = require("../services/billing");

const MAX_USD = 5000;
const dollars = (micros) => `$${((micros || 0) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main() {
  const args = process.argv.slice(2);
  const again = args.includes("--again");
  const [name, amount, ...note] = args.filter((a) => a !== "--again");
  if (!name) throw new Error('usage: npm run credit -- <username> [usd, or -usd for a refund] ["note"] [--again]');
  await connect(config);
  const username = name.replace(/^@/, "").replace(/[^\w]/g, "");
  const acct = await Account.findOne({ username: new RegExp(`^${username}$`, "i") }, "username balanceMicros").lean();
  if (!acct) throw new Error(`no account @${username} (it signs in first)`);
  if (amount !== undefined) {
    const signed = Number(amount);
    const usd = Math.abs(signed);
    const refund = signed < 0;
    if (!(usd > 0 && usd <= MAX_USD) || Math.round(usd * 100) !== usd * 100) throw new Error(`the amount is dollars and cents, not 0, and at most ${MAX_USD} either way`);
    if (billing.isOwner(acct._id)) throw new Error(`@${acct.username} is the app owner: it isn't charged, so it has no balance to credit`);
    const day = new Date().toISOString().slice(0, 10);
    const ref = `hand:${acct._id}:${day}:${usd}${again ? `:${crypto.randomBytes(4).toString("hex")}` : ""}`;
    const label = `$${usd.toFixed(2)} ${refund ? "refunded" : "credit"}${note.length ? `: ${note.join(" ")}` : ""}`;
    const moved = refund ? await billing.takeBack(acct._id, Math.round(usd * 1e6), { ref, label }) : await billing.credit(acct._id, Math.round(usd * 1e6), { kind: "credit", ref, label });
    const did = refund ? `took ${dollars(usd * 1e6)} back from @${acct.username} (a refund)` : `credited @${acct.username} ${dollars(usd * 1e6)}`;
    console.log(moved ? did : `already done today (the same amount): nothing moved (add --again for a second one)`);
  }
  const now = await Account.findById(acct._id, "balanceMicros").lean();
  console.log(`@${acct.username}: balance ${dollars(now.balanceMicros)}`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
