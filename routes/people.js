// routes/people.js — YOUR PEOPLE (services/people.js): the leaderboard at /people, a person's page and one
// conversation with them, Your circle and its public page and share image (services/circle.js), and the presses on a
// person (Follow, ↻ refresh). Mounted by web.js where /people always was. /people/circle comes before /people/:id.
"use strict";

const express = require("express");
const config = require("../config");
const { noticeFor } = require("../lib/notices");
const { isHandle } = require("../lib/handle");
const Account = require("../models/Account");
const Person = require("../models/Person");
const Follow = require("../models/Follow");
const people = require("../services/people");
const listing = require("../services/listing");
const follows = require("../services/follows");
const circle = require("../services/circle");
const { circlePng } = require("../services/circleImage");
const { bioSegments } = require("../services/text");
const { profilesFor } = require("../services/accountData");
const { refreshProfile } = require("../services/sync");
const further = require("../services/further");
const SyncState = require("../models/SyncState");
const { syncSettings } = require("../services/accounts");
const { isOn, active } = require("../services/features");
const { setFollow } = require("../services/extras");
const { likeFacts, knowsFollows, savedMediaOf, conversationCard, boardFor, circleFor, loadPerson } = require("../services/conversations");
const { CIRCLE_PAGE, requireAccount, safeBack, withNotice, readyOrRender, conversationPage, wantsJson, balanceText, refusedJson, xFailure, furtherChoices, FURTHER_STATE, fundsView, pageSwitch } = require("./pages");

