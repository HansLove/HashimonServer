---
paths:
  - "src/modules/incubation/**"
  - "src/modules/core/db/schema.sql"
---

# Assisted incubation

**Assisted incubation (`src/modules/incubation/domain/incubation.ts`, `caos_pricing` + `caos_lots`).** The
main credit sink, one of the three movers of `players.credits` (with payments and
`companion/domain/chat.ts::speak` — see payments.md). A request carries a
**count, never an amount**; `GET /incubation/pricing` publishes the ladder **already net of
the tier discount** (10-24 arrives as `9.8`, not `10` + `2%`) so a client cannot apply it
twice. Seven server-decided statuses — `queued → assigned → mining → complete | partial |
failed | expired` — and, as with payments, the client's UI phase *is* that column.

**Nothing the pool reports is believed.** `verifyShare` re-hashes every mark from the
template shipped with it and counts it only if all three hold: the rebuilt header matches the
claimed hash, the coinbase (which the merkle root commits to) carries this creature's DNA,
**and** the recomputed hash clears `caos_lots.stars_requested * BITS_PER_STAR`. Drop the
second and a pool can bill one player for another's work, or replay one mark across every
creature it ever mined for. Drop the third and the first two still pass for a header with
`nonce: 0` carrying the right DNA — fifty of those close a lot `complete`, owe no refund and
change nothing. The floor is read off the recomputed hash; the payload's own `stars` and
`leadingZeros` are just more numbers a pool reported. The mark is stored in
`hashimons.best_share_bitcoin` — carrying spoon's own `extranonce1`/`extranonce2`, which
are *not* derivable from the DNA — so `present()` re-verifies it like any browser share.

**`presentLot.mutated` is a stored fact, not a derivation.** `applyShare` sets it when a mark
actually raises the creature's *star* count, under a `FOR UPDATE` on the creature row so the
before and after come from one view of it. Never re-derive it from `stars_before`: that is a
snapshot from when the lot opened, and a player browser-incubating meanwhile leaves it stale,
so a mark the creature had already beaten would still look like a mutation. `mutación` is the
one player-facing word that cannot be approximate.

**The delivery count decides the close, and CaosEngine's label can only lower it.**
`statusForTermination` ignores `completed` when the ledger says fewer marks arrived — the
refund comes from that same count, and a `complete` lot that owes money renders as a success
screen the player did not get.

Five guarantees are SQL, not `if`s: `caos_lots_active_per_player_idx` (stricter than the
product's one-lot-per-creature rule, so it subsumes it) turns a second POST into 409
`incubation_pending` *with the live lot in the body*; `submitted_shares`' hash PK plus
`submitted_shares_lot_index_idx` make a redelivered mark a no-op; `closeLotById`'s
`UPDATE … WHERE status = ANY(live) RETURNING *` pays a refund once; `applyShare`'s lot UPDATE
carries that *same* live guard, because a mark landing on a lot closed since it was read would
otherwise resurrect it to `mining` and let the refund be paid a second time (that mark rolls
back whole); and the creature's `best_share_*` move under `CASE WHEN $2 > best_share_bits`,
against the column rather than a pre-transaction read, so the loser of a race with the
browser cannot overwrite a better mark. Refunds are **proportional to what was actually
paid**, discount included, and counted from the ledger's own delivered marks — never from the
number the pool reports.

**`markAssigned` claims the batch id on `caos_request_id IS NULL`, not on `status='queued'`.**
CaosEngine's first mark can beat our own UPDATE to the row and move the lot to `mining`;
gating on the status would then match nothing and leave the id null forever, silently
disabling the only check that keeps one batch's marks off another's lot.

**The lot's hour starts at `assigned_at`, never `created_at`.** A lot queued on CaosEngine's
side for lack of supply must not refund itself for waiting. Accepted approximation: CaosEngine
has no assignment event, so the clock starts at its 202 — fix that with the event, not a
longer timeout. `expireStaleLots` also sweeps a `queued` lot whose outbound POST never
happened (written off in full), which would otherwise hold the index forever.

**CaosEngine does not sign its webhooks.** The lot's 32-byte secret in the URL is the whole
credential, and `incubation-webhook.ts` is therefore mounted *after* `express.json()` — there
are no raw bytes to preserve. Accepted knowingly: a forged mark still has to solve the proof
of work — which is what the star floor in `verifyShare` actually enforces, so that sentence
stays true — and a forged close only ever refunds the player early. Never log the secret
(`REDACT_PATHS` covers `webhook_secret`/`lotSecret`).

**The webhook picks mark-vs-close by the mark's own fields (`shareIndex`/`hash`), before
either schema runs.** `closeSchema` asks only for a `requestId` and a `status` string, so
falling through to it on a failed `shareSchema` would mean one renamed key in spoon's payload
terminates the lot mid-batch and refunds the player. A body that looks like a mark and does
not validate is a 400, never a close. Hex fields are validated *there*, at the boundary:
`Buffer.from("nothex","hex")` returns an empty buffer instead of throwing, so a corrupt
template would otherwise reach the verifier and come back as `hash_mismatch` — the one verdict
that accuses the pool of lying about its work.

**Five gaps are recorded, not closed** — see *Known gaps in the incubation flow* in
README.md: unsigned webhook, `assigned` inferred from the 202, sweep on read paths rather
than a schedule, that sweep being an unindexed scan on a polling endpoint, and no
reconciliation against CaosEngine.
