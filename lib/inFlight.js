// AT MOST N AT ONCE, per account, in this process: what an account holding many of something at once could use to
// exhaust a web process (a reply's or feedback's pictures held in memory, up to ~21 MB each; open /live streams, each a
// socket). `take(id)` → a release function, or null when the account already has `max` going. The release is safe to
// call twice (a response's "close" and an error path).
"use strict";

function inFlight(max) {
  const open = new Map();
  return {
    take(id) {
      const n = open.get(id) || 0;
      if (n >= max) return null;
      open.set(id, n + 1);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        const left = (open.get(id) || 1) - 1;
        if (left) open.set(id, left);
        else open.delete(id);
      };
    },
  };
}

// The same as Express middleware, for a signed-in route: past `max`, refused with `refuse(req, res)`; otherwise the
// place is held until the response closes.
function inFlightMiddleware(max, refuse) {
  const slots = inFlight(max);
  return (req, res, next) => {
    const release = slots.take(String(req.account._id));
    if (!release) return refuse(req, res);
    res.on("close", release);
    next();
  };
}

module.exports = { inFlight, inFlightMiddleware };
