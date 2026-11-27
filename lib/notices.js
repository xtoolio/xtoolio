// Every message a redirect can leave behind, in ONE list: a route redirects to any page with ?n=<key> (web.js
// withNotice), web.js reads the key once for every page (res.locals.toast), and the layout shows it as the toast
// (views/partials/toast.hbs + public/js/toast.js). Before this there were three lists (Settings', billing's,
// sign-in's ?signin=) and each page drew its own box.
//
// kind "error": something didn't happen, so it stays until dismissed. Anything else fades by itself.
//
// SHORT AND SWEET (they had grown long): what happened,
// then the next step only when there is one, in a few words. No explaining why (the page, the countdown, the Terms
// do that), no restating what the press just showed. The client's own toasts (public/js) keep to the same.
// `kind`: none (it fades), "error" (it stays until dismissed), or "limit": an error that is X REFUSING a write for its
// limit, the one moment the header's stopwatch shakes and drops open (public/js/limits.js hit, called by toast.js).
// Reaching a limit by using it up is not one: the stopwatch just turns red, quietly.
"use strict";

const { MEDIA_LIMITS, MB } = require("./media");

const NOTICES = {
  // Sign-in (routes/auth.js)
  "signin-cancelled": { text: "Sign-in cancelled." },
  "signin-expired": { text: "Sign-in expired. Try again.", kind: "error" },
  "signin-failed": { text: "X didn't finish the sign-in. Try again.", kind: "error" },
  // THE ACCOUNT SWITCHER (lib/sessionAccounts.js; routes/auth.js). Adding one signs in with whichever account x.com is
  // on, so X signing you in as the account you're already on means it wasn't switched there first.
  "account-added": { text: "Account added." },
  "account-same": { text: "That's this account. Switch accounts on X first, then add it.", kind: "error" },
  "account-waitlist": { text: "That account is on the waitlist." },
  "signed-out-one": { text: "Signed out of that account." },
  "page-stale": { text: "This page is out of date. Reload it.", kind: "error" },
  // THE PAUSE (routes/pause.js).
  paused: { text: "Paused. Nothing is read until you resume." },
  resumed: { text: "Resumed." },
  // KEEP SYNCING LIVE (routes/pause.js /keep-live).
  "live-kept": { text: "Syncing stays live while you're away." },
  "live-away": { text: "Syncing will stop after an hour away." },
  "feedback-sent": { text: "Thanks, got it." },
  "feedback-empty": { text: "Nothing to send.", kind: "error" },
  "feedback-limit": { text: "That's today's limit. Send more tomorrow.", kind: "error" },
  "feedback-long": { text: "Too long. Send it in two parts.", kind: "error" },
  "feedback-shot-many": { text: "Up to 3 screenshots.", kind: "error" },
  "feedback-shot-big": { text: "Screenshots up to 10 MB each.", kind: "error" },
  "feedback-shot-type": { text: "Screenshots must be PNG, JPG, WEBP or GIF.", kind: "error" },
  // The waitlist (routes/admin.js): a Grant, a DM sent again.
  "waitlist-granted": { text: "Granted. Their DM goes out shortly." },
  "waitlist-granted-nodm": { text: "Granted. No DM: DMs are off." },
  "dms-retry": { text: "Queued again." },
  "dms-retry-none": { text: "Nothing to resend." },
  // An Invite by @handle (routes/admin.js).
  "invite-sent": { text: "Invited. Their DM goes out shortly." },
  "invite-sent-nodm": { text: "Invited. No DM: DMs are off." },
  "invite-already": { text: "They're already in." },
  "invite-account": { text: "They already have an account." },
  "invite-unknown": { text: "X has no such account.", kind: "error" },
  "invite-bad": { text: "That isn't an X handle.", kind: "error" },
  "invite-reauth": { text: "Sign in with X again, then invite.", kind: "error" },
  "invite-failed": { text: "Couldn't reach X. Try again.", kind: "error" },

  // Extras
  on: { text: "Turned on." },
  off: { text: "Turned off." },
  "last-module": { text: "Keep at least one on.", kind: "error" },

  // One person's profile, refreshed by hand (the ↻ on a card or a person's page). `named`: the same message saying
  // whose, where the caller knows (the in-place press's JSON; a redirect's ?n= carries only the key).
  "profile-refreshed": { text: "Refreshed.", named: "Refreshed {who}." },
  "profile-fresh": { text: "Already up to date." },
  "profile-gone": { text: "X didn't return that account.", kind: "error" },
  "x-failed": { text: "X didn't answer. Try again.", kind: "error" },

  // A bulk read (web.js pricedChoices): the balance doesn't cover its price (the button was disabled; a stale page)
  "bulk-short": { text: "Your balance doesn't cover that. Top up first.", kind: "error" },
  // READ FURTHER BACK, asked from Your circle (services/further.js)
  "further-started": { text: "Reading further back. Your circle fills in as it goes." },
  "further-going": { text: "Already reading further back." },
  // The follow reconciler (services/following.js; the read finishes in the worker, services/followingReads.js)
  "following-read": { text: "Checked who you follow." },
  // Its bulk unfollow (web.js POST /follows/back/unfollow)
  "unfollowed-many": { text: "Unfollowed.", named: "Unfollowed {who}." },
  "unfollowed-some": { text: "Unfollowed some, then hit X's limit.", named: "Unfollowed {who}, then hit X's limit." },
  "unfollow-limit": { text: "Hit X's limit partway. Do the rest in 15 minutes.", kind: "limit" },
  "unfollow-none": { text: "Pick someone first.", kind: "error" },
  "unfollow-wait": { text: "X's unfollow limit is used up for now.", kind: "limit" },

  // Your circle's public page (POST /people/circle/share)
  "circle-public": { text: "Your circle is public." },
  "circle-private": { text: "Your circle is private." },

  // Settings' Re-estimate (services/estimator.js remeasure)
  "estimate-updated": { text: "Re-estimated." },
  "estimate-recent": { text: "Already re-estimated this hour." },
  "x-limit": { text: "X's limit is used up. Try again in 15 minutes.", kind: "limit" },
  "out-of-balance": { text: "Your balance is empty. Top up to resume.", kind: "error" },
  // A bulk press stopped where the balance ran out (THE CEILING, checked before each write after the first).
  "liked-balance": { text: "Your balance ran out. Top up for the rest.", named: "Liked {who}, then your balance ran out. Top up for the rest.", kind: "error" },
  "followed-balance": { text: "Your balance ran out. Top up for the rest.", named: "Followed {who}, then your balance ran out. Top up for the rest.", kind: "error" },
  "unfollowed-balance": { text: "Your balance ran out. Top up for the rest.", named: "Unfollowed {who}, then your balance ran out. Top up for the rest.", kind: "error" },

  // The reply box
  replied: { text: "Replied." },
  "draft-discarded": { text: "Draft discarded." }, // a draft your agent left (models/Draft.js), ✕
  // Settings → Agents (routes/agents.js)
  "agent-disconnected": { text: "Disconnected." },
  "agent-gone": { text: "Already disconnected." },
  "agent-limit": { text: "Too many connections. Disconnect one first.", kind: "error" },

  // Deleting the account (routes/account.js). The refusals say "nothing deleted": that's the one fact that matters.
  "account-deleted": { text: "💥 Account deleted." },
  "delete-confirm": { text: "Handle didn't match. Nothing deleted.", kind: "error" },
  "delete-busy": { text: "A sync is running. Nothing deleted; try again in a minute.", kind: "error" },
  "delete-x": { text: "X didn't answer. Nothing deleted; try again.", kind: "error" },
  "delete-owner": { text: "The owner account can't be deleted.", kind: "error" },
  "delete-gone": { text: "Already deleted.", kind: "error" },
  "reply-empty": { text: "Write something first.", kind: "error" },
  "reply-long": { text: "Too long for X.", kind: "error" },
  "reply-gone": { text: "That post isn't on X any more.", kind: "error" }, // the ♥ uses it too
  // A reply's pictures (lib/media.js checkAttachments, web.js receiveMedia)
  "media-type": { text: "JPG, PNG, WEBP, GIF or MP4 only.", kind: "error" },
  "media-mix": { text: "A GIF or video goes alone.", kind: "error" },
  "media-many": { text: `Up to ${MEDIA_LIMITS.photos} photos.`, kind: "error" },
  "media-big": { text: `Too big: photos up to ${MEDIA_LIMITS.photoBytes / MB} MB, GIFs ${MEDIA_LIMITS.gifBytes / MB} MB, videos ${MEDIA_LIMITS.videoBytes / MB} MB.`, kind: "error" },
  "media-gone": { text: "That picture is gone from X. Pick another.", kind: "error" },
  "media-saved": { text: "Saved to Media." },
  "media-unsaved": { text: "Removed from Media." },
  "media-cant-save": { text: "Can't save that one.", kind: "error" },
  // One of your own pictures taken off your media, or put back (services/mediaLibrary.js hide). It stays on X.
  "media-removed": { text: "Removed from Media." },
  "media-restored": { text: "Back in Media." },
  "media-cant-remove": { text: "Can't remove that one.", kind: "error" },
  "media-regrant": { text: "Sign in with X again to attach pictures.", kind: "error" },

  // The Inbox
  // Bulk like (web.js POST /inbox/like-all)
  "liked-many": { text: "Liked.", named: "Liked {who}." },
  "like-all-limit": { text: "Hit X's like limit. More in 15 minutes.", named: "Liked {who}, then hit X's limit. More in 15 minutes.", kind: "limit" },
  "like-all-none": { text: "Nothing to like here." },
  // THE LIKESTORM (routes/pages.js answerStorm): none of their latest posts unliked (or none X serves you), no handle
  // typed, a handle X has no account for.
  "latest-none": { text: "Nothing of theirs left to like." },
  "storm-handle": { text: "Type their @handle." },
  "storm-unknown": { text: "X has no account by that name.", kind: "error" },
  "storm-self": { text: "That's you. Try someone else." },
  "storm-ready": { text: "You're set up for likestorms." },
  "like-all-wait": { text: "X's like limit is used up for now.", kind: "limit" },
  // A bulk like the page showed at once (post-actions.js) whose answer never came: the page reloads with what X took.
  "likes-lost": { text: "Connection lost. Showing what went through.", kind: "error" },
  // Following a thread's people (web.js POST /inbox/follow-all)
  "followed-many": { text: "Followed.", named: "Followed {who}." },
  "followed-some": { text: "Followed some, then hit X's limit. The rest are still on the list.", named: "Followed {who}, then hit X's limit. The rest are still on the list." },
  "follow-all-limit": { text: "Hit X's follow limit. More in 15 minutes.", named: "Followed {who}, then hit X's limit. More in 15 minutes.", kind: "limit" },
  "follow-all-none": { text: "You follow everyone here." },
  "follow-all-wait": { text: "X's follow limit is used up for now.", kind: "limit" },
  // Follows → Who they tag (routes/tagged.js)
  "tags-handle": { text: "That isn't an X handle.", kind: "error" },
  "tags-unknown": { text: "X has no such account.", kind: "error" },
  "tags-pick": { text: "Pick someone to follow first." },
  // A Done press: each offers Undo in its toast (?u=, models/InboxUndo.js); POST /inbox/undo answers with the last two.
  "card-done": { text: "Done." },
  // A Done the page showed at once (post-actions.js, DONE IS OPTIMISTIC) that didn't save: the page reloads with this.
  "done-failed": { text: "Couldn't save that. Try again.", kind: "error" },
  "inbox-more": { text: "Earlier replies added." },
  "inbox-more-none": { text: "No earlier replies." },
  "all-done": { text: "All done." },
  "person-done": { text: "Marked done." },
  "none-done": { text: "Nothing was waiting." },
  "undone": { text: "Back in Waiting." },
  "undo-gone": { text: "Too late to undo. Reopen it from Done.", kind: "error" },

  // Settings
  tz: { text: "Time zone saved." },
  saved: { text: "Saved." },

  // Money (on whichever page it started from: the "how far back?" page, Settings)
  paid: { text: "Added to your balance." },
  pending: { text: "Payment received. Reload in a moment to see it." },
  cancelled: { text: "Cancelled. Nothing charged." },
  payfail: { text: "Couldn't open payment. Try again.", kind: "error" },
  card: { text: "Card saved." },
  "refill-on": { text: "Auto-refill on." },
  "refill-off": { text: "Auto-refill off. Syncing pauses at $0." },
};

// The notice for a ?n= value, or null (an unknown key shows nothing). `who` (optional): a notice with a `named` form
// says whose ({ text, kind }, the same shape either way).
function noticeFor(key, who) {
  if (typeof key !== "string" || !Object.prototype.hasOwnProperty.call(NOTICES, key)) return null;
  const n = NOTICES[key];
  if (!who || !n.named) return n;
  return { text: n.named.replace("{who}", who), ...(n.kind ? { kind: n.kind } : {}) };
}

// THE notice for something X work threw (a press's route, a read the worker finishes): the gate, a stale sign-in, X's
// limit, or X failing (logged with `what`). → a key above.
function failureNotice(err, what) {
  if (err.code === "OUT_OF_BALANCE") return "out-of-balance";
  if (err.code === "NEEDS_REAUTH") return "signin-expired";
  if (err.status === 429) return "x-limit";
  console.error(`${what} failed: ${err.message}`);
  return "x-failed";
}

module.exports = { NOTICES, noticeFor, failureNotice };
