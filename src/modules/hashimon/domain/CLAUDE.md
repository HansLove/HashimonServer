# Hashimon — domain

## Overview
The emission ledger: the only place a creature is born, and the only place its
client-facing view is built. Nothing derived is ever stored, so a ruleset change
never needs a data migration.

## Entry Points
- `hashimons::emit` — the only way a Hashimon row is created; server always owns the birth nonce.
- `hashimons::present` — derives the client-facing view (stats/rank/verified) from `dna + pow`; nothing derived is ever stored.
- `hashimons::getForOwner`, `hashimons::listByOwner`, `hashimons::countForOwner` — inventory reads.
- `hashimons::isGenesisSpecies` — lets `POST /hashimons` (`hashimon/http/routes/hashimons.ts`) refuse a body-supplied Genesis species; registration never calls it, it derives the species from the date of birth.

## Key Files
- **../data/species.ts** — server-side species allowlist, nothing more. Its keys gate emission: a `speciesKey` absent from it can never be minted. It holds no stats, type or look — those were removed and are derived from DNA; never add them back here.

## Business Logic
- **Server owns the birth.** `hashimons::emit` generates the birth nonce itself so a client can never grind for a rare DNA; on the astronomically unlikely `dna` unique-constraint collision (Postgres code `23505`) it retries with a new nonce up to 5 times.
- **Derived, never stored.** Stats, colour, type, rank all come from `present()` recomputing `dna + pow` via the Caos Core on every read — the row only stores provenance (dna, species, birth nonce, algo version) and PoW biography, so a ruleset change never requires a data migration.
- **`present()` re-verifies stored marks like any other share.** A creature's `best_share_bitcoin` carries the pool's own `extranonce1`/`extranonce2`, which are not derivable from the DNA, so the stored payload is what gets re-hashed — the same treatment a browser-submitted share gets.

## Dependencies

**Internal:**
- `@/modules/core/core` (`Dna`, `progressionOf`, `verifyStoredPow`) — the deterministic ruleset; this module calls it to verify/derive, never to decide game outcomes itself.
- `@/modules/hashimon/data/species` (`Hashimons`) — species allowlist; gates which `speciesKey` values `emit` accepts.
- `@/modules/core/db/pool` (`query`, `withTransaction`) — `emit` wraps its INSERT + `audit()` call in one transaction so the audit trail can never desync from the mutation.
- `@/modules/core/domain/audit` — every emission records itself.

## Side Effects & Constraints
- `emit` is transactional; a caller that inserts a creature row by hand breaks the audit invariant.

## Common Pitfalls
- Adding a new mutation to `hashimons` without an `audit()` call breaks the append-only trail other tooling assumes exists for every state change.
- Storing anything derived (a stat, a rank, a colour) on the row. The whole anti-forgery property rests on those being recomputed on read.
- Forgetting the `23505` retry when adding new unique-constrained inserts — `emit` (dna) relies on catching this Postgres error code rather than pre-checking, to close the race window.
