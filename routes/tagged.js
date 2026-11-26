// routes/tagged.js — FOLLOWS → WHO THEY TAG (/follows/tags; services/tagged.js): type a handle, read their recent posts
// (one priced press), see who they @-tag most, pick and follow them in bulk (THE BULK FOLLOW, routes/pages.js
// followMany: X's 50 per 15 minutes and 400 a day). The Follows module's page, so it's drawn under the Follows head.
// Mounted by web.js beside the other Follows pages.
"use strict";

const express = require("express");
const Follow = require("../models/Follow");
const tagged = require("../services/tagged");
const { handleOf } = require("../lib/handle");
const { syncSettings } = require("../services/accounts");
const { profilesFor } = require("../services/accountData");
const { active } = require("../services/features");
const { writesLeft } = require("../services/extras");
const { FOLLOW_ALL_MAX } = require("../services/conversations");
const { requireAccount, withNotice, readyOrRender, fundsView, tagsChoices, followMany, xFailure, pageSwitch } = require("./pages");

module.exports = function taggedRoutes({ followsHead }) {
  const router = express.Router();
  const L = tagged.listing;
  // The page for a handle (or the empty page), its list's defaults kept out of the address.
  const pageFor = (handle) => L.hrefFor(L.parseQuery({ handle: handle || "" }), { page: 1 });

  // Where this account stands with `ids`: who it follows, who follows it (the stored pairs, an explicit true only).
  async function pairsFor(aid, ids) {
    const [mine, theirs] = await Promise.all([Follow.find({ followerId: aid, followeeId: { $in: ids } }, "followeeId follows").lean(), Follow.find({ followeeId: aid, followerId: { $in: ids } }, "followerId follows").lean()]);
    return { youFollow: new Map(mine.map((f) => [f.followeeId, f.follows])), followsYou: new Map(theirs.map((f) => [f.followerId, f.follows])) };
  }

  router.get(L.path, async (req, res) => {
    const state = await readyOrRender(req, res, "follows");
    if (!state) return;
    const aid = req.account._id;
    const handle = handleOf(req.query.handle);
    const query = { ...L.parseQuery(req.query), handle: handle || "" };
    const [read, reads, [choice]] = await Promise.all([handle ? tagged.readOf(aid, handle) : null, tagged.readsOf(aid), tagsChoices(req.account)]);
    let list = null;
    if (read) {
      const ids = (read.people || []).map((p) => p.id);
      const [profiles, pairs] = await Promise.all([profilesFor(ids), pairsFor(aid, ids)]);
      list = L.listRows(tagged.rowsOf(read, { profiles, ...pairs, meId: aid }), query);
    }
    const canFollow = active(req.account, "following");
    res.render("follows-tags", {
      state,
      wide: true,
      head: followsHead({ current: "tags" }),
      headSwitch: pageSwitch(req.account, "follows"),
      handle,
      read,
      readPerson: read && { id: read.userId, username: read.handle, profile: { name: read.name, image: read.image } },
      reads: reads.filter((r) => !handle || r.handle.toLowerCase() !== handle.toLowerCase()).map((r) => ({ ...r, href: pageFor(r.handle) })),
      choice,
      readPosts: tagged.READ_POSTS,
      funds: await fundsView(req.account),
      list,
      pager: list && L.pager(list),
      sorts: [["tagged", "Most tagged"], ["followers", "Most followers"]].map(([key, label]) => ({ key, label, selected: list && key === list.sort })),
      keep: list ? L.keep(list) : [],
      reverseHref: list && L.sortHref(list, list.sort),
      whoAll: list && list.who === "all",
      whoHref: list && L.hrefFor(list, { who: list.who === "all" ? "new" : "all", page: 1 }),
      canFollow,
      picking: canFollow,
      pickForm: "follow-many",
      pickVerb: "follow",
      followMax: FOLLOW_ALL_MAX,
      followLeft: canFollow ? await writesLeft(aid, "follow").then((a) => (a.left < a.afterReset ? a.left : null)) : null,
    });
  });

  // THE READ (services/tagged.js readTags): priced on the page, refused when the balance doesn't cover the quote, then
  // back to the handle's page with what it found.
  router.post(`${L.path}/read`, requireAccount, async (req, res) => {
    const handle = handleOf(req.body.handle);
    if (!active(req.account, "follows")) return res.redirect(303, L.path);
    if (!handle) return res.redirect(303, withNotice(L.path, "tags-handle"));
    const back = pageFor(handle);
    const [choice] = await tagsChoices(req.account);
    if (!choice.affordable) return res.redirect(303, withNotice(back, "bulk-short"));
    try {
      const s = syncSettings(req.account._id);
      const out = await tagged.readTags({ accountId: req.account._id, handle, getToken: s.getToken, ownerId: s.ownerId, billing: s.billing });
      if (out.error) return res.redirect(303, withNotice(L.path, "tags-unknown"));
      res.redirect(303, pageFor(out.read.handle));
    } catch (err) {
      res.redirect(303, withNotice(back, xFailure(err, `[tags] @${handle} for @${req.account.username}`)));
    }
  });

  // THE BULK FOLLOW of the picked people: only people this account's read of that handle found, and not followed
  // already (the form names ids, the route keeps only those), through followMany (X's window, FOLLOW_ALL_MAX, one
  // ledger row). Back to the page with the toast; the followed ones leave its default view (people you don't follow).
  router.post(`${L.path}/follow`, requireAccount, async (req, res) => {
    const aid = req.account._id;
    const handle = handleOf(req.body.handle);
    const back = pageFor(handle);
    if (!handle || !active(req.account, "following")) return res.redirect(303, back);
    const read = await tagged.readOf(aid, handle);
    const found = new Set(((read && read.people) || []).map((p) => p.id));
    const asked = [...new Set([].concat(req.body.ids || []).map(String))].filter((id) => found.has(id) && id !== aid);
    if (!asked.length) return res.redirect(303, withNotice(back, "tags-pick"));
    const { youFollow } = await pairsFor(aid, asked);
    const { n } = await followMany(req.account, asked.filter((id) => youFollow.get(id) !== true));
    res.redirect(303, withNotice(back, n));
  });

  return router;
};
