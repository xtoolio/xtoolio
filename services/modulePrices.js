// THE module prices (docs/MODULES.md): what each module costs a month, given which are on. One rule for Settings (an
// account's own measured pace) and the front page's estimator (a visitor's), so the two can't disagree. Pure.
//
// ADDITIVE: every row's price is its own part, in the fixed order, and the
// rows that count add up to the total. The one part two modules share, reading your conversations, is the Inbox's row:
// People needs it too, so with People on it's counted even while the Inbox is off (`inboxCounted`: the Inbox row says
// so, and turning the Inbox on then adds nothing). People's row is only what People adds on top of it.
//
// The parts (X's cost a month, already × the account's or the platform's multiplier):
//   conversations — your timeline, mentions, the posts around them and each new person's profile (the Inbox's row)
//   tiers         — People's profile freshness (your top people, everyone else: services/syncPrefs.js)
//   yourLikes     — the posts you like (decision 1): People's when People is on, else Liking's (the ♥ must know)
//   likers        — the Likes module: Live's like events, both ways, $0.001 each (measured), and the likers
//                   check for what a stream gap hid
//   reposts       — the Likes module too: reposts of your posts, a post event each (lib/pricing.js repostEvent)
//   follows       — the Follows module: follow and unfollow events, $0.01 each
//   liveReplies   — Replies, live, inside the Inbox
//   self          — your own profile, read every run whatever's on (the header's counts): no row of its own, it rides
//                   on the first module that counts (below)
//   sends         — WHAT YOU SEND: the likes and replies you send from xtoolio, at X's write price per press (the
//                   estimate-vs-real audit: on an active day the presses cost more than every module row together,
//                   and the total only mentioned them). Its own row, no switch: counted while the Inbox or People is on
//                   (they draw the ♥ and Reply).
// `on`: which are active { inbox, people, likes, follows, liveReplies, liking }.
// → { inbox, people, likes, follows, liveReplies, liking, self, inboxCounted, total }: each row's own part (what it adds
//   when turned on, given what's on: an Inbox already counted for People adds nothing); `total` counts what's on.
"use strict";

// The modules in their fixed order (services/features.js MODULES; kept here so this stays dependency-free).
const ORDER = ["inbox", "people", "likes", "follows"];

function modulePrices(parts, on) {
  const p = { conversations: 0, tiers: 0, yourLikes: 0, likers: 0, reposts: 0, follows: 0, liveReplies: 0, self: 0, sends: 0, ...parts };
  const reads = !!(on.inbox || on.people);
  // Your own profile is read whatever's on: it rides on the first module that counts (as a row of its own,
  // switching on the Inbox moved the total by more than the Inbox's row said). With nothing on, every
  // row's quote carries it, since whichever is turned on first brings it.
  const counts = { inbox: reads, people: !!on.people, likes: !!on.likes, follows: !!on.follows };
  const carrier = ORDER.find((k) => counts[k]);
  const own = (k) => (!carrier || k === carrier ? p.self : 0);
  const row = {
    inbox: p.conversations + own("inbox"),
    people: p.tiers + p.yourLikes + own("people"),
    likes: p.likers + p.reposts + own("likes"),
    follows: p.follows + own("follows"),
    // Inside the Inbox only: without it there's nothing to push.
    liveReplies: p.liveReplies,
    // Liking reads the posts you like unless People already does.
    liking: on.people ? 0 : p.yourLikes,
    self: p.self,
    sends: p.sends,
  };
  const counted = [
    reads && row.inbox,
    on.people && row.people,
    on.likes && row.likes,
    on.follows && row.follows,
    on.inbox && on.liveReplies && row.liveReplies,
    reads && on.liking && row.liking,
    reads && row.sends,
  ];
  return { ...row, sendsCounted: reads, inboxCounted: !on.inbox && !!on.people, total: counted.reduce((s, v) => s + (v || 0), 0) };
}

module.exports = { modulePrices };
