# Waitlist DMs: telling each person "you're in" from the site's X account

Status: BUILT (services/waitlistDms.js is the reference). SUPERSEDED on numbers and batches: there are none any more.
An admin grants people one at a time (Admin → Waitlist → Grant), each grant queues that person's one DM ("You're in on
<brand> 🎉 Sign in at <site> to get started.", no place number), and the worker checks by itself who follows the site's
account. Below, read "Let in N" / "a place opens" as a Grant. Refused DMs get an Admin "Send again" (they may follow
the account later); the waitlist page has a Follow button for the site's account. Still to read: the console's price
for a send. When this was designed, a batch was announced by a public post (Admin → Waitlist → "Post on X",
by number), and people came back to `/waitlist` to see their place. This adds a direct message to each person when
their place opens, sent from the site's own X account (`SITE_X`), from the Admin page.

## Three things to check first (a spike, a few cents)

1. **Is sending a DM available on pay-per-use, and what does it cost?** X's docs list the endpoint
   (`POST /2/dm_conversations/with/:participant_id/messages`) and its limits, but the per-call price is only in the
   developer console (an early price list said $0.01 a DM). Read it in the console; then send one and read the balance.
2. **Does the app's permission allow it?** The X app must be set to "Read and write and Direct message" in the
   console. Check that changing it doesn't disturb existing customers' grants (they keep the scopes they granted; only
   the sender signs in with `dm.write`).
3. **Does a DM sent through the API reach the person, and when is it refused?** X lets an account DM someone who
   follows it, or who accepts messages from anyone; anything else should be refused with a reason. Send one to a test
   account that follows the site's account and one that doesn't, and record X's exact answer for each (the "can't be
   delivered" case is what the Admin panel will show). Also confirm the message shows in the recipient's inbox in X's
   current app (X has been moving DMs to its newer Chat; API messages should still arrive, unverified).

If 1 or 3 comes back "no" or "too expensive", stop: the public post stays the only announcement, and this doc records
why.

### Spike, part 1: what X's docs say

