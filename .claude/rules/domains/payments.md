---
paths:
  - "src/modules/payments/**"
  - "src/modules/affiliate/**"
  - "src/modules/companion/domain/chat.ts"
  - "src/modules/core/db/schema.sql"
---

# Credit purchases

**Never hand-roll any of this.** Crypto goes through BTCPay via
`@taloon/btcpay-middleware` (which owns the HMAC verification); fiat, if it ever happens,
goes through a Stripe-class provider. Never verify a signature, compute a rate, or
reconcile a payment by hand here. **A shortfall inside `BTCPAY_PAYMENT_TOLERANCE`
(default 3%) is BTCPay's decision, not ours**: `createPayment` sends it as
`checkout.paymentTolerance` and an invoice within it settles like any other, so
`settleAndCredit` never learns a payment was short — the alternative, comparing paid
against invoiced here, is exactly the hand-reconciliation this forbids. An underpayment
*past* the tolerance surfaces as `InvoiceExpired` with `partiallyPaid: true` (or
`InvoiceInvalid`, depending on when the shortfall is noticed), so the charge lands in
`expired` or `failed` and the player goes to support. The **only** signal support gets
that coins actually arrived is `payment_partially_paid` / `payment_over_paid` on the wide
event — nothing is stored on the row.

**Credit purchases (`src/modules/payments/domain/payments.ts`, `credits_plans` + `payments` tables).**
The only path by which credits enter from outside. Exactly four places move
`players.credits`: this settle (credit), the pack bonus
(`payments/domain/pack-bonus.ts::resolveBonus` credit), incubation (`createLot` debit,
`closeLotById` refund) and companion chat (`companion/domain/chat.ts::speak` debit, which
writes no `audit()` row).

**Pack bonus (`payments/domain/pack-bonus.ts`, `pack_bonuses`; docs/BONO_VERIFICABLE_V1.md).**
The extra on top of a pack's floor. The floor is still the plan's credits, granted by
`settleAndCredit` as always; the bonus can only ADD, never retains or subtracts the floor.
`settleAndCredit` only inserts a `pending` row in its own transaction (no network, cannot
fail by logic: order_id PK + the rules version published in the same transaction). The
bonus is decided by the hash of a Bitcoin block that did not exist when its height was
fixed: `commitBonus` sets `target_height = commitTip + 1` once (`WHERE status = 'pending'`),
`resolveBonus` credits once after 3 confirmations (`WHERE status = 'committed' RETURNING`).
The network read happens OUTSIDE the transaction. Nothing advances on the webhook: reading
`GET /payments/bonuses` advances it (no cron, same as incubation) — committing later gives no
one an edge, it just targets another unknown block. `block-oracle.ts`: two public Esplora
explorers are REQUIRED and must agree; the node (`BTC_NODE_CONNECTION_URL`) is optional —
it blocks if it answers a different hash, it never blocks by being down. A +0 % roll is
still resolved and audited. Never make the bonus a reason the floor waits. A request carries a **`sku`, never
an amount** — `planFor()` reads the price, and the zod schema in
`payments/http/routes/payments.ts` is `.strict()` so a smuggled `amount`/`price` is a 400 rather
than a field quietly ignored. `payments` snapshots `sku`/`credits`/`amount_usd` at
creation: repricing a plan must never revalue a charge already issued, so the FK to
`credits_plans` is referential integrity and nothing more.

Six statuses, all server-decided — `waiting → confirming → settled | expired | failed |
cancelled`, the last four terminal. **The client runs no state machine**; its UI phase
*is* this column. Two guarantees are SQL, not `if`s: `payments_active_per_player_idx`
(unique partial index over the live statuses) makes a second concurrent charge a `23505`,
which the route turns into 409 `payment_pending` *with the live charge in the body*; and
`applyWebhook`'s `UPDATE … WHERE status <> 'settled' RETURNING *` is what makes crediting
once-only — BTCPay redelivers (`isRedelivery`), so a repeat is the normal case, and the
credit, `audit()` and the affiliate commission (`affiliate/domain/affiliates.ts::accrueCommission`,
a no-op for an unreferred player) ride in one `withTransaction`. Same conditional-transition
shape as `claimSelfCustody`.

**Cancel is `waiting`-only, and settling ignores cancel.** `cancelPayment` refuses a
`confirming` charge with 409 `payment_in_flight` — coins are already on the wire, so
cancelling is a mistake every time. But `settleAndCredit` guards on `status <> 'settled'`,
deliberately *not* on "not terminal": a charge the player cancelled, or that BTCPay let
expire, still credits if the money lands. Never make bookkeeping the reason a real payment
goes uncredited — `payments.test.ts` pins both halves.

**The write order in `createPayment` is load-bearing.** Ledger row first (so the index
rejects a duplicate before an invoice exists), then `invoice_id` in its own UPDATE
*immediately* — it is the only handle `applyWebhook` has on the row, and the invoice is
payable the moment BTCPay returns it. Only a charge with no invoice behind it is ever written
off as `failed`. A later `getPaymentMethods` failure is survivable, not fatal: the charge
keeps `checkout_link` (BTCPay's hosted page) and loses only the QR. Hence the nullable
`invoice_id`/`address`/`amount_btc`/`bip21`/`checkout_link`.

**`expireStaleCharges` touches `waiting` only, never `confirming`** (and runs on
`activePaymentFor` too, so a dead charge is never offered back to resume). BTCPay keeps
watching a confirming invoice past `expirationTime` (`monitoringMinutes`); expiring one would
free the index, open a second invoice, and leave the player with two payable addresses for
one plan — the transition `cancelPayment` refuses with 409 `payment_in_flight`.

**An empty `BTCPAY_WEBHOOK_SECRET` would be an anonymous credit-minting endpoint**: the
library verifies the HMAC only `if (config.webhookSecret)`, and nothing else fails when the
variable is missing. `requireWebhookSecret` answers 503 before the middleware is reached.
Confirmed both ways — without the guard an unsigned POST minted 3000 credits.

**The webhook router is mounted before `express.json()`** (`core/http/app.ts`) and it is the
only one that is: the HMAC covers the raw bytes. Reverse those two lines and every
delivery fails with an opaque 401. `payments-webhook.ts` maps
`BTCPayWebhookSignatureError` to 401 on purpose — as an unknown error it would surface as
a 500, which tells BTCPay to keep retrying a delivery that can never be accepted.
`payments/domain/payments.ts` builds its own `BTCPayClient` lazily (not at import: `migrate.ts` and
the test suites load domain code with no gateway configured).

**Three gaps are recorded, not closed** — see *Known gaps in the payment flow* in
README.md: no reconciliation sweeper against BTCPay, cancel does not archive the gateway
invoice, and buying is gated by `requireSession` alone rather than `canOwn`.
