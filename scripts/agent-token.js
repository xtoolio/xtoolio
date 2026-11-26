// Tokens for an account's own agent (/mcp, routes/mcp.js; models/AgentToken.js), from the command line until Settings
// has a panel for them:
//
//   npm run agent-token -- your_username "Claude Code on my laptop"   # make one: the token is printed ONCE
//   npm run agent-token -- your_username --list                      # its tokens: id, name, made, last used
//   npm run agent-token -- --revoke <id>                             # delete one (the id, or its first 8+ characters)
//
// A token reads the account's xtoolio data (the Inbox, a conversation, its people) and nothing else; it can't write.
"use strict";

const mongoose = require("mongoose");
const config = require("../config");
const { connect } = require("../lib/db");
const Account = require("../models/Account");
const AgentToken = require("../models/AgentToken");

const day = (d) => (d ? new Date(d).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "never");

(async () => {
  await connect(config);
  const args = process.argv.slice(2);
  try {
    const revokeAt = args.indexOf("--revoke");
    if (revokeAt !== -1) {
      const prefix = String(args[revokeAt + 1] || "").toLowerCase();
      if (!/^[0-9a-f]{8,64}$/.test(prefix)) throw new Error("--revoke needs a token id (at least its first 8 characters)");
      const rows = await AgentToken.find({ _id: { $regex: `^${prefix}` } }, "_id name").lean();
      if (rows.length !== 1) throw new Error(rows.length ? `${rows.length} tokens start with ${prefix}: give more of the id` : `no token ${prefix}`);
      await AgentToken.deleteOne({ _id: rows[0]._id });
      return console.log(`Revoked ${rows[0]._id.slice(0, 12)} (${rows[0].name || "unnamed"}). An agent using it is refused from now on.`);
    }
    const [username, ...rest] = args.filter((a) => a !== "--list");
    if (!username) throw new Error('usage: npm run agent-token -- <username> ["what it\'s for"] | <username> --list | --revoke <id>');
    const account = await Account.findOne({ username: new RegExp(`^${username.replace(/^@/, "").replace(/[^A-Za-z0-9_]/g, "")}$`, "i") }, "_id username").lean();
    if (!account) throw new Error(`no account @${username.replace(/^@/, "")}`);
    if (args.includes("--list")) {
      const rows = await AgentToken.find({ accountId: account._id }).sort({ createdAt: -1 }).lean();
      if (!rows.length) return console.log(`@${account.username} has no agent tokens.`);
      for (const r of rows) console.log(`${r._id.slice(0, 12)}  ${(r.name || "unnamed").padEnd(32)}  made ${day(r.createdAt)}  last used ${day(r.lastUsedAt)}`);
      return;
    }
    const { token, id } = await AgentToken.mint(account._id, rest.join(" "));
    console.log(`A token for @${account.username} (id ${id.slice(0, 12)}). It's shown once; xtoolio keeps only its hash.\n`);
    console.log(`  ${token}\n`);
    console.log("Claude Code:");
    console.log(`  claude mcp add --transport http ${config.brandName} ${config.appOrigin}/mcp --header "Authorization: Bearer ${token}"\n`);
    console.log(`Revoke it: npm run agent-token -- --revoke ${id.slice(0, 12)}`);
  } finally {
    await mongoose.disconnect();
  }
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
