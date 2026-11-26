// routes/inbox.js — THE INBOX (services/inbox.js, built by services/conversations.js inboxCards): the page at /, and
// its presses: Mark done / Not done and its undo, Mark all done, the bulk like, following a thread's writers.
// Mounted by web.js where the page's route always was.
"use strict";

const express = require("express");
const { noticeFor } = require("../lib/notices");
const Account = require("../models/Account");
const InboxMark = require("../models/InboxMark");
const InboxUndo = require("../models/InboxUndo");
const people = require("../services/people");
const inbox = require("../services/inbox");
const { refreshOwedSafely } = require("../services/inboxCount");
const inboxStart = require("../services/inboxStart");
const { syncSettings } = require("../services/accounts");
const { metered } = require("../services/usage");
const { active } = require("../services/features");
const { writesLeft } = require("../services/extras");
const { LIKE_ALL_MAX, inboxCards, withCardLike, threadFollowFor } = require("../services/conversations");
const { requireAccount, safeBack, withNotice, readyOrRender, replyBox, likeAllowance, wantsJson, balanceText, xFailure, bulkLabel, followMany, likeEach, keepLiveSwitch } = require("./pages");

module.exports = function inboxRoutes({ estimateLimiter }) {
  const router = express.Router();

  // The Inbox (services/inbox.js): replies, mentions and quotes as conversation cards, waiting until you mark them
  // done: Waiting / Done / All, a search, a sort, pages (the listing engine Your people uses). Every post opens on X; the ♥
  // (Liking) shows liked in place.
  router.get("/", estimateLimiter, async (req, res) => {
    const state = await readyOrRender(req, res, "inbox");
    if (!state) return;
    const L = inbox.listing;
    // The cards this page draws get THE THREAD ABOVE their seed (inboxCards `drawn`): the same listing the page is.
    const { rows, canLike, likesKnown, follows } = await inboxCards(req.account, { drawn: (all) => new Set(L.listRows(all, L.parseQuery(req.query)).rows.map((r) => r.conversationId)) });
    const list = L.listRows(rows, L.parseQuery(req.query));
    // The three tabs, each with how many cards it holds (the other filters and the search kept).
    const counted = (show) => L.listRows(rows, { ...list, show, page: 1 }).matched;
    const tabs = [["waiting", "Waiting"], ["done", "Done"], ["all", "All"]].map(([key, label]) => ({ key, label, n: counted(key), href: L.hrefFor(list, { show: key, page: 1 }), on: list.show === key }));
    // The rail: who (inbox.railOf) or which post (railOfPosts, `by=posts`) in this tab and search, whatever's picked,
    // still has a like or a reply coming; each narrows the list (`person`: their cards; `post`: that card alone).
    const inView = L.listRows(rows, { ...list, person: "", post: "", page: 1 }, Infinity).rows;
    const byPosts = list.by === "posts";
    const pick = { person: "", post: "", page: 1 };
    // EVERY row (it used to be capped at 30 with "and N more: search finds them"): rows clear as you work, so a
    // cap stranded people below it.
    const rail = byPosts ? inbox.railOfPosts(inView, { limit: Infinity }) : inbox.railOf(inView, { limit: Infinity });
    // "Mark all done" and the bulk like cover what this page knew about: no card whose latest message is newer than the
    // newest here.
    const upTo = rows.length ? String(rows[0].latestId) : "0";
    // THE RAIL'S ROWS (views/partials/rail-row.hbs), one shape for a person and a post (bulk like and done
    // at the person level, then the exact same controls at the post level): each with
    // its columns (`reply`, `like`: what it still owes) and its presses, ♥ (THE bulk like, POST /inbox/like-all with its
    // `person` or `post`: X's window, LIKE_ALL_MAX, the same price a press is) and ✓ (THE Mark all done, POST
    // /inbox/done-all with the same). `key`: its numbers' and row's name in the page (a person's id, "post-<id>");
    // `likeN`: how many one press likes now (0 while X's window is spent: the ♥ says when more come).
    const railLike = canLike ? await writesLeft(req.account._id, "like") : null;
    const likeNOf = (scope) => Math.min(railLike ? inbox.likeTargets(scope.post ? inView.filter((r) => r.conversationId === scope.post) : inView, { person: scope.person, upTo: BigInt(upTo) }).length : 0, railLike ? railLike.left : 0, LIKE_ALL_MAX);
    // `at` (ISO): when the row's newest owed reply came; a phone shows it and orders its list by it (public/js/rail-order.js).
    const isoOf = (d) => (d ? new Date(d).toISOString() : "");
    rail.rows = byPosts
      ? rail.posts.map((p) => ({ key: `post-${p.id}`, post: p.id, about: p.about, at: isoOf(p.at), like: p.like, reply: p.reply, href: L.hrefFor(list, { ...pick, post: p.id }), on: p.id === list.post, likeN: likeNOf({ post: p.id }) }))
      : rail.people.map((p) => ({ key: p.id, person: p.id, who: p, latest: p.latest, at: isoOf(p.latest && p.latest.at), like: p.like, reply: p.reply, href: L.hrefFor(list, { ...pick, person: p.id }), on: p.id === list.person, likeN: likeNOf({ person: p.id }) }));
    // THE FIRST ROW, Everyone / Every post, is THE row too (its ♥ once looked pressable and did nothing; now it
    // likes, and it has a Done that takes two clicks): its columns are
    // the totals, its ♥ the bulk like over the whole view (its search; every page), its ✓ Mark all done over it, TWO
    // clicks (one press marks everything). `all`: the routes take a rail press with no person or post only with it.
    rail.everyone = { key: "all", all: true, href: L.hrefFor(list, pick), on: !list.person && !list.post, like: rail.like, reply: rail.reply, likeN: likeNOf({}) };
    // Whom the list is narrowed to, by name (Mark all done's question says it). A post's view is one card: no question.
    const picked = list.person ? rows.flatMap((r) => r.owed).find((w) => w.id === list.person) : null;
    // What the toolbar's Done marks, in its own unit (with one person picked, "Done 2 posts" was wrong, since
    // only their replies on the post are done), and as the rail counts (replies for the people view, posts for the
    // posts view): the PEOPLE view counts REPLIES, a person's their replies still waiting in every
    // card here (inbox.focusOn's ids), Everyone every reply still waiting in the cards it marks (`waitingReplies`); the
    // POSTS view counts the cards, posts. Every page. The app's two words are post and reply, never "message".
    // `key`: the page's live count of it.
    const matchedAll = L.listRows(rows, { ...list, page: 1 }, Infinity).rows;
    const doneUnit = byPosts
      ? { n: list.matched, one: "post", many: "posts", key: "list-matched" }
      : { n: matchedAll.reduce((s, r) => s + (picked ? (inbox.focusOn(r, list.person).focus || { ids: [] }).ids.length : r.waitingReplies), 0), one: "reply", many: "replies", key: "done-replies" };
    // Seen through one person (the rail): each card shows only their messages still owed a like or a reply. In the plain
    // list a long card folds after its first few (inbox.capCard), with a link to it alone.
    if (list.person) list.rows = list.rows.map((r) => inbox.focusOn(r, list.person));
    else if (!list.post) list.rows = list.rows.map((r) => inbox.capCard(r, L.hrefFor(list, { ...pick, by: "posts", post: r.conversationId })));
    // Each card's own bulk like (withCardLike).
    if (railLike && railLike.left) list.rows = withCardLike(list.rows, list.person, likeNOf);
    // BULK LIKE: what this view still owes a like (every page, none newer than the page), and how many X allows now.
    const likeAll = list.show === "waiting" && canLike ? await likeAllFor(req.account, list, rows, upTo) : null;
    // A post's view (one card): follow the people who wrote in it, all of them or those who follow you.
    const threadFollow = list.post ? await threadFollowFor(req.account, rows.find((r) => r.conversationId === list.post), follows, list) : null;
    // LOAD EARLIER REPLIES (services/inboxStart.js): at the foot of the list's last page, in the plain list (Waiting or
    // All, no search, nobody or no post picked), while there are replies before the Inbox's start: how many a press adds.
    const plain = list.show !== "done" && !list.q && !list.person && !list.post;
    const more = plain && list.page >= list.pages ? await inboxStart.moreFor(req.account, await inboxStart.startFor(req.account)) : 0;
    res.render("inbox", {
      state,
      wide: true,
      list,
      canFollow: active(req.account, "following"), // THE Follow button beside each name (partials/follow-inline.hbs)
      headSwitch: keepLiveSwitch(req.account, "/"), // KEEP SYNCING LIVE, in the title row (services/away.js)
      tabs,
      // Always drawn, "Everyone 0" when nothing's owed: the page keeps its shape (at inbox zero it once fell back
      // to the one column).
      rail,
      railLike,
      byPosts,
      // People | Posts, each with how many it lists (who / which cards still owe something), as the tabs count theirs.
      railModes: [["people", "People", byPosts ? inbox.railOf(inView, { limit: Infinity }).people.length : rail.people.length], ["posts", "Posts", byPosts ? rail.posts.length : inbox.railOfPosts(inView, { limit: Infinity }).posts.length]].map(([key, label, n]) => ({ key, label, n, href: L.hrefFor(list, { ...pick, by: key }), on: list.by === key })),
      // The head's breakdown: every card's likes and replies owed, adding up to the red count (inbox.owedTotals).
      owed: inbox.owedTotals(rows),
      likeAll,
      threadFollow,
      likesKnown,
      everyoneHref: L.hrefFor(list, pick),
      picked,
      doneUnit,
      pager: L.pager(list),
      more: more ? { n: more, back: L.hrefFor(list, {}) } : null,
      // No reverse arrow here: "Oldest" is a sort of its own (inbox.listing).
      sorts: [["newest", "Newest"], ["oldest", "Oldest"], ["closest", "People you talk with most"], ["followers", "Most followers"]].map(([key, label]) => ({ key, label, selected: key === list.sort })),
      keep: L.keep(list),
      canLike,
      reply: replyBox(req.account),
      // The Inbox is on, so Liking, Replying and Pictures come with it: one missing means X hasn't granted its scope (an
      // account from before every sign-in asked for every scope). The page's one line under the title, only then; it
      // names pictures when they're all that's missing (media.write, asked for later than the rest).
      regrant: !canLike || !replyBox(req.account) ? { pictures: false } : !active(req.account, "pictures") ? { pictures: true } : null,
      upTo,
      // THE OWED TABLE (partials/owed-model.hbs): every number about what's owed, computed by the page as you press.
      owedModel: { entries: inbox.owedModel(rows, new Set(inView.map((r) => r.conversationId))), person: list.person, post: list.post, allow: railLike, max: LIKE_ALL_MAX },
    });
  });

  // BULK LIKE's button (views/partials/like-all.hbs) for a view of the Inbox (`list`: its parsed query): how many
  // messages it still owes a like (inbox.likeTargets, every page, none newer than `upTo`) and how many X allows now
  // (extras.writesLeft); a press likes min(both, LIKE_ALL_MAX). Drawn (hidden) with nothing owed too, so an unlike can
  // bring it back in place (post-actions.js recount, off THE OWED TABLE).
  async function likeAllFor(account, list, rows, upTo) {
    const L = inbox.listing;
    const view = L.listRows(rows, { ...list, page: 1 }, Infinity).rows;
    const owed = inbox.likeTargets(view, { person: list.person, upTo: BigInt(upTo) }).length;
    const allow = await writesLeft(account._id, "like");
    const n = Math.min(owed, allow.left, LIKE_ALL_MAX);
    return { n, owed, ...allow, q: list.q, person: list.person, post: list.post, upTo };
  }

  // THE INBOX'S WINDOW (the toolbar's "All replies | Last 24 hours", saved on change, and Settings' switch, which a
  // phone reaches: its Inbox's first screen has no toolbar; services/inboxStart.js WITHIN): kept on the account, so it
  // holds on every visit, and the red count is recounted for it before the page comes back (`back`, else the Inbox).
  router.post("/inbox/within", requireAccount, async (req, res) => {
    const v = String(req.body.within || "");
    if (inboxStart.WITHIN[v]) await Account.updateOne({ _id: req.account._id }, { $set: { inboxWithin: v } });
    else await Account.updateOne({ _id: req.account._id }, { $unset: { inboxWithin: 1 } });
    await refreshOwedSafely(req.account._id);
    res.redirect(303, safeBack(req.body.back, "/"));
  });

  // "Load N earlier replies" (the Inbox's foot; services/inboxStart.js loadMore): the Inbox's start moved back by the
  // next 20, so they join it (Waiting unless you'd answered and liked them); back to the same page, which now holds
  // them: its LAST page (they're the oldest, so at the end of a newest-first list; they can spill onto a new page), at
  // the list's foot.
  router.post("/inbox/more", requireAccount, async (req, res) => {
    const added = await inboxStart.loadMore(req.account);
    const L = inbox.listing;
    const back = new URL(safeBack(req.body.back, "/"), "http://x");
    let to = back.pathname + back.search;
    if (added) {
      await refreshOwedSafely(req.account._id); // they owe likes and replies: the red count
      const { rows } = await inboxCards(await Account.findById(req.account._id, Account.REQUEST_FIELDS).lean());
      const list = L.listRows(rows, L.parseQuery(Object.fromEntries(back.searchParams)));
      to = L.hrefFor(list, { page: list.pages });
    }
    res.redirect(303, withNotice(`${to}#inbox-more`, added ? "inbox-more" : "inbox-more-none"));
  });

  // An Inbox card's "Mark done" / Reopen (models/InboxMark.js): the conversation done through `through`, the latest
  // incoming message when you pressed it (a newer one from anyone makes the card wait again), or not done. From
  // public/js/post-actions.js as JSON (the card folds away in place); without script, back to the same view.
  // Post ids from a form field ("1,2,3"): only ids, at most 500.
  const messageIds = (v) => String(v || "").split(",").filter((s) => /^\d{1,20}$/.test(s)).slice(0, 500);
  // In the rail's person view the card sends `handled` (that person's messages, inbox.focusOn) in place of `through`:
  // just those are marked done, and the card waits on as long as anyone else's message in it isn't.
  router.post("/inbox/done", requireAccount, async (req, res) => {
    const { conversationId, through } = req.body;
    const handled = messageIds(req.body.handled);
    const ok = /^\d+$/.test(String(conversationId || "")) && (req.body.on !== "1" || handled.length > 0 || /^\d+$/.test(String(through || "")));
    const marking = req.body.on === "1";
    let undo = null;
    if (ok) {
      const key = { accountId: req.account._id, conversationId };
      // A Done is undoable from its toast (models/InboxUndo.js): the mark as it was, first.
      if (marking) undo = await InboxUndo.snapshot(req.account._id, [conversationId], InboxMark);
      if (!marking) await InboxMark.deleteOne(key);
      else if (handled.length) await InboxMark.updateOne(key, { $addToSet: { handled: { $each: handled } }, $set: { at: new Date() } }, { upsert: true });
      else await InboxMark.updateOne(key, { $set: { throughId: through, at: new Date() } }, { upsert: true });
      // The Inbox tab's count, in every open tab (services/inboxCount.js); awaited (a tenth of a second) so a page drawn
      // right after this answer has it. Nothing else is recounted for the answer: the page computes its own numbers
      // (THE OWED TABLE).
      await refreshOwedSafely(req.account._id);
    }
    if (wantsJson(req)) return ok ? res.json({ ok: true, done: marking, ...(undo && { undo, notice: "card-done", ...noticeFor("card-done") }) }) : res.status(400).json({ ok: false, ...noticeFor("x-failed") });
    const back = safeBack(req.body.back, "/");
    res.redirect(303, undo ? withNotice(back, "card-done", undo) : back);
  });

  // THE UNDO of a Done press (its toast's Undo, views/partials/toast.hbs; models/InboxUndo.js): every mark it touched put
  // back as it was (none: deleted), once; back to the page with the toast. Only the account's own record.
  // From public/js/post-actions.js (JSON: { ok, text, kind }; the page then draws its view again in place); without
  // script, back to the page with the toast.
  router.post("/inbox/undo", requireAccount, async (req, res) => {
    const back = safeBack(req.body.back, "/");
    const touched = await InboxUndo.restore(req.body.u, req.account._id, InboxMark);
    if (touched) await refreshOwedSafely(req.account._id);
    const n = touched === null ? "undo-gone" : "undone";
    if (wantsJson(req)) return res.json({ ok: touched !== null, ...noticeFor(n) });
    res.redirect(303, withNotice(back, n));
  });

  // "Mark all done" (the Waiting tab): every Waiting card the view matches (its search and the rail's person, every
  // page), as if pressed one by one: each through its latest message, or in a person's view just that person's
  // messages in it (inbox.focusOn), so anyone else's stay waiting. Only cards the page could have shown: none whose
  // latest message is newer than `upTo`, the newest when the page was drawn (a sync in between doesn't mark unseen
  // posts done). One bulk write; back to the same view, now empty; in a person's view, back to everyone when nothing of
  // theirs is left, as the card's own Done does.
  // A post's view (`post`, the toolbar's one-card Mark done, the rail's ✓ on a post) marks that one card. (Once
  // `post` wasn't read here, so that toolbar press in a post's view would have marked every waiting card.)
  // From public/js/post-actions.js (JSON; the page has already folded what it marks): { ok, undo, notice, text, href:
  // the view to be on now }; without script, the redirect.
  router.post("/inbox/done-all", requireAccount, async (req, res) => {
    const L = inbox.listing;
    const query = L.parseQuery({ q: req.body.q, person: req.body.person, post: req.body.post, by: req.body.by, show: "waiting" });
    const upTo = /^\d+$/.test(req.body.upTo || "") ? BigInt(req.body.upTo) : 0n;
    const { rows } = await inboxCards(req.account);
    const matched = L.listRows(rows, query, Infinity).rows;
    // A rail press is one person's, one post's, or Everyone's (`all`, the first row's ✓, two clicks); anything else
    // marks nothing (never everything by accident).
    const rail = req.body.rail === "1";
    const all = rail && req.body.all === "1";
    const cards = rail && !query.person && !query.post && !all ? [] : matched.filter((r) => r.latestId <= upTo);
    // Something of theirs newer than the page (left alone) keeps their view; otherwise it's empty: everyone.
    const emptied = (query.person || query.post) && cards.length === matched.length;
    const backTo = emptied ? { ...query, person: "", post: "" } : query;
    // From the rail's ✓ (rail-view.hbs: `rail`, the page's own person / post `stay` / `stayPost`, `by`, its tab `show`):
    // back to the view it was pressed in, unless that was this row's own view and nothing in it is left (then everyone).
    const page = rail ? L.parseQuery({ q: req.body.q, person: req.body.stay, post: req.body.stayPost, by: req.body.by, show: req.body.show }) : null;
    // Everyone's ✓ empties every view: back to everyone's.
    const back = !page ? backTo : all || (emptied && page.person === query.person && page.post === query.post) ? { ...page, person: "", post: "" } : page;
    const at = new Date();
    let undo = null;
    if (cards.length) {
      // Undoable from its toast (models/InboxUndo.js): every card's mark as it was, first.
      undo = await InboxUndo.snapshot(req.account._id, cards.map((r) => r.conversationId), InboxMark);
      const theirIds = (r) => (inbox.focusOn(r, query.person).focus || { ids: [] }).ids;
      const update = (r) => (query.person ? { $addToSet: { handled: { $each: theirIds(r) } }, $set: { at } } : { $set: { throughId: r.replyId, at } });
      await InboxMark.bulkWrite(cards.map((r) => ({
        updateOne: { filter: { accountId: req.account._id, conversationId: r.conversationId }, update: update(r), upsert: true },
      })), { ordered: false });
      await refreshOwedSafely(req.account._id);
    }
    const n = !cards.length ? "none-done" : query.person ? "person-done" : "all-done";
    // `partial`: something matched the press but was newer than the page and left alone, so the page (which folded
    // everything it showed) must be drawn again from here.
    if (wantsJson(req)) return res.json({ ok: true, undo, notice: n, ...noticeFor(n), partial: cards.length < matched.length, href: L.hrefFor(back, { page: 1 }) });
    res.redirect(303, withNotice(L.hrefFor(back, { page: 1 }), n, undo));
  });

  // BULK LIKE (the Inbox's "♥ Like N", views/partials/like-all.hbs): a press you make, within X's own
  // limits, with the page saying when more come. The view's messages still owed a
  // like (its search, person, post; every page, none newer than `upTo`: inbox.likeTargets), at most what X's window
  // and day allow now (extras.writesLeft) and LIKE_ALL_MAX, one after another through THE write (extras.setLike, each
  // like recorded in the press's one ledger unit at a press's price). Stops cleanly at X's limit or the balance gate with what's done
  // kept. JSON (post-actions.js likeAll): { liked: [ids], text, kind, likes, balance }. THE PAGE IS OPTIMISTIC: it
  // flipped the hearts it predicted (THE OWED TABLE, the same ids in the same order) when pressed, and this answer only
  // corrects it. Without script, back to the view with the toast. Not repeat-safe as a whole (a second press likes
  // the NEXT ones), so the page never retries it.
  // STREAMED when the page asks (Accept: application/x-ndjson): a first { total }, a line per like as X takes it
  // ({ left }), and the JSON answer last as { final }. The page shows none of it (it already shows the result); the
  // lines keep a long press's connection alive through nginx (X-Accel-Buffering: no, as /live), where one silent answer
  // of 50 likes (~45 s) would meet its read timeout.
  router.post("/inbox/like-all", requireAccount, async (req, res) => {
    const L = inbox.listing;
    const stream = (req.get("accept") || "").includes("application/x-ndjson");
    const json = stream || wantsJson(req);
    const query = L.parseQuery({ q: req.body.q, person: req.body.person, post: req.body.post, by: req.body.by, show: "waiting" });
    const back = L.hrefFor(query, { page: 1 });
    if (!active(req.account, "liking")) return json ? res.status(400).json({ ok: false, ...noticeFor("x-failed") }) : res.redirect(303, back);
    const upTo = /^\d+$/.test(req.body.upTo || "") ? BigInt(req.body.upTo) : 0n;
    const { rows } = await inboxCards(req.account);
    const view = L.listRows(rows, query, Infinity).rows;
    const allow = await writesLeft(req.account._id, "like");
    // A rail press is one person's, one post's, or Everyone's (`all`, the first row's ♥); anything else likes nothing.
    const everyone = !query.person && !query.post;
    const scoped = req.body.rail !== "1" || !everyone || req.body.all === "1";
    const ids = scoped ? inbox.likeTargets(view, { person: query.person, upTo }).slice(0, Math.min(allow.left, LIKE_ALL_MAX)) : [];
    const s = syncSettings(req.account._id);
    let liked = [];
    let n = !ids.length ? (allow.left ? "like-all-none" : "like-all-wait") : "liked-many";
    let gone = 0;
    const line = (o) => res.write(`${JSON.stringify(o)}\n`);
    if (stream) {
      res.set({ "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
      res.flushHeaders();
      line({ total: ids.length });
    }
    // ONE ledger row for the press (its unit, every like recorded in it), named once done with whom it liked (a
    // row per like, "Like · liked 1 post" dozens of times over, read badly).
    const authorOf = new Map(view.flatMap((r) => [...(r.earlier || []), ...r.dialogue, ...(r.rest || [])]).map((v) => [v.id, people.displayNameOf(v.author)]));
    // THE loop (routes/pages.js likeEach); the stream's line says what's still to go as each like lands. A gone post
    // (deleted on X since) owes nothing now; one no longer stored is skipped.
    const likeAll = async (meter) => {
      const r = await likeEach(req.account, ids, meter, { onEach: (i) => stream && i && line({ left: ids.length - i }) });
      ({ liked, gone } = r);
      if (r.stop) n = r.stop;
      if (liked.length) await meter.setLabel(bulkLabel("Liked", liked.map((id) => authorOf.get(id))));
    };
    if (ids.length) {
      try {
        await metered({ accountId: req.account._id, kind: "like", label: "Liked", billing: s.billing }, likeAll);
      } catch (err) {
        n = xFailure(err, `[like-all] for @${req.account.username}`); // the gate (out of balance) refused it before X
      }
    }
    if (stream && ids.length) line({ left: 0 }); // X is done
    if (liked.length || gone) await refreshOwedSafely(req.account._id);
    // From the rail's ♥ (rail-view.hbs: `rail`, the page's own person / post `stay` / `stayPost`, `by`, its tab `show`):
    // without script, back to the view it was pressed in.
    const page = req.body.rail === "1" ? L.parseQuery({ q: req.body.q, person: req.body.stay, post: req.body.stayPost, by: req.body.by, show: req.body.show }) : query;
    if (!json) return res.redirect(303, withNotice(L.hrefFor(page, { page: 1 }), n));
    // The page flipped its hearts when pressed (THE OWED TABLE predicted these same ids); the answer says which X
    // took (`liked`: any it predicted and isn't here flips back), X's like window after them (`likes`), the toast, the
    // balance. No recount: the page computes its own numbers.
    const notice = noticeFor(n, liked.length ? `${liked.length.toLocaleString("en-US")} ${liked.length === 1 ? "reply" : "replies"}` : null);
    const [likes, balance] = await Promise.all([likeAllowance(req.account, res.locals.timeZone), balanceText(req.account)]);
    const answer = { ok: true, liked, ...notice, likes, balance };
    if (stream) res.end(`${JSON.stringify({ final: answer })}\n`);
    else res.json(answer);
  });

  // FOLLOW A THREAD (views/partials/thread-follow.hbs, a post's view: follow everyone who wrote in a
  // thread, or only those who follow you): `only=back` follows
  // the people who wrote in that card and follow you, `only=all` everyone in it you don't follow (inbox.followTargets,
  // recomputed here: the form names only the conversation). At most what X allows now (extras.writesLeft "follow": 50
  // per 15 minutes, 400 a day) and FOLLOW_ALL_MAX, one after another through THE write (extras.setFollow: each in the
  // press's one ledger unit, each flipping its pair, so the header's "following" counts up), stopping cleanly at X's limit / the
  // gate. JSON (post-actions.js followAll): { done, text, html (the line redrawn), me, balance }; without script, back
  // to the view with the toast. Never retried (a second send follows the next ones). THE BULK FOLLOW itself is
  // routes/pages.js followMany.
  router.post("/inbox/follow-all", requireAccount, async (req, res) => {
    const L = inbox.listing;
    const json = wantsJson(req);
    const query = L.parseQuery({ post: req.body.post, by: req.body.by, show: req.body.show });
    const back = L.hrefFor(query, { page: 1 });
    const fail = (n) => (json ? res.status(400).json({ ok: false, ...noticeFor(n) }) : res.redirect(303, withNotice(back, n)));
    if (!active(req.account, "following") || !query.post) return fail("x-failed");
    const { rows, follows } = await inboxCards(req.account);
    const row = rows.find((r) => r.conversationId === query.post);
    if (!row) return fail("x-failed");
    const t = inbox.followTargets(row, follows);
    const { done, n } = await followMany(req.account, req.body.only === "back" ? t.back : t.all);
    if (!json) return res.redirect(303, withNotice(back, n));
    const notice = noticeFor(n, done.length ? `${done.length.toLocaleString("en-US")} ${done.length === 1 ? "person" : "people"}` : null);
    const fresh = await inboxCards(req.account);
    const line = await threadFollowFor(req.account, fresh.rows.find((r) => r.conversationId === query.post), fresh.follows, query);
    const me = await Account.findById(req.account._id, "followers following countsV").lean();
    res.render("thread-follow", { layout: false, threadFollow: line }, async (err, html) => {
      res.json({ ok: true, done, ...notice, html: err ? null : html, me: me && Account.meOf(me), balance: await balanceText(req.account) });
    });
  });

  return router;
};