- **The send**: `POST /2/dm_conversations/with/:participant_id/messages`, body `{ text }` (or `attachments`, one
  media id), answer 201 `{ data: { dm_conversation_id, dm_event_id } }`. User token only ("App-Only authentication is
  not supported"). Scopes: the API reference lists `tweet.read users.read dm.write`; the integration guide adds
  `dm.read` "required with dm.write". They disagree: the live send settles it (ask without `dm.read` first).
  (docs.x.com/x-api/direct-messages/create-dm-message-by-participant-id, …/direct-messages/manage/integrate)
- **Price**: the pay-per-use list has "DM Interaction: Create, $0.015 per request" (no "DM Event: Create" row), so
  INFERRED $0.015 a DM, the price of a like or a reply; 1,000 DMs ≈ $15. Not stated which row this endpoint bills as:
  read the console's usage after the live send. (docs.x.com/x-api/getting-started/pricing)
- **Limits**: per user 15 / 15 min and 1,440 / 24 h; the table also gives a per-app 1,440 / 24 h, unexplained (DMs
  can't use an app token). So one sender lets in at most ~60 people an hour, 1,440 a day.
- **Refusals**: the reference names the reasons as problem types, no titles or statuses documented:
  `dm-recipient-not-accepting`, `recipient-not-messageable`, `dm-recipient-cannot-receive`, `dm-recipient-blocks-sender`,
  `dm-not-delivered`, `dm-safety-limited` / `-rejected`, `dm-duplicate`, `dm-rate-limited`, and X Chat ones
  (`encryption-required`, `recipient-xchat-setup-required`, `unencrypted-send-not-allowed`, `dm-sender-not-verified`,
  `dm-sender-phone-required`, …). Which one "doesn't follow the sender" gets is NOT documented: the live send to a
  non-follower settles it. The X Chat types say API DMs CAN be refused for encryption reasons; whether they show in the
  recipient's inbox isn't said anywhere.
- **Permission**: the app's permission ("Read, write, and DMs") gates DMs; the docs say re-authorizing is needed after a
  change only for OAuth 1.0a tokens, nothing for OAuth 2.0 (which xtoolio uses). Existing grants should keep their
  scopes (we never ask for a DM scope), UNVERIFIED: a read-only health check of production before and after the change
  shows whether accounts keep syncing.

So 1 is answered "yes, about 1.5¢" pending the console. 2 and 3 need the live half.

### Spike, part 2: the live send (needs the operator)

A one-off script that talks to X directly, so it can print X's raw answers:

1. X console → the app → User authentication settings → permission "Read and write and Direct message". Save.
2. A health check: existing accounts still syncing, none needing re-sign-in (check again after an hour).
3. Sign in as `SITE_X` (the script refuses any other account) to get a sender token with `dm.write`.
4. Send to a handle that follows @xtoolio and one that doesn't: print each one's connection to @xtoolio, X's status
   and body, and the 15-minute / 24-hour headers. Then: did each DM show up in X's app (inbox or message requests)?
   And the console's usage row and price for it.
5. If the send is refused for scope, sign in again asking `dm.read` too and send again. Delete the token file after.

### Spike, part 2: what happened

- **Permission**: the app's permission was raised to "Read and write and Direct message". Production kept syncing
  after it (ok syncs right after the change, no account asked to sign in again). @xtoolio's consent screen read "Send and
  manage Direct and Chat messages … you may need to share your private pin" (X's Chat folded into the same scope; the
  send never asked for a pin).
- **Scope**: X granted `dm.write users.read tweet.read offline.access`, and the send worked WITHOUT `dm.read`.
- **A mutual follower** (connection `followed_by, following`): 201, `{ dm_conversation_id, dm_event_id }`.
- **No connection either way, DMs not open**: 403, type `https://api.x.com/2/problems/dm-recipient-not-accepting`,
  title "Forbidden", detail "You do not have permission to DM one or more participants." A clean, typed refusal: the
  Admin list can show it as "doesn't accept DMs from @xtoolio" (and the advice: follow it).
- **Limits, from X's headers**: the 15-minute window is **99** (the docs say 15), the day **1,440**. A REFUSED send
  uses a slot in both. So one sender reaches ~400 people an hour, 1,440 a day; the queue paces by the headers anyway.
- NOT tested: someone who follows @xtoolio that @xtoolio doesn't follow back (the usual waitlister). X's rule says a
  follower can be messaged; the build's first real batch shows it.
- **It arrives**: the mutual's X app showed it at once in its main Chat list (not message requests), from "xtoolio.com"
  with the account's badge, marked "Unencrypted". API DMs still reach X's newer Chat.
- STILL OPEN: the console's usage row and price for the send (and whether the refused one bills).

**Verdict: build it.** Sending works on pay-per-use, lands in the person's Chat, and an undeliverable one comes back
as a typed refusal the Admin page can list. The one dependency is the person following @xtoolio, which the waitlist
page already asks for (and which grows the site's own account).

## The design

**As built: the sender is the site's own account, on its one grant.** This replaced the separate sender grant planned
below. X keeps one grant per person per app, a new sign-in replacing the last, so the sender's grant was replaced the
next time the site's account signed in to the site as an account, and stopped sending. Now that account's sign-in asks
for a customer's scopes plus `dm.write` (`features.SCOPES_SITE`; routes/auth.js sends a sign-in of it that lacks
`dm.write` back to X once, since who is signing in isn't known until X answers), and the worker sends with that
account's own token. Nothing to connect or disconnect: Admin → Waitlist says whether DMs are on and, if not, why. The
code (services/waitlistDms.js, routes/auth.js) is the reference.

**As built: no numbered places.** An admin lets people in one at a time (Admin → Waitlist → Grant, or Invite by
@handle), and each Grant queues that person's one DM (`models/WaitlistDm.js`, one per person ever), which the worker
sends under X's own rate-limit headers, each batch a metered unit. The text is one function, `textParts()`, which the
waitlist page's picture of it (`partials/dm-preview.hbs`) draws too.
