// YOUR MEDIA (the same memes and pictures get reused, so anything posted before is one press away): every photo and GIF in your own posts, to attach to a reply again from the reply
// box's 📎 panel (public/js/attach.js). Nothing is stored for it: the posts already carry each picture's key and its
// address on X (Post.media, from every read of your timeline, so it includes what you posted on X itself), and a pick is
// fetched from X's own copy as the reply is sent and uploaded again (X gives every upload a new address, so the same
// meme posted twice is two items: pins, not counting, keep your favourites on top). Videos aren't offered (a reply
// carries photos or a GIF). Only YOUR OWN posts' media can be picked, and what you SAVED from other people's (save,
// below): every key is checked against those.
"use strict";

const Account = require("../models/Account");
const Post = require("../models/Post");
const Person = require("../models/Person");
const LiveEvent = require("../models/LiveEvent");
const { sourceOf, LIBRARY_HOSTS, MEDIA_LIMITS } = require("../lib/media");
const { createListing } = require("./listing");
const { visibleTo } = require("./accountData");

const LIBRARY_MAX = 240; // the panel: newest first; your pins always come along
const PINS_MAX = 60;
const SAVED_MAX = 500;
const KEY = /^\d+_\d+$/; // X's media_key: "<type>_<id>"
const POST_ID = /^\d{1,20}$/;
const PAGE = "/media";

// THE ITEM, for the panel and the page alike: one picture of one post. `type` "photo" | "gif" | "video"; `reusable`:
// it can go in a reply again (sourceOf: photos and GIFs, not videos). A saved one (someone else's) carries `from`, who
// it's tagged to ({ id, username, profile }, as the avatar partial takes a person), and sorts by when you saved it.
const KIND = { photo: "photo", animated_gif: "gif", video: "video" };
const itemOf = (post, m, pins, saved = null) => {
  const at = saved ? saved.at : post.createdAt;
  const from = saved ? saved.from : null;
  const src = sourceOf(m);
  return {
    key: m.key,
    postId: post._id,
    type: KIND[m.type],
    thumb: `${m.url}?name=small`,
    gif: src && src.kind === "gif" ? src.url : null, // it plays (partials/media-pic.hbs)
    pinned: pins.includes(m.key),
    reusable: !!src,
    saved: !!saved,
    from,
    at,
    atMs: at ? new Date(at).getTime() : 0,
  };
};

// What you saved, as items (each still on X: a saved post that's gone, or a key no longer in it, drops out).
async function savedItems(saved, pins, types) {
  if (!saved.length) return [];
  const posts = await Post.find({ _id: { $in: [...new Set(saved.map((s) => s.postId))] } }, "media createdAt text authorId").lean();
  const byPost = new Map(posts.map((p) => [p._id, p]));
  const people = await Person.find({ _id: { $in: [...new Set(saved.map((s) => s.by))] } }, "username name image").lean();
  const who = new Map(people.map((p) => [p._id, { id: p._id, username: p.username, profile: { name: p.name, image: p.image } }]));
  return saved
    .map((s) => {
      const post = byPost.get(s.postId);
      const m = post && (post.media || []).find((x) => x.key === s.key && types.includes(x.type));
      return m ? itemOf(post, m, pins, { at: s.at, from: who.get(s.by) || { id: s.by, username: null, profile: null } }) : null;
    })
    .filter(Boolean);
}

// Your posts' items of these X media types, newest post first (`limit` posts at most), plus any pinned ones older than
// that, plus everything you saved (newest saved first). → { items, pins }
async function load(accountId, types, limit = 0) {
  const [acct, posts] = await Promise.all([
    Account.findById(accountId, "mediaPins mediaSaved mediaHidden").lean(),
    Post.find({ authorId: accountId, "media.type": { $in: types } }, "media createdAt text").sort({ _id: -1 }).limit(limit).lean(),
  ]);
  const pins = (acct && acct.mediaPins) || [];
  const hidden = new Set((acct && acct.mediaHidden) || []); // removed from your media (hide)
  const saved = await savedItems((acct && acct.mediaSaved) || [], pins, types);
  const missing = limit ? pins.filter((k) => !posts.some((p) => p.media.some((m) => m.key === k)) && !saved.some((i) => i.key === k)) : [];
  const older = missing.length ? await Post.find({ authorId: accountId, "media.key": { $in: missing } }, "media createdAt text").lean() : [];
  const seen = new Map();
  for (const i of saved) if (!seen.has(i.key)) seen.set(i.key, i);
  for (const p of [...posts, ...older]) for (const m of p.media || []) if (types.includes(m.type) && !seen.has(m.key) && !hidden.has(m.key)) seen.set(m.key, itemOf(p, m, pins));
  return { items: [...seen.values()], pins };
}

