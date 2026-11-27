# Billing: a prepaid balance, X's cost × 1.5

**Status: LIVE on xtoolio.com** (the go-live list below is done: the site's own Stripe account, live
keys, the webhook, `CONTACT_X`, `METERED_BILLING_ENABLED=true`; a real top-up credited exactly once). Off
(`METERED_BILLING_ENABLED=false`, the default) every charge is still written, as a shadow bill, and nothing gates. The code (`services/balance.js`, `services/billing.js`) is the working reference; this
is the design and the reasons behind it.

A self-hosted copy normally leaves billing off: you pay X yourself, and the app owner (`X_APP_OWNER_ID`) is never charged.

## Go-live (done; kept as the list for another deployment)

1. **Stripe:** the operator's own Stripe account, with its public business name, support details and branding filled in
   (invoices show them), and Stripe's receipt emails ON (the app sends none). Test keys into `.env`, then
   `stripe listen --forward-to 127.0.0.1:3100/stripe/webhook` for the local webhook secret, and one real test-mode
   top-up, card save and refill end to end.
2. **Deploy** (HTTPS `APP_ORIGIN`): the live webhook endpoint `APP_ORIGIN/stripe/webhook` with events
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `invoice.paid`, `charge.dispute.created`
   (a chargeback takes the disputed amount off the balance and switches auto-refill off: billing.js handleDispute; a
   dispute won is credited back by hand); live keys.
3. **`CONTACT_X`**: the X handle people DM about their account (the Terms and Privacy say "send a DM to @handle on X";
   without it, "reach us on X"), and a read of both pages.
4. **`METERED_BILLING_ENABLED=true`.** Existing non-owner accounts start at $0, so they pause until they top up:
   tell them first.

## The model

Each account prepays a balance through Stripe. Every unit of X work done for it (a sync, a like, a reply, an hour of
live events) is charged to that balance when it closes, at **X's cost × the multiplier** (×1.5 by default,
`MARGIN_MARKUP_PCT`; one account can have its own lower one, a discount never above the platform rate, `npm run
margin`), the full rate **per account per
calendar month (UTC) until the markup reaches** `MARKUP_CAP_USD` ($50 by default), then `MARKUP_AFTER_CAP_PCT`
(15%; it used to be 10%, judged too low) until the month turns (a flat $50 cap lost money to card processing on big
top-ups: Stripe's ~3% is on the whole top-up, X's part included). Onboarding (reading your history, and the look back
through your likes) has its own markup, `BULK_MARKUP_PCT`, 15% too, outside the threshold's count: the lowest markup
anywhere, and the ONLY bulk operation at that rate (the whole follower list and the accounts you follow once had it too, and bulk likes, follows
and unfollows were always charged per press at the usual rate);
`Account.markupMonth` / `markupMicros`, moved in the charge's own atomic write, guarded against concurrent charges;
`BalanceEntry.markupUsd` per charge). When the balance runs out, its syncing
pauses until it's topped up. Optional auto-refill charges a saved card when the balance runs low. No subscription.

## Decisions, and why

1. **The tenant is the `Account`** (one X user): `balanceMicros`, `stripeCustomerId`, `autoRefill`, `marginMultiplier`.
2. **Micro-dollars, not cents.** A typical sync costs X between nothing and a few cents; whole-cent rounding would
   bill most units $0. Balance and ledger are integer micro-USD ($1 = 1,000,000); pages round for display.
3. **A unit is charged at X's prices, exactly.** `estUsd` (a legacy name: X's published price on everything X returned
   to the unit and every write it made, minus what X had already billed that UTC day) × the markup. Not a guess: a
   count of X's own answers, priced from X's list, so a charge can be checked by hand against the price list the front
   page and the Terms quote. X gives no per-user bill (the app has ONE credit balance), so this is each user's usage.
   *Why not each unit's exact cost:* that needs X's balance read before and after every unit (two calls each, ~60,000
   a day at 100 accounts), and with five syncs running at once almost every unit overlaps another, so the exact
   figure is rarely there (tried, and dropped). X's REAL spend is still read once a minute
   (`services/balanceClock.js`) and shown to the operator per day beside the price-list total.
   *No calibration* (deleted: a charge must be exact, never "roughly"): a charge used to be also
   × (X's real spend over 7 days ÷ every unit's amount, clamped [0.5, 1.2]), which tracked X's bill on average but
   made a charge impossible to check against the published price. Drift between X's bill and its own list (measured
   ~5% the other way, the list running high) is the operator's to absorb or keep; the markup dwarfs it.
