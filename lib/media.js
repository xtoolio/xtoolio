// PICTURES IN A REPLY: reply in the app with photos, GIFs and videos, as on X.
// THE rules for what a reply may carry, once: the route checks the files against them, and the reply box reads the
// same numbers (`MEDIA_LIMITS`, drawn into data attributes) to say no before uploading. X's own limits (docs.x.com
// media): a post carries up to 4 photos OR 1 animated GIF OR 1 video; a photo is JPG, PNG or WEBP up to 5 MB; a GIF
// up to 15 MB; a video an MP4 (X allows far bigger: here up to `videoBytes`, 20 MB, because the server holds a reply's
// files in memory while it passes them to X and nginx takes at most 25 MB a request, deploy/nginx-xtoolio.conf; a
// meme clip is a few MB). The file's TYPE is read from its first bytes (`sniff`), never trusted from its name or the
// browser's label. Pure.
"use strict";

const MB = 1024 * 1024;
const MEDIA_LIMITS = { photos: 4, photoBytes: 5 * MB, gifBytes: 15 * MB, videoBytes: 20 * MB };
// The most one file may be, whatever it is (the route's upload limit).
const MEDIA_MAX_BYTES = Math.max(MEDIA_LIMITS.gifBytes, MEDIA_LIMITS.videoBytes);
// What the box's file picker accepts (the server sniffs regardless).
const ACCEPT = "image/jpeg,image/png,image/webp,image/gif,video/mp4";

// A file's real type from its first bytes: "jpeg" | "png" | "webp" | "gif" | "mp4" | null.
function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  const head = buf.subarray(0, 6).toString("latin1");
  if (head === "GIF87a" || head === "GIF89a") return "gif";
  if (buf.subarray(4, 8).toString("latin1") === "ftyp") return "mp4";
  return null;
}
const MIME = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", mp4: "video/mp4" };

// YOUR MEDIA (services/mediaLibrary.js): a picture from one of your own posts, re-sent from X's own copy. Where to
// fetch it (X's hosts only): a photo at full size (pbs "?name=orig"); an animated GIF, which X keeps as a looping MP4
// beside its preview frame (pbs tweet_video_thumb/<id>.jpg → video.twimg.com/tweet_video/<id>.mp4: X's address
// pattern, checked on real posts, not documented). → { url, kind: "photo" | "gif" } or null (a video, or an
// address we don't recognise).
const LIBRARY_HOSTS = ["pbs.twimg.com", "video.twimg.com"];
function sourceOf(media) {
  if (!media || !media.url) return null;
  if (media.type === "photo" && /^https:\/\/pbs\.twimg\.com\/media\/[\w-]+\.\w+$/.test(media.url)) return { url: `${media.url}?name=orig`, kind: "photo" };
  const gif = media.type === "animated_gif" && media.url.match(/^https:\/\/pbs\.twimg\.com\/tweet_video_thumb\/([\w-]+)\.\w+$/);
  if (gif) return { url: `https://video.twimg.com/tweet_video/${gif[1]}.mp4`, kind: "gif" };
  return null;
}

// The files a reply carries ([{ buffer, fromLibrary? }]) checked against the rules. An MP4 you upload is a VIDEO
// (X's "tweet_video"); one from your own media (`fromLibrary`: X's copy of a GIF you posted) goes as a GIF. A GIF or a
// video goes alone. → { ok: true, items: [{ buffer, mime, category }] } or { ok: false, notice } (a lib/notices.js key).
const CATEGORY = { photo: "tweet_image", gif: "tweet_gif", video: "tweet_video" };
const LIMIT = { photo: "photoBytes", gif: "gifBytes", video: "videoBytes" };
function checkAttachments(files) {
  const items = (files || []).map((f) => {
    const sniffed = sniff(f.buffer);
    const kind = sniffed === "mp4" ? (f.fromLibrary ? "gif" : "video") : sniffed === "gif" ? "gif" : sniffed ? "photo" : null;
    return { buffer: f.buffer, mime: MIME[sniffed], kind };
  });
  if (!items.length) return { ok: true, items: [] };
  if (items.some((i) => !i.kind)) return { ok: false, notice: "media-type" };
  if (items.some((i) => i.kind !== "photo") && items.length > 1) return { ok: false, notice: "media-mix" };
  if (items.length > MEDIA_LIMITS.photos) return { ok: false, notice: "media-many" };
  for (const i of items) if (i.buffer.length > MEDIA_LIMITS[LIMIT[i.kind]]) return { ok: false, notice: "media-big" };
  return { ok: true, items: items.map((i) => ({ buffer: i.buffer, mime: i.mime, category: CATEGORY[i.kind] })) };
}

module.exports = { MEDIA_LIMITS, MEDIA_MAX_BYTES, MB, ACCEPT, LIBRARY_HOSTS, MIME, sniff, sourceOf, checkAttachments };
