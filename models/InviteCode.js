const mongoose = require("mongoose");

// THE INVITE LINK (services/invites.js): one per account, made the first time its Settings shows it. `_id` the code in
// the link (/i/<code>, random), `accountId` whose it is, `used` who signed up through it ({ id, username, at }, at
// most config.invites.perAccount of them, added atomically by redeem). Deleted with its account (services/deleteAccount.js).
const InviteCodeSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    accountId: { type: String, required: true, unique: true },
    used: { type: [{ _id: false, id: String, username: String, at: Date }], default: [] },
    createdAt: { type: Date, required: true },
  },
  { versionKey: false, collection: "invitecodes" }
);

module.exports = mongoose.model("InviteCode", InviteCodeSchema);
