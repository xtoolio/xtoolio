const mongoose = require("mongoose");

// One X post, stored once, forever, shared by every account. `_id` is X's post id, so a post already paid for
// is never stored (or paid for) twice, whichever account's sync read it.
//
// `accounts` says which signed-in accounts' feeds delivered this post, and how: kind "own" (their timeline) or
// "mention" (their mentions feed). One post can be one account's "own" and another's "mention". A post with no
// entry for an account is, from that account's view, "context": fetched to show a thread. streamFor() turns this
// into the per-account `stream`. What COUNTS on the leaderboard is decided by content, not by this
// (services/people.js exchangeWith): a context post replying to you counts.
//
// A context id X won't return (deleted, protected) is stored text-less with `gone` = X's error, so it isn't
// re-asked every run.
const PostSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    accounts: [{ _id: false, id: String, kind: { type: String, enum: ["own", "mention"] } }],
    // The accounts X returned this post to as CONTEXT (what a post they had answers or quotes, a live event's extras;
    // services/sync.js storeContext). With `accounts` and the author, it's who X showed the post to: a PRIVATE (protected)
    // account's post is drawn only for them (services/accountData.js visibleTo). Posts stored before this field existed have none.
    seenBy: [String],
    gone: { _id: false, title: String, detail: String },
    authorId: { type: String, index: true },
    text: String,
    createdAt: { type: Date, index: true },
    conversationId: { type: String, index: true },
    inReplyToUserId: { type: String, index: true },
    referenced: [{ _id: false, type: { type: String }, id: String }],
    // When it quotes a post: that post's author (a fact about the post, so shared like the rest). Set where the quoted
    // post's author is known at storing time (lib/x.js eventContents and quotesOf carry it): a quote of YOUR post is
    // someone talking to you (services/people.js exchangeWith), though it neither replies to nor tags you, so neither
    // X's mentions feed nor inReplyToUserId would ever show it (without it, a quote of an account's post never appeared).
    quotedAuthorId: { type: String, index: true },
    // X's entities, kept structured for display (services/text.js): where
    // each @mention sits, and what each t.co link really is.
    mentions: [{ _id: false, id: String, username: String, start: Number, end: Number }],
    urls: [{ _id: false, url: String, expanded: String, display: String, media: Boolean, start: Number }],
    // Its photos / video / GIF (lib/x.js MEDIA_EXPANSION), in order. `url` is the picture to show: the photo
    // itself, or a video's / GIF's preview frame (the video plays on X). Only X's image host is kept (the CSP's
    // one outside image origin). Unset on posts stored before media was read that weren't re-fetched.
    media: [{ _id: false, key: String, type: { type: String }, url: String, width: Number, height: Number, alt: String, durationMs: Number }],
    raw: mongoose.Schema.Types.Mixed,
    // The Likes extra checked who liked this post (only ever the author's own account can, so one field is
    // enough). Checked once, a day after posting; likes after that aren't seen.
    likersCheckedAt: Date,
  },
  { versionKey: false, timestamps: { createdAt: "storedAt", updatedAt: false } }
);
PostSchema.index({ "accounts.id": 1 });
PostSchema.index({ "mentions.id": 1 }); // "addressed to this account" (services/accountData.js accountPosts)

// X's v2 `text` HTML-escapes exactly &, < and > (and nothing else). `text`
// is stored as the real characters so views escape it once; `raw` keeps
// X's original.
function unescapeX(s) {
  return s && s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

PostSchema.statics.unescapeX = unescapeX;

// "own" | "mention" | "context", as `accountId` sees this post.
PostSchema.statics.streamFor = function streamFor(post, accountId) {
  const m = (post.accounts || []).find((a) => a.id === accountId);
  return m ? m.kind : "context";
};

// LONG POSTS (over 280): X's `text` is cut at 280 and the whole post is in `note_tweet.text` (asked for with
// tweet.fields=note_tweet, lib/x.js), which LEAVES OUT the reply @-prefix that `text` carries (seen in a spike:
// text "@someone yes, each one … cut the clips and", note_tweet.text "yes, each one … cut the clips and also …"). Rebuilt as
// prefix + whole text, so a long post has the same shape as any other: `text`'s entities still point at the
// right places, and services/text.js strips the prefix the usual way. note_tweet.entities (the tail's mentions and
// links, offsets into the note text) are shifted by the prefix length and merged in.
// Returns { text, shift } (shift = prefix length, 0 when the post isn't long).
function wholeText(p) {
  const top = unescapeX(p.text) || "";
  const note = p.note_tweet && unescapeX(p.note_tweet.text);
  if (!note) return { text: top, shift: 0 };
  // Walk the leading @mentions of `text` until what's left is how the note begins. Compared on a head of the
  // body, not to the end, so a cut mid-character or a trimmed tail can't break the match.
  for (let i = 0; ; ) {
    const body = top.slice(i);
    if (note.startsWith(body.slice(0, 60))) return { text: top.slice(0, i) + note, shift: i };
    const m = /^@\w+\s+/.exec(body);
    if (!m) return { text: note, shift: 0 }; // shapes disagree: the whole post, without a prefix
    i += m[0].length;
  }
}

PostSchema.statics.fromApi = function fromApi(p) {
  const { text, shift } = wholeText(p);
  const note = (p.note_tweet && p.note_tweet.entities) || {};
  const top = p.entities || {};
  const at = (n) => (Number.isInteger(n) ? n + shift : n);
  const mentions = [...(top.mentions || []), ...(note.mentions || []).map((m) => ({ ...m, start: at(m.start), end: at(m.end) }))]
    .filter((m) => m.id)
    .map((m) => ({ id: m.id, username: m.username, start: m.start, end: m.end }));
  const urls = [...(top.urls || []), ...(note.urls || []).map((u) => ({ ...u, start: at(u.start) }))].map((u) => ({
    url: u.url,
    expanded: u.expanded_url,
    display: u.display_url,
    media: !!u.media_key,
    start: u.start,
  }));
  // The note repeats whatever of the tail `text` already had: one entry per position (mentions) / t.co (links).
  const once = (key) => (x, i, all) => all.findIndex((y) => key(y) === key(x)) === i;
  return {
    _id: p.id,
    authorId: p.author_id,
    text,
    createdAt: p.created_at ? new Date(p.created_at) : undefined,
    conversationId: p.conversation_id,
    inReplyToUserId: p.in_reply_to_user_id,
    referenced: (p.referenced_tweets || []).map((r) => ({ type: r.type, id: r.id })),
    mentions: mentions.filter(once((m) => `${m.id}:${m.start}`)),
    urls: urls.filter(once((u) => u.url)),
    media: mediaOf(p),
    // Only when known (lib/x.js attaches `quoted_author_id` like `media`): a later read that doesn't know it must not
    // $set it away.
    ...(p.quoted_author_id ? { quotedAuthorId: p.quoted_author_id } : {}),
    raw: p,
  };
};

// The `media` lib/x.js attached (X's media objects) → what Post.media stores. A photo shows its own url; a video or
// GIF its preview frame. Anything not on X's image host is dropped (the CSP would block it anyway).
function mediaOf(p) {
  const list = (p.media || [])
    .map((m) => ({
      key: m.media_key,
      type: m.type,
      url: m.type === "photo" ? m.url : m.preview_image_url,
      width: m.width,
      height: m.height,
      alt: m.alt_text || undefined,
      durationMs: m.duration_ms,
    }))
    .filter((m) => typeof m.url === "string" && m.url.startsWith("https://pbs.twimg.com/"));
  return list.length ? list : undefined;
}

module.exports = mongoose.model("Post", PostSchema);