4. **One charge site, exactly once.** `services/usage.js metered()` charges the unit after closing it. Each movement
   has a key (`run:<UsageEntry id>`, `topup:<invoice id>`) and two guards: for good, its `BalanceEntry` row (unique on
   kind + ref, never trimmed, written once the money moved: a key with a row never moves money again); in flight,
   `Account.appliedRefs` (the last 500 keys: absent in the update's filter and pushed with the `$inc`, one atomic
   write), which covers writers racing before the row exists and a crash between the money and its row. A retry, a
   second process, a redelivered webhook or a replayed Stripe return link moves nothing twice. (The
   list used to be the only guard, and a top-up's key left it after 500 charges, so replaying its return link credited it
   again.) **An invoice older than its account credits nothing** (`settleTopupInvoice`, 10 minutes' clock slack): an
   account deleted and made again has the same id (the X id), and its old sessions would otherwise credit the new one.
   A sign-in (no account yet) is never charged.
5. **The owner is exempt.** The app owner pays X directly: no balance, no gate. Their Usage page shows X's real spend
   and the margin (what accounts were charged against X's cost).
6. **Shared posts and profiles are fine.** Posts and profiles are stored once for everyone. X bills whoever reads a
   resource first in a UTC day; a later reader's unit costs less. Each account pays for what its own units cost.
7. **The gate is one check inside `metered()`**, before the ledger row and the first read: an account out of runway
   (balance ≤ `METERED_FLOOR_CENTS`; never the owner, never with billing off) starts nothing, through any door. Work
   whose price is known before it starts (the first history read) also needs the balance to cover the marked-up quote
   (`billing.affords`). And no unit is charged past the balance (THE CEILING): each starts with what the
   balance covers at its rate, stops reading there (lib/x.js), and is charged that at most (`balance.capped`, basis
   "balance"). A quote is an estimate; the ceiling is what makes "your balance covers it" certain. (Without it a running
   unit could overshoot by a whole unit, and a history read is one big unit.)
8. **The deposit is the first top-up.** A new account starts at $0, which the gate already treats as out of runway
   (no separate "deposit due" flag). The "how far back?" page shows each history option's price and, beside any the
   balance doesn't cover, the one top-up that covers it (at least `DEPOSIT_USD` for a first payment).
9. **Checkout is reached by a LINK** (`GET /billing/topup?amount=`), never a form: the CSP's `form-action 'self'` would
   block a form whose redirect ends on Stripe. Only amounts the page offered are accepted, rate-limited per account.
10. **ONE credit path.** Every top-up ends as a paid Stripe invoice carrying `kind: "xtoolio-topup"` and
    `app: "xtoolio"`; `settleTopupInvoice` credits its pre-tax subtotal, keyed by the invoice id. It's reached from the
    return page (the person is waiting) and the webhook (`invoice.paid`, `checkout.session.completed`); whichever lands
    first credits, the rest find it applied. Events of any other kind are ignored without a Stripe call. The webhook is
    mounted before the body parsers and CSRF (raw body for the signature): 400 on a bad signature, 500 on a handler
    error so Stripe retries.
11. **Auto-refill** (opt-in, `services/autoRefill.js`): woken after every charge that moved money and whenever the gate
    refuses an account. At or under the threshold, with a saved card: an atomic claim (one in flight, 1 h cooldown),
    an off-session invoice (voided on any failure), credited through the one path. Two failures in a row switch it
    off, with the cause in plain words. The card is saved through a setup-mode Checkout, also by link.
12. **Telling people** (the app sends no email): a header banner while it matters (paused, low with refill off, refill
    failed). A paying account's Usage page is its statement: each charge with what it read, each top-up with its
    receipt, the balance after. It never shows X's cost (that would show the markup).
13. **Terms follow the code.** Prepaid, non-refundable, pauses at zero; the numbers on the Terms come from config, and
    verify-security checks the rendered page carries them. "Prepaid and non-refundable" sits beside every top-up link but Settings' Balance row.

## Not in scope

**Refunds and disputes are by hand, one by one, by decision** (never automatic, each granted by the
operator). Nothing acts on Stripe's refund or dispute events, so a refunded or disputed payment keeps its credit until the
operator takes it back: grant the refund in Stripe, then `npm run credit -- <username> -<usd> "note"` (a "refund" row
on the statement, exactly once per account, day and amount; the balance may go below zero, which pauses syncing). A
dispute is answered in Stripe, and taken back the same way if lost.

Subscriptions, automatic refunds, credit codes, sales tax (Stripe Tax: on once there's a registration). (Deleting an
account, self-serve in Settings, deletes its Stripe customer too: services/deleteAccount.js.)
