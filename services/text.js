// What a post says, as display segments, the way X's own app shows it:
//   - a reply loses its reply prefix: the run of @mentions X puts at the
//     start of every reply (and hides in its app). The conversation already
//     shows who is talking to whom.
//   - a t.co link shows as its real domain, linked to the real URL
//   - the link to the post it quotes is dropped (the quote renders as a card)
//   - a media link (pic.x.com) is dropped when the caller shows the post's
//     pictures (`mediaShown`: Post.media is stored), else becomes a { media }
//     marker (no media stored: X didn't return it)
//   - an @mention in the text links to that person on X (an @handle opens X,
//     everywhere in xtoolio), as X's app does
//
// Driven by X's own entities, never a guess at the text. Mention offsets
// are used only for the prefix, which is pure ASCII from offset 0, so X's
// code-point offsets and JS's UTF-16 indexes agree there. Links are found by
// their exact t.co string and mentions by "@username" (not part of a longer
// handle), not by offset, because past an emoji offsets don't agree; their
// ORDER does, so links and mentions are taken together in entity order.
//
// Returns [{ text }, { text, href }, { media: true }] in order.
//
// THE rule for any address that came from X and becomes a link (a post's or a bio's links here, a profile's website
// in models/Person.js): only http(s). X builds these from what someone typed, and Handlebars escapes an attribute's
// quotes but not its scheme, so a "javascript:" address would render as a live href (proved offline,
// though the CSP's script-src 'self' also refuses to run one). Anything else shows as plain text. → the URL or null.
const webHref = (u) => (typeof u === "string" && /^https?:\/\//i.test(u.trim()) ? u.trim() : null);

function segments(p, { isReply = false, quotedId = null, mediaShown = false } = {}) {
  let text = p.text || "";

  if (isReply) {
    const skipSpace = (i) => {
      while (i < text.length && /\s/.test(text[i])) i++;
      return i;
    };
    // X's own boundary (`display_text_range`: every read and live event carries it): the @names X added. A post stored
    // before reads asked for it has none: then every @mention at the start, which also hides one TYPED there ("@maya is
    // it true" read "is it true"). Guessing from the post it answers was tried and measured worse: X also puts in front
    // names that post doesn't tag (most likely people tagged in its photo).
    const range = p.raw && p.raw.display_text_range;
    let pos = 0;
    if (Array.isArray(range) && Number.isInteger(range[0])) pos = range[0];
    else {
      const lead = (p.mentions || []).filter((m) => Number.isInteger(m.start)).sort((a, b) => a.start - b.start);
      for (const m of lead) {
        if (m.start !== skipSpace(pos)) break;
        pos = m.end;
      }
    }
    const rest = text.slice(skipSpace(pos));
    if (pos > 0 && rest) text = rest; // a reply that's only mentions keeps them
  }

  const out = [];
  let cursor = 0;
  const plain = (s) => s && out.push({ text: s });
  // Where an entity sits from `cursor` on: a link by its exact t.co string, a mention by "@username" (any case, as typed)
  // not followed by more handle characters. → [index, length] or null.
  const find = (e) => {
    if (e.url) {
      const at = text.indexOf(e.url, cursor);
      return at === -1 ? null : [at, e.url.length];
    }
    const re = new RegExp(`@${e.username.replace(/[^A-Za-z0-9_]/g, "")}(?![A-Za-z0-9_])`, "gi");
    re.lastIndex = cursor;
    const m = re.exec(text);
    return m ? [m.index, m[0].length] : null;
  };
  // Offsets disagree with JS indexes past an emoji, but their ORDER holds.
  const entities = [...(p.urls || []), ...(p.mentions || []).filter((m) => m.username)].sort((a, b) => (a.start || 0) - (b.start || 0));
  for (const e of entities) {
    const hit = find(e);
    if (!hit) continue;
    const [at, len] = hit;
    plain(text.slice(cursor, at));
    const shown = text.slice(at, at + len);
    cursor = at + len;
    if (!e.url) {
      out.push({ text: shown, href: `https://x.com/${e.username}` });
      continue;
    }
    if (quotedId && e.expanded && e.expanded.includes(`/status/${quotedId}`)) continue;
    if (e.media && mediaShown) continue;
    if (e.media) out.push({ media: true });
    else {
      const href = webHref(e.expanded) || webHref(e.url);
      out.push(href ? { text: e.display || e.expanded || e.url, href } : { text: shown });
    }
  }
  plain(text.slice(cursor));

  // Dropped links leave trailing whitespace behind.
  const last = out[out.length - 1];
  if (last && !last.href && !last.media) {
    last.text = last.text.trimEnd();
    if (!last.text) out.pop();
  }
  return out;
}

// A profile bio, the same way: its t.co links shown as their real domain (Person.bioUrls from X's entities).
// A profile stored before entities were requested keeps its raw t.co text until its next refresh.
const bioSegments = (profile) => (profile && profile.bio ? segments({ text: profile.bio, urls: profile.bioUrls || [] }) : []);

module.exports = { segments, bioSegments, webHref };
