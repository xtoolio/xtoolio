// Dev-only preload (node -r ./scripts/force-writes.js app.js, on a second port): treat the
// write extras as active, Liking whenever Likes is, Following whenever Follows is, Replying and Pictures always, so the
// ♥, the Follow button, the reply box and its 📎 render for scripts/shot.js before X has granted like.write /
// follows.write / tweet.write / media.write. Writes nothing itself, but NEVER press a ♥ or a Follow button or send a
// reply on an instance running this: it would call X (stub window.fetch in SHOT_JS to exercise them).
const f = require("../services/features");
const real = f.active;
const forced = { liking: (a) => real(a, "likes"), following: (a) => real(a, "follows"), replying: () => true, pictures: () => true };
f.active = (account, key) => (forced[key] ? forced[key](account) : real(account, key));
