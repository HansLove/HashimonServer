# HTTP Routes

## Overview

One Express router per resource, mounted in `http/app.ts`. Each route is a thin
adapter: parse with `zod`, call `domain/`, `enrich()` the request's wide event,
respond. See `src/http/CLAUDE.md` for the wide-event pipeline, `requireSession`,
and the Luanti-bridge / emission / share error-mapping details — not repeated here.

## Key Files

- **payments-webhook.ts** — separate router mounted *before* `express.json()` in
  `app.ts`; BTCPay HMAC is computed over raw bytes, so a parsed body breaks every
  signature. Mount order is load-bearing, not a style choice.
- **payments.ts** — the client-facing BTCPay Server credit-purchase flow (catalogue,
  create/poll/cancel invoice). Business rules live in `domain/payments.ts`; this
  file is presentation + one gateway-error-to-HTTP mapping.

## Business Logic

**Payment lifecycle is one-active-charge-per-player.** `createPayment` throws
`AppError` with code `payment_pending` when a player already has a charge in
flight; `payments.ts::POST /payments/btcpay-server/invoice` catches specifically
that code and turns it into a 409 that carries the *existing* live payment back in
the body, so the client can offer "resume or discard" without a second round trip.
Any other error from `createPayment` rethrows as-is (not swallowed into the 409).

**`GET /payments/btcpay-server/active` returns 204, not `{payment: null}`** — "no
charge in flight" is modeled as absence of a resource, not a null field.

**The address and the BTC amount never reach the wide event at all.**
`enrichPayment()` in `payments.ts` carries order id, status, sku, credits and the USD
amount, and deliberately omits `address` and `amount_btc` — together they name one
specific on-chain payment in a log line, the same reasoning as `dna_prefix` over
`dna` elsewhere. `payment_order_id` is the support handle, and it is enough.

**The webhook has no session — the HMAC is the auth.** `payments-webhook.ts` sets
`auth_source: "btcpay-hmac"` instead of going through `requireSession`; a bad
signature (`BTCPayWebhookSignatureError`) is mapped to 401 via a dedicated
`webhookError` handler so BTCPay sees "rejected" rather than 500 and stops retrying
a delivery that can never be accepted. All seven event types — including the two that
transition nothing (`onCreated`, `onPaymentSettled`) — route through the same
`apply()` → `domain::applyWebhook`, which owns the state-transition mapping; routing
even the no-ops through it keeps them on the wide event instead of dropping silently.

**Wallet custody transition is one-way.** `wallet.ts::POST
/wallet/claim-self-custody` drops the server-held encrypted private key
irreversibly; `custody_before`/`custody_after` are always enriched (even on the
happy path) because the transition has no undo and must leave a trace regardless.

**`canOwn` (needs a `public_key`) gates three unrelated things** across these
files: emitting a Hashimon (`hashimons.ts`), claiming self-custody (`wallet.ts`),
and binding a Luanti session (`internal.ts`). All three throw the same 403
`cannot_own` — a keyless player (anonymous `/session` or Luanti guest) cannot do
any of them.

## Dependencies

**External:**
- `@taloon/btcpay-middleware` (`BTCPayMiddleware`) — owns webhook signature
  verification and BTCPay Server API calls; configured once in
  `payments-webhook.ts` from `config`, but only `webhookSecret` is actually
  exercised there — `domain/payments.ts` builds its own client for outbound calls.
