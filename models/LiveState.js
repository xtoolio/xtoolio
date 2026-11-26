const mongoose = require("mongoose");

// The health of X's activity stream (services/live.js): ONE doc, `_id: "stream"`, written by the worker that holds
// the connection. `beatAt` every 30 s while connected (lib/heartbeat.js); a beat older than the lease means nobody is
// connected (a crash, a deploy), whatever `connectedAt` says. The header reads it to say "Live" or when it last synced.
const LiveStateSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "stream" },
    connectedAt: Date, // this connection's start; unset while disconnected
    // Which connection set connectedAt: only that one clears it (a restart's old worker closes after the new one opened).
    connId: String,
    beatAt: Date,
    lastEventAt: Date,
    lastError: String,
    lastErrorAt: Date,
  },
  { versionKey: false, collection: "livestate" }
);

module.exports = mongoose.model("LiveState", LiveStateSchema);