// REMOVE one of your own pictures from your media (on), or put it back (off): the ✕ on a Media page tile. Off the
// Media page and the 📎 panel for good; the post and its picture stay on X (they're yours there, not xtoolio's). Its pin
// goes with it. Only a picture in one of your own posts (a saved one is removed by `save` off). → whether it changed.
const HIDDEN_MAX = 1000;
async function hide(accountId, key, on) {
  key = String(key || "");
  if (!KEY.test(key) || !(await Post.exists({ authorId: accountId, "media.key": key }))) return false;
  await Account.updateOne({ _id: accountId }, { $pull: { mediaHidden: key, ...(on && { mediaPins: key }) } });
  if (on) await Account.updateOne({ _id: accountId }, { $push: { mediaHidden: { $each: [key], $position: 0, $slice: HIDDEN_MAX } } });
  return true;
}

// The 📎 panel's items: what can go in a reply (photos and GIFs), your pins first (newest pin first), then what you
// saved (newest first: you kept it to send it), then the rest of yours newest first.
async function libraryFor(accountId) {
  const { items, pins } = await load(accountId, ["photo", "animated_gif"], LIBRARY_MAX);
  const usable = items.filter((i) => i.reusable);
  const byKey = new Map(usable.map((i) => [i.key, i]));
  return [...pins.map((k) => byKey.get(k)).filter(Boolean), ...usable.filter((i) => !i.pinned && i.saved), ...usable.filter((i) => !i.pinned && !i.saved)];
}

// SAVE someone else's photo or GIF to your media (on) or remove it (off; its pin goes too): from the "+ Save" on a
// picture in a post (partials/media.hbs). Only a picture that could go in a reply (sourceOf), only in a post by
// someone else, and only one this account was shown: the post is in its data, or in a conversation it's in (the
// shared store holds every account's posts; a saved key can be SENT, so it must be one you saw). → whether it changed.
async function save(accountId, key, postId, on) {
  key = String(key || "");
  if (!KEY.test(key)) return false;
  if (!on) {
    await noteCount(accountId, await Account.findOneAndUpdate({ _id: accountId }, { $pull: { mediaSaved: { key }, mediaPins: key } }, { new: true, projection: COUNT_FIELDS }).lean());
    return true;
  }
  postId = String(postId || "");
  if (!POST_ID.test(postId)) return false;
  const post = await Post.findById(postId, "authorId conversationId accounts seenBy media").lean();
  const m = post && (post.media || []).find((x) => x.key === key);
  if (!m || !sourceOf(m) || post.authorId === accountId) return false;
  const seen = (post.accounts || []).some((a) => a.id === accountId) || (post.conversationId && (await Post.exists({ conversationId: post.conversationId, "accounts.id": accountId })));
  // ...and one it may see (accountData.visibleTo: a private account's picture only if X showed the post to it).
  if (!seen || !(await visibleTo(accountId, [post])).length) return false;
  await Account.updateOne({ _id: accountId }, { $pull: { mediaSaved: { key } } });
  // A first save ever starts the count just before it ($min: an earlier "seen" stays).
  const at = new Date();
  const acct = await Account.findOneAndUpdate(
    { _id: accountId },
    { $push: { mediaSaved: { $each: [{ key, postId, by: post.authorId, at }], $position: 0, $slice: SAVED_MAX } }, $min: { mediaSeenAt: new Date(at.getTime() - 1) } },
    { new: true, projection: COUNT_FIELDS },
  ).lean();
  await noteCount(accountId, acct);
  return true;
}

// THE MEDIA PLACE'S COUNT (the sidebar's Media, routes/pages.js navFor: a save shows as a count that shakes, so
// it's clear it happened): what you saved since you last opened the Media page (Account.mediaSeenAt). From the account the request
// already loaded (REQUEST_FIELDS has both): no lookup. A save or a removal tells the open tabs (a "count" LiveEvent,
// public/js/live.js setCount: it shakes); opening the page sees them (seen).
const COUNT_FIELDS = "mediaSaved mediaSeenAt";
const unseenOf = (account) => {
  const since = account && account.mediaSeenAt;
  return since ? (account.mediaSaved || []).filter((s) => s.at > since).length : 0;
};
const noteCount = (accountId, acct) => (acct ? LiveEvent.note(accountId, "count", { tab: "media", n: unseenOf(acct) }) : null);
// The Media page opened: everything saved up to now is seen (its open tabs' count goes, if it showed).
async function seen(account) {
  const was = unseenOf(account);
  await Account.updateOne({ _id: account._id }, { $set: { mediaSeenAt: new Date() } });
  if (was) await LiveEvent.note(account._id, "count", { tab: "media", n: 0 });
  return was;
}

