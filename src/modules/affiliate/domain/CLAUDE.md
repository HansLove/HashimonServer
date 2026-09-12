# Affiliate Domain

## Overview

Two-level introducing-broker referral system: root affiliates earn a `rate_bps`
cut of purchases they refer, and can recruit sub-affiliates by ceding part of
that rate. Called from `payments` (to accrue), `players` (to resolve a
signup's referral code), the portal router (`affiliate/http/routes/affiliate.ts`)
and the operator CLI (`scripts/affiliates.mts`) — this module never triggers a
payment itself; payouts are manual transfers it only records.

## Entry Points

- `affiliates::accrueCommission` — called inside `payments::settleAndCredit`'s
  own transaction; writes 0-2 commission rows for a settled payment.
- `affiliates::resolveAffiliateCode` — canonicalizes a `?ref=` code at signup;
  never throws, bad/inactive codes silently resolve to `null`.
- `affiliates::createSubAffiliate` — root-only recruitment, enforces the
  two-level depth limit and rate ceiling.
- `affiliates::affiliateSummary` / `subAffiliatesOf` / `referralsOf` /
  `commissionsOf` — portal read views, one query block each.
- `affiliates::pendingPayouts` / `markPaid` — the manual weekly payout cut.

## Business Logic

- **Two-level tree, enforced not just by convention.** `createSubAffiliate`
  rejects recruiting unless `can_recruit` AND the caller has no `parent_code`
  itself — a sub cannot recruit, because its override would have to come out
  of its parent's own override and the math turns recursive.
- **Ceding the entire rate to a sub is legal**, leaving the parent at 0% on
  that referral; it's a business decision, not an error. What the code does
  guard is writing a zero-amount override row (`parent_rate - direct_rate > 0`
  check in `accrueCommission`'s SQL).
- **A deactivated parent doesn't cost the sub its override** — the sub's deal
  is with the house, not the parent. `accrueCommission`'s `LEFT JOIN parent ...
  AND parent.active` just drops the parent's row; the sub's own row is
  unaffected.
- **Self-referral guard**: a payment is never commissioned if the direct
  affiliate's `player_id` equals the buyer — otherwise an affiliate could
  self-refer for a permanent house-funded discount.
- **`rate_bps` is frozen onto each commission row at accrual time**, not
  looked up live — changing an affiliate's rate later never revalues what was
  already earned (same pattern as `payments` freezing `sku`/`amount_usd`).
- **Codes are case-insensitive but stored with original casing.**
  `resolveAffiliateCode` and every lookup query `lower(code) = lower($1)`, but
  return/store the canonical casing, so `?ref=daniel` and `?ref=DANIEL` land
  in the same row and the weekly cut doesn't split across two lines.
- **`accrueCommission` cannot fail on business logic** — no referral, inactive
  affiliate, self-referral, or a redelivered webhook all resolve to "insert
  zero rows," never a thrown error, because it runs inside
  `payments::settleAndCredit`'s transaction and must never block crediting the
  buyer.
- Idempotency is `ON CONFLICT (order_id, code) DO NOTHING` — a redelivered
  BTCPay webhook (the normal case, not an edge case) accrues nothing on the
  second pass.
- **Root affiliates only come from the CLI.** `pnpm affiliates alta` inserts a
  root and `ligar` binds it to a player account, which is what opens the portal:
  the router's `requireAffiliate` answers 403 `not_an_affiliate` for a session
  whose player has no `affiliates` row. The portal itself can only create subs.
- **Attribution is written once, on a fresh `/register` only.** The one writer of
  `players.referred_by` is `players::registerOwner`'s INSERT. A Luanti guest who
  claims ownership through that same `/register` (`claimLuantiGuest`'s UPDATE) and
  an anonymous `/session` player are never attributed, and nothing sets the column
  later.
- `markPaid` guards on `status = 'accrued'`; running it twice with the same
  txid is a no-op the second time (0 rows affected), not a duplicate payout.
  But it marks *every* accrued row of the code, not the ones `pendingPayouts`
  listed: `corte` and `pagado` are two separate CLI runs, so a commission accrued
  between them is recorded as paid under a txid whose transfer did not include
  it. The count and total `pagado` prints are the only sign.
- `referralsOf` deliberately drops identity — portal shows `"Cliente " +
  uuid.slice(0,4)`, never a username or email, because an affiliate is not
  meant to see who their referrals are. It does include `hashimon`
  (`"Guardian Air"`) from `birth_spirit` + `genesis_element`: the kind is
  not identifying, and it is what the affiliate talks about.

## Dependencies

**Internal:**
- `core/db/pool` — raw SQL throughout; no ORM, the queries themselves encode
  the business rules (see the `WITH ctx AS (...)` in `accrueCommission`).
- `core/http/wide-event` — `enrich()` only fires when a commission was
  actually written, so ordinary no-referral purchases don't pollute the event.

## Side Effects & Constraints

- `accrueCommission` must be called with the **same transaction client**
  (`Sql`) as the payment settlement — it is not safe to call standalone
  outside that transaction, since its guarantees depend on commissions and
  credits committing or rolling back together.
- Commission amounts come from `payments.amount_usd` read inside the same
  query, never from a caller-supplied argument — what's commissioned is what's
  in the ledger, not what a caller happens to pass.
- `createSubAffiliate` relies on the unique index on `code` (not a prior
  SELECT) to resolve races between two concurrent creations picking the same
  code — see `isUniqueViolation(err, "affiliates_code_lower_idx" | "affiliates_pkey")`.

## Common Pitfalls

- Testing `accrueCommission` in isolation only verifies the INSERT, not the
  guarantee that matters (no double-accrual on webhook redelivery) — the test
  suite drives it through `payments::applyWebhook` instead.
