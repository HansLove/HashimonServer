# Incubation Domain

## Overview
The main credit sink, and one of three movers of `players.credits` — the others
are payments (settle) and `companion/domain/chat.ts::speak` (per-turn debit). Buys "marks" (never say "shares" to a player) that CaosEngine's pool
mines against a creature's DNA; nothing this module receives from the pool is
trusted — every mark is re-verified here before it counts.

## Entry Points
- `incubation.ts::quoteFor` — the only place a lot's price is computed; rounds on the total, not the unit price.
- `incubation.ts::createLot` — debits credits and opens the lot in one transaction; caller still has to hit CaosEngine and call `markAssigned`.
- `incubation.ts::markAssigned` / `markFailed` — record CaosEngine's 202 (or its absence).
- `incubation.ts::applyShare` — the webhook's per-mark entry point; verifies, dedupes, mutates the creature, closes the lot if full.
- `incubation.ts::closeLotById` — the only exit from a live lot and the only place a refund is paid.
- `incubation.ts::statusForTermination` — maps CaosEngine's closing label to ours, biased toward the ledger's own count.
- `incubation.ts::expireStaleLots` — sweep called from read paths (`activeLotFor`, `lotForHashimon`), not a cron.
- `caos-client.ts::requestHighEnergy` — the single outbound POST to CaosEngine; everything after it arrives by webhook.

## Business Logic

**Nothing the pool reports is believed.** `verifyShare` rebuilds the header from
the template the pool shipped and only counts a mark if three checks all hold:
(1) the recomputed hash matches the claimed hash, (2) the coinbase commits to
*this* creature's DNA (else a pool could bill one player for another's work, or
replay a mark across every creature), (3) the recomputed hash clears
`stars_requested * BITS_PER_STAR` (else a `nonce: 0` header with the right DNA
would pass the first two checks for free). The payload's own `stars`/
`leadingZeros` fields are just more numbers the pool reported — never trusted.

**Pricing is published pre-discounted.** `caos_pricing` stores list price +
discount so an operator can `UPDATE` a readable row, but `pricingTiers()` and
`quoteFor()` return the discount already multiplied in — a client applying it a
second time would be a silent overcharge-in-reverse. A request carries a
*count*, never an amount, same discipline as `payments/domain/payments.ts`.

**`markAssigned` gates on `caos_request_id IS NULL`, not on `status='queued'`.**
CaosEngine's first mark can arrive and move the lot to `mining` before this
UPDATE runs; gating on status would then match nothing and leave the batch id
null forever, silently disabling the check in `applyShare` that keeps one
batch's marks off another lot.

**The lot's one-hour clock starts at `assigned_at`, never `created_at`.** A lot
queued on CaosEngine's side for lack of pool supply must not refund itself for
waiting — CaosEngine has no "assigned" event, so its 202 is the accepted
approximation. `expireStaleLots` treats `queued` (never reached CaosEngine —
timed out at `QUEUED_GRACE_MS`, refunded in full as `failed`) differently from
`assigned`/`mining` (timed out at `config.incubationLotTimeoutMs`, `expired`).

**`applyShare`'s creature lock and record comparison must both be live.** The
creature row is read `FOR UPDATE` inside the transaction so a browser-mining
mutation racing the same creature can't slip between the before/after star
read. The record itself is compared against the *column* (`$2 > best_share_bits`
in the `UPDATE`), never a pre-transaction read — otherwise the slower of two
concurrent writers could overwrite a better mark with a worse one.

**A lot closing mid-`applyShare` must roll back, not just fail.** The lot's own
`UPDATE` carries the same `status = ANY(live)` guard as the read at function
entry, because a lot closed by a concurrent sweep or webhook between the two
would otherwise be resurrected to `mining` by this mark — and would then pass
`closeLotById`'s live check a second time, paying its refund twice.
`LotClosedDuringApply` throws inside the transaction specifically to undo the
share insert and the creature mutation together.

**`mutated` is stored, never re-derived.** `applyShare` sets it only when a mark
raises the creature's *star* count (four bits = one star, so most new bit
records are invisible to the player) under the same lock as the read. Deriving
it later from `stars_before` would go stale the moment a browser-mining session
on the same creature landed a mutation in between.

**`statusForTermination`: the ledger's delivery count decides, CaosEngine's
label can only lower it.** A batch CaosEngine calls `completed` whose marks did
not all arrive (webhook retries exhausted) still closes `partial` — a lot
cannot be `complete` and owe a refund at the same time, and the refund is
computed from the same delivered count.

**Refunds are proportional and computed from the ledger, never from what the
pool claims delivered.** `refundFor` returns `credits_charged * undelivered /
shares_requested`, rounded on the total. CaosEngine never refunds Hashimon back
— the cost of marks already mined but undelivered is eaten here.

## Dependencies

**Internal:**
- `core/db/pool` — `withTransaction` everywhere credits or lot status move, matching `payments/domain/payments.ts`'s transactional discipline.
- `core/core/index` — `hashBitcoinJob`/`leadingZeroBits`/`progressionFromBits` do the actual re-hash; this module never trusts a pool-supplied hash.
- `core/domain/audit` — every lot open/close/mark is append-only audited (needed to reconstruct a disputed lot from both ends).

**External:** none beyond Node's own `fetch` in `caos-client.ts` — deliberately no HTTP client or retry, since a retried POST after an ambiguous failure would buy the player two batches for one charge (see the `ponytail:` note in that file for when that changes).

## Side Effects & Constraints

- `caos-client.ts::isConfigured` gates whether incubation routes are even reachable — `caosEngineUrl`/`publicUrl`/`coinbaseAddress` must all be set.
- `snapshotOf` sets `versionBits: null` on purpose: spoon has already BIP310-rolled the version, so re-applying the mask would corrupt an otherwise-correct header.
- The DNA commitment check in `verifyShare` accepts either encoding CaosEngine may have used (raw DNA bytes or ASCII of the hex string) — being strict about which one buys nothing since both prove the same binding, but guessing wrong rejects every honest mark.

## Known gaps
Unsigned webhook (the lot's 32-byte secret in the URL is the only credential —
accepted because a forged mark still has to clear the star floor), `assigned`
inferred from CaosEngine's 202 rather than a real event, sweep on read paths
rather than a schedule, no reconciliation against CaosEngine. See
README.md's "Known gaps in the incubation flow" for the full list.