module.exports = function peopleRoutes() {
  const router = express.Router();

  // Your people: the leaderboard (services/listing.js `people`).
  router.get(listing.people.path, async (req, res) => {
    const state = await readyOrRender(req, res, "people");
    if (!state) return;
    const { rows, signals } = await boardFor(req.account);
    const list = listing.people.listRows(rows, listing.people.parseQuery(req.query));
    const likeCols = likeFacts(req.account); // (not `likes`: that's services/likes.js here)
    // The sort picker (the cards have no column headers): every sort with data, and the arrow that reverses it.
    const sorts = [
      { key: "mutual", label: "Back and forth" },
      { key: "replies", label: "Replies" },
      (likeCols.you || likeCols.them) && { key: "likes", label: "Likes" },
      { key: "followers", label: "Followers" },
      { key: "last", label: "Last" },
      { key: "name", label: "Name" },
    ]
      .filter(Boolean)
      .map((s) => ({ ...s, selected: s.key === list.sort }));
    res.render("leaderboard", {
      wide: true,
      state,
      likes: likeCols,
      showFollows: knowsFollows(signals),
      canFollow: active(req.account, "following"), // THE Follow button on each card
      list,
      sorts,
      reverseHref: listing.people.sortHref(list, list.sort),
      pager: listing.people.pager(list),
      headSwitch: pageSwitch(req.account, "people"), // the module's switch, in the title row
    });
  });

  // ── YOUR CIRCLE (services/circle.js) ──
  // The partial's context for `owner` (an Account) and its members (ranked, { id, username, profile }): THE board view,
  // where each face opens (`hrefOf`; `external`: it leaves for X).
  // Drawn at the owner's size (Account.circle.size; services/circle.js SIZES, the classic by default).
  const sizeKeyOf = (account) => circle.sizeOf(account.circle && account.circle.size).key;
  const circleView = (owner, members, opts) => circle.boardView({ id: owner._id, username: owner.username, profile: { name: owner.name, image: owner.image } }, members, sizeKeyOf(owner), opts);
  // The public address of an account's circle, and its share image's (versioned by when the circle last changed, so X
  // fetches a new picture when it does).
  const circleHref = (account) => `/@${account.username}`;
  // `shape` (services/circleImage.js SHAPES): "card" is the link's preview, circle.png; "square" the one to download.
  const CIRCLE_IMAGE_FILES = { card: "circle.png", square: "circle-square.png" };
  const circleImageHref = (account, shape = "card") => `${circleHref(account)}/${CIRCLE_IMAGE_FILES[shape]}?v=${account.circle && account.circle.at ? new Date(account.circle.at).getTime() : 0}`;

  // Your circle (the sidebar's Circle): the circle, and sharing it as a public page. Opening it keeps a public circle
  // current (Account.keepCircle: only when it changed).
  router.get(CIRCLE_PAGE, async (req, res) => {
    const state = await readyOrRender(req, res, "people");
    if (!state) return;
    const size = sizeKeyOf(req.account);
    const { members } = await circleFor(req.account, size);
    await Account.keepCircle(req.account._id, members.map((m) => m.id));
    // Not full: why (one day of conversations is a handful of people, and a ring is drawn only when full), and READ
    // FURTHER BACK (services/further.js) right there, priced, or how far one has got.
    const sync = (await SyncState.findById(req.account._id, FURTHER_STATE).lean()) || {};
    const reading = further.progress(req.account, sync);
    const choices = reading ? [] : await furtherChoices(req.account, sync);
    const picked = choices.find((o) => o.affordable);
    if (picked) picked.selected = true;
    const shared = !!(req.account.circle && req.account.circle.public);
    const handles = members.filter((m) => m.username).map((m) => `@${m.username}`);
    // Shared: the share image's address as of the write above (its version is when the circle last changed), for
    // "Download picture" (post the picture itself; X's compose link can't attach one).
    const kept = shared ? await Account.findById(req.account._id, "username circle.at").lean() : null;
    res.render("circle", {
      state,
      wide: true,
      circlePage: true, // the layout links /circle.css
      // A face opens their People page; someone in it only by liking your posts has none (no conversation), so X.
      circle: circleView(req.account, members, { hrefOf: (p) => (p.total > 0 ? `/people/${encodeURIComponent(p.id)}` : p.username ? `https://x.com/${p.username}` : null) }),
      count: members.length,
      from: { full: members.length >= circle.capacityOf(circle.sizeOf(size)) },
      further: { reading, choices, canPick: !!picked, inboxable: !!(req.account.inboxFrom && req.account.inboxFrom.id) },
      funds: await fundsView(req.account), // the choices' top-ups (partials/bulk-option.hbs)
      // THE SIZES as tabs that save (POST /people/circle/size).
      sizes: circle.SIZES.map((s) => ({ key: s.key, on: s.key === size })),
      shared,
      toggle: { action: "/people/circle/share", on: shared, label: "Public page", field: { name: "on", value: shared ? "0" : "1" } },
      publicUrl: `${config.appOrigin}${circleHref(req.account)}`,
      imageHref: kept && circleImageHref(kept, "square"),
      // The closest @handles, at most HANDLES_MAX, for "Copy all N handles" / "Copy the top 50 handles" (to tag them in a
      // post; never all 250, which no post could carry).
      handles: { n: Math.min(handles.length, circle.HANDLES_MAX), top: handles.length > circle.HANDLES_MAX, text: handles.slice(0, circle.HANDLES_MAX).join(" ") },
      imageName: `${req.account.username}-circle.png`,
      // "Post on X": X's compose window with the link alone (the preview shows the circle's picture; no "My circle on X":
      // words of ours are noise in their post; the words are theirs to write).
      postHref: `https://x.com/intent/post?${new URLSearchParams({ url: `${config.appOrigin}${circleHref(req.account)}` })}`,
    });
  });

  // READ FURTHER BACK (services/further.js): one of this account's choices (recomputed here: only its key comes from
  // the form) that its balance covers, once at a time; `inbox=1` moves the Inbox's start back when it's done (only an
  // account whose start is fixed). The worker starts it within seconds; the page shows how far it has got.
  router.post("/people/circle/further", requireAccount, async (req, res) => {
    const sync = (await SyncState.findById(req.account._id, FURTHER_STATE).lean()) || {};
    const choice = (await furtherChoices(req.account, sync)).find((o) => o.key === req.body.key);
    if (req.account.history && req.account.history.further) return res.redirect(303, withNotice(CIRCLE_PAGE, "further-going"));
    if (!choice || !choice.affordable) return res.redirect(303, withNotice(CIRCLE_PAGE, "bulk-short"));
    const inbox = req.body.inbox === "1" && !!(req.account.inboxFrom && req.account.inboxFrom.id);
    const asked = await further.ask(req.account, choice, { inbox });
    res.redirect(303, withNotice(CIRCLE_PAGE, asked ? "further-started" : "further-going"));
  });

  // Sharing on (on=1) or off. On: the members are saved with it, so the public page works at once; off: they're
  // removed and /@<you> shows nothing.
  router.post("/people/circle/share", requireAccount, async (req, res) => {
    const on = req.body.on === "1";
    if (on) {
      if (!isOn(req.account, "people")) return res.redirect(303, CIRCLE_PAGE);
      const ids = (await circleFor(req.account, sizeKeyOf(req.account))).members.map((m) => m.id);
      await Account.updateOne({ _id: req.account._id }, { $set: { "circle.public": true, "circle.ids": ids, "circle.at": new Date() } });
    } else {
      await Account.updateOne({ _id: req.account._id }, { $set: { "circle.public": false }, $unset: { "circle.ids": 1, "circle.at": 1 } });
    }
    res.redirect(303, withNotice(CIRCLE_PAGE, on ? "circle-public" : "circle-private"));
  });

  // THE SIZE (services/circle.js SIZES): kept on the account; a public circle's members and picture follow at once (its
  // ids rewritten and `at` moved, so the share image's address changes and X fetches the new one).
  router.post("/people/circle/size", requireAccount, async (req, res) => {
    const size = circle.SIZES.find((s) => s.key === String(req.body.size));
    if (!size) return res.redirect(303, CIRCLE_PAGE);
    const set = { "circle.size": size.key };
    if (req.account.circle && req.account.circle.public && isOn(req.account, "people")) {
      set["circle.ids"] = (await circleFor(req.account, size.key)).members.map((m) => m.id);
      set["circle.at"] = new Date();
    }
    await Account.updateOne({ _id: req.account._id }, { $set: set });
    res.redirect(303, CIRCLE_PAGE);
  });

  // A PUBLIC circle (/@<username>): anyone, signed in or not. Only an account that turned sharing on and still has
  // People on; anything else is a 404, the same as an account that doesn't exist. Shows the saved members (no ranking
  // here: the sync keeps them), each opening on X; the page's preview on X is the share image below.
  async function publicCircle(username) {
    if (!isHandle(username)) return null;
    const owner = await Account.findOne({ username, "circle.public": true }, "username name image circle features").collation(Account.CIRCLE_COLLATION).lean();
    if (!owner || !isOn(owner, "people") || !owner.circle.ids || !owner.circle.ids.length) return null;
    const profiles = await profilesFor(owner.circle.ids);
    // A PRIVATE account (Person.protected) is left out, here and so in the share images: the ranking comes from posts X
    // showed only to its followers, and this page has no viewer to check them against (accountData.visibleTo is per
    // viewer). Checked on each draw, since an account can go private after the ids were saved.
    const ids = owner.circle.ids.filter((id) => !(profiles.get(id) || {}).protected);
    const members = ids.map((id) => ({ id, username: (profiles.get(id) || {}).username || null, profile: profiles.get(id) || null }));
    return { owner, members };
  }
  router.get("/@:username", async (req, res, next) => {
    const found = await publicCircle(req.params.username);
    if (!found) return next(); // the 404 page
    const { owner, members } = found;
    const handle = `@${owner.username}`;
    res.render("circle-public", {
      wide: true,
      circlePage: true,
      // No "…'s circle" anywhere (noise when the link is posted on X): the tab and the link's
      // card title are just who it is.
      pageTitle: handle,
      meta: {
        title: handle,
        description: `The people closest to ${handle} on X.`,
        image: `${config.appOrigin}${circleImageHref(owner)}`,
        url: `${config.appOrigin}${circleHref(owner)}`,
      },
      owner: { id: owner._id, username: owner.username, profile: { name: owner.name, image: circle.bigImage(owner.image) } },
      circle: circleView(owner, members, { hrefOf: (p) => (p.username ? `https://x.com/${p.username}` : null), external: true }),
    });
  });

  // Its share image (services/circleImage.js), kept in memory per circle version (`circle.at`): X's card fetcher and
  // everyone after it get the same PNG without drawing it again. A new version has a new address (circleImageHref).
  const circlePngs = new Map();
  const CIRCLE_PNGS_MAX = 64;
  // One route per shape (CIRCLE_IMAGE_FILES): the card and the square.
  for (const [shape, file] of Object.entries(CIRCLE_IMAGE_FILES)) {
    router.get(`/@:username/${file}`, async (req, res, next) => {
      const found = await publicCircle(req.params.username);
      if (!found) return next();
      const { owner, members } = found;
      const size = sizeKeyOf(owner);
      const key = `${owner._id}:${shape}:${size}:${new Date(owner.circle.at || 0).getTime()}`;
      let png = circlePngs.get(key);
      if (!png) {
        png = await circlePng({ owner, people: members, size, siteDomain: config.siteDomain, siteX: config.siteX || null, shape });
        if (circlePngs.size >= CIRCLE_PNGS_MAX) circlePngs.delete(circlePngs.keys().next().value); // the oldest
        circlePngs.set(key, png);
      }
      res.set({ "Content-Type": "image/png", "Cache-Control": "public, max-age=3600" });
      res.send(png);
    });
  }

  // The first step of every breadcrumb (partials/crumbs.hbs): the leaderboard's page.
  const HOME_CRUMB = { href: listing.people.path, label: "Your people" };

  // The bird's-eye view: one row per conversation, newest first.
  router.get("/people/:id", requireAccount, async (req, res) => {
    if (!(await readyOrRender(req, res, "people"))) return;
    const { state, person, threads, showFollows } = await loadPerson(req.account._id, String(req.params.id));
    if (!person) return res.status(404).render("leaderboard", { state, rows: [], notFound: true });
    res.render("person", {
      crumbs: [HOME_CRUMB, { label: people.displayNameOf(person), person }],
      bio: bioSegments(person.profile),
      wide: true,
      state,
      person,
      threads,
      showFollows,
      canFollow: active(req.account, "following"), // THE Follow button beside their name
      likes: likeFacts(req.account),
    });
  });

  // One conversation with them, THROUGH THE ENGINE (conversationCard: a post's page and a conversation with
  // one person work as the Inbox does): the Inbox's card, whole. people.threads still finds
  // it (that it's a conversation with them, its first words for the crumbs) and draws it when the engine has no card
  // (nobody but you wrote in it: your replies to them).
  router.get("/people/:id/c/:conv", requireAccount, async (req, res) => {
    if (!(await readyOrRender(req, res, "people"))) return;
    const conv = String(req.params.conv);
    const { state, person, threads, posts } = await loadPerson(req.account._id, String(req.params.id), conv, { canLike: active(req.account, "liking"), canRepost: active(req.account, "reposting"), mediaSaved: savedMediaOf(req.account) });
    if (!person || !threads.length) return res.status(404).render("leaderboard", { state, rows: [], notFound: true });
    const t = threads[0];
    const engine = await conversationCard(req.account, conv, { posts });
    res.render("conversation", {
      state,
      person,
      ...conversationPage(req.account, { engine, alone: t }),
      // …› the person › this conversation, named by its first post (cut short by the bar's CSS).
      crumbs: [HOME_CRUMB, { href: `/people/${encodeURIComponent(person.id)}`, label: people.displayNameOf(person), person }, { label: t.about.gone || !t.about.text ? "Conversation" : t.about.text }],
    });
  });

  // The Follow / Following button beside someone (the Follows page; the Following extra): follow them on X (on=1) or
  // unfollow (on=0). The form says which way, so a double press can't toggle twice; one that matches what's recorded
  // sends nothing. From public/js/post-actions.js (JSON): { ok, following, followsYou, pending, balance } and the row
  // updates in place (its button and its Mutual / Follows you tag). Without script: back to the page, with a toast on
  // failure. One person; a thread's people at once is POST /inbox/follow-all.
  router.post("/people/:id/follow", requireAccount, async (req, res) => {
    const personId = String(req.params.id);
    const json = wantsJson(req);
    const on = req.body.on === "1";
    const back = safeBack(req.body.back, follows.listing.path);
    if (!/^\d+$/.test(personId) || !active(req.account, "following")) return json ? res.status(400).json({ ok: false, ...noticeFor("x-failed") }) : res.redirect(303, back);
    try {
      const r = await setFollow({ ...syncSettings(req.account._id), personId, on });
      if (r === "missing") return json ? res.status(404).json({ ok: false, ...noticeFor("x-failed") }) : res.redirect(303, back);
      if (!json) return res.redirect(303, back);
      // The header's "following" already moved (optimistically, on the press): the press flipped the pair, and a flip moves the count by one and tells every open tab
      // (models/Follow.js fromEvent). The answer carries the counts as they are now, which the page takes over its guess.
      const me = r === "followed" || r === "unfollowed" ? await Account.findById(req.account._id, "followers following countsV").lean() : null;
      const followsYou = !!(await Follow.exists({ _id: `${personId}>${req.account._id}`, follows: true }));
      return res.json({ ok: true, following: r === "followed" || (r === "same" && on), pending: r === "pending", followsYou, balance: await balanceText(req.account), ...(me && { me: Account.meOf(me) }) });
    } catch (err) {
      const why = xFailure(err, `[follow] ${on ? "following" : "unfollowing"} ${personId} for @${req.account.username}`);
      return json ? refusedJson(res, why, err) : res.redirect(303, withNotice(back, why));
    }
  });

  // Re-read one person's profile from X now (the ↻ on a People or Follows card, or beside the name on their page). Only
  // someone already stored (anyone in your data has been looked up once), and not again within 10 minutes of their last
  // read: a double press reads nothing. Without script, back to where it was pressed with a toast; from
  // public/js/post-actions.js, JSON (`read`: X was asked and answered, so the card is worth redrawing; the notice,
  // "Refreshed @maya from X." on success; the header's balance), and the page redraws that card in place.
  const PROFILE_FRESH_MS = 10 * 60 * 1000;
  router.post("/people/:id/refresh", requireAccount, async (req, res) => {
    const json = wantsJson(req);
    const personId = String(req.params.id);
    const back = safeBack(req.body.back, `/people/${encodeURIComponent(personId)}`);
    const known = /^\d+$/.test(personId) && (await Person.findById(personId, "fetchedAt username").lean());
    if (!known) return json ? res.status(404).json({ ok: false, ...noticeFor("x-failed") }) : res.redirect(303, back);
    if (known.fetchedAt && Date.now() - new Date(known.fetchedAt).getTime() < PROFILE_FRESH_MS) return json ? res.json({ ok: true, read: false, ...noticeFor("profile-fresh") }) : res.redirect(303, withNotice(back, "profile-fresh"));
    try {
      const r = await refreshProfile({ ...syncSettings(req.account._id), personId });
      // The toast says whose, beside the card's glow.
      if (json) return res.json({ ok: true, read: true, ...(r.fetched ? noticeFor("profile-refreshed", known.username && `@${known.username}`) : noticeFor("profile-gone")), balance: await balanceText(req.account) });
      res.redirect(303, withNotice(back, r.fetched ? "profile-refreshed" : "profile-gone"));
    } catch (err) {
      const n = xFailure(err, `[profile] refreshing ${personId} for @${req.account.username}`);
      return json ? refusedJson(res, n, err) : res.redirect(303, withNotice(back, n));
    }
  });

  return router;
};