// THE MEDIA PAGE (/media): every photo,
// GIF and video in your posts, and what you saved from others, newest first. → the rows for `listing`.
async function mediaRows(accountId) {
  return (await load(accountId, ["photo", "animated_gif", "video"])).items;
}
// Its list through THE listing engine: All / Photos / GIFs / Videos / Pinned / Saved, newest first, no search.
const listing = createListing({
  path: PAGE,
  defaultSort: "newest",
  pageSize: 60,
  sorts: { newest: { value: (r) => r.atMs, natural: "desc" } },
  filters: {
    show: { values: ["all", "photo", "gif", "video", "pinned", "saved"], default: "all", test: (r, v) => v === "all" || (v === "pinned" ? r.pinned : v === "saved" ? r.saved : r.type === v) },
  },
});

// The keys you may use: in your own posts, or saved. → Map key → its media entry (X's address), from the posts.
async function yoursOrSaved(accountId, keys) {
  const acct = await Account.findById(accountId, "mediaSaved").lean();
  const saved = ((acct && acct.mediaSaved) || []).filter((s) => keys.includes(s.key));
  const [own, others] = await Promise.all([
    Post.find({ authorId: accountId, "media.key": { $in: keys } }, "media").lean(),
    saved.length ? Post.find({ _id: { $in: saved.map((s) => s.postId) } }, "media").lean() : [],
  ]);
  const savedKeys = new Set(saved.map((s) => s.key));
  return new Map([...own.flatMap((p) => p.media || []), ...others.flatMap((p) => (p.media || []).filter((m) => savedKeys.has(m.key)))].filter((m) => keys.includes(m.key)).map((m) => [m.key, m]));
}

// Pin (on) or unpin a key; only one of your own posts' pictures or one you saved. → whether it changed anything.
async function pin(accountId, key, on) {
  if (!KEY.test(String(key))) return false;
  if (on && !(await yoursOrSaved(accountId, [String(key)])).size) return false;
  await Account.updateOne({ _id: accountId }, { $pull: { mediaPins: key } });
  if (on) await Account.updateOne({ _id: accountId }, { $push: { mediaPins: { $each: [key], $position: 0, $slice: PINS_MAX } } });
  return true;
}

// The picked keys' bytes, from X's own copies, for a reply (lib/media.js checkAttachments with fromLibrary). Only keys
// in YOUR posts or saved; only X's hosts (LIBRARY_HOSTS), 10 s each, no bigger than a GIF may be. `room`: how many
// pictures the reply may still take (X's 4, less any uploaded with it), refused BEFORE anything is looked up or fetched:
// a form can send ~1,000 `library` fields, and each one fetched was a whole picture in this process's memory. → [{
// buffer, fromLibrary }], or throws { notice } (a lib/notices.js key).
async function fetchPicked(accountId, keys, room = MEDIA_LIMITS.photos) {
  const wanted = [...new Set((keys || []).map(String))].filter((k) => KEY.test(k));
  if (!wanted.length) return [];
  if (wanted.length > room) throw Object.assign(new Error(`${wanted.length} picked, room for ${room}`), { notice: "media-many" });
  const byKey = await yoursOrSaved(accountId, wanted);
  return Promise.all(
    wanted.map(async (k) => {
      const src = sourceOf(byKey.get(k));
      if (!src) throw Object.assign(new Error(`not your media: ${k}`), { notice: "media-gone" });
      const u = new URL(src.url);
      if (u.protocol !== "https:" || !LIBRARY_HOSTS.includes(u.hostname)) throw Object.assign(new Error(`not X's host: ${u.hostname}`), { notice: "media-gone" });
      const res = await fetch(u, { redirect: "error", signal: AbortSignal.timeout(10000) }).catch(() => null); // no redirects: the host check must hold
      if (!res || !res.ok) throw Object.assign(new Error(`X's copy of ${k}: ${res ? res.status : "unreachable"}`), { notice: "media-gone" });
      if (Number(res.headers.get("content-length")) > MEDIA_LIMITS.gifBytes) throw Object.assign(new Error(`${k} too big`), { notice: "media-big" }); // before reading it
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length > MEDIA_LIMITS.gifBytes) throw Object.assign(new Error(`${k} too big`), { notice: "media-big" });
      return { buffer, fromLibrary: true };
    })
  );
}

module.exports = { libraryFor, mediaRows, listing, pin, save, hide, seen, unseenOf, fetchPicked, PINS_MAX, SAVED_MAX, LIBRARY_MAX, PAGE };
