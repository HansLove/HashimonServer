# Core (Caos Core)

## Overview

The versioned, deterministic ruleset shared with the browser client (ADR D3). The
server imports it only to **verify** work the client already did — DNA derivation
and proof-of-work — never to decide outcomes on its own. `core.test.ts` pins golden
vectors so server and client stay byte-identical.

## Entry Points

- `pow.ts::verifyJobShare` — re-verifies a submitted mining share against a live job; the only trusted acceptance path (used by `domain/mining.ts`).
- `pow.ts::verifyStoredPow` — recomputes a creature's stored best share to detect forgery/mismatch (used by `domain/hashimons.ts::present()`).
- `pow.ts::progressionOf` / `progressionFromBits` — maps best-share bits to tier/stars/stage for display.
- `dna.ts::Dna.derive` — the only way a DNA hex string should be produced; server always supplies the birth nonce itself.
- `index.ts::CORE_VERSION` — stamped on every birth; bump when scoring/derivation rules change.

## Key Files

- **sha256.ts** — Node's native digest, deliberately NOT the client's hand-rolled pure-JS SHA-256; only the hex output is required to match, not the implementation.
- **pow.ts** — also defines the not-yet-wired `"legacy"` and `"bitcoin"` job modes and `hashBitcoinJob` (real Stratum-style header hashing) for a future phase; only `"bound"` mode is issued today.

## Business Logic

- **Bits, not difficulty, is the unit of work.** `leadingZeroBits` counts zero bits (not just nibbles) of a hash hex string — a hash like `1fff` counts as 3 bits, not 0. `BITS_PER_STAR = 4` and `MAX_STAGE = 33` translate accumulated bits into tier/stars/stage.
- **Two share-hashing schemes coexist.** `hashShareLegacy(dna, extranonce2)` is the original client formula; `hashShareBound(dna, extranonce1, extranonce2, nonce)` is the MVP formula. `verifyStoredPow` picks legacy vs bound based on whether `bestShareExtranonce2` is present on the stored record — this is the only signal distinguishing old vs new shares, there is no explicit mode field on `PowRecord`.
- **`deriveExtranonce1(dna)`** is not random — it is the first 8 hex chars of the creature's own DNA (falls back to `"deadbeef"` if DNA has no hex chars). `verifyJobShare` rejects a share if `job.extranonce1` does not match this derivation from the claimed DNA (`dna_mismatch`), binding every job to exactly one creature.
- **`hashJob` dispatches on `job.mode`** (`legacy` / `bitcoin` / default `bound`) to pick the hashing formula — a job's `header.merkleRoot` field is overloaded to carry the DNA in bound/legacy mode, not an actual Merkle root.
- **Verification order in `verifyJobShare`** matters: stale job → extranonce1/DNA binding → nonce shape → recompute hash → under-target → duplicate. Callers must pass a `seenShareHashes` set (global duplicate dedup lives outside this module, in `domain/mining.ts` + a DB unique constraint).
- **DNA indexing is 1-based** (`Dna.at`/`Dna.window`/`Dna.range`), matching the whitepaper's nibble numbering — off-by-one from typical 0-based string indexing.

## Dependencies

**External:**
- `node:crypto` — native SHA-256, faster and simpler than porting the client's pure-JS implementation server-side; correctness is verified by matching output, not by matching code.

## Failure Modes

- `verifyStoredPow` returns `"mismatch"` (hash doesn't recompute — likely forged/corrupted), `"underclaim"` (claimed bits exceed what the hash actually has), or `"unmined"` (no share recorded yet) — callers must branch on `.status`, not assume success.
- `hashShareBound`/`hashShareLegacy`/`hashShare` naming is legacy-laden: `hashShare` and `verifyShare`/`SHARE_TARGET_BITS` are `@deprecated` aliases kept only for old-client/test parity — new code should use `hashShareLegacy`/`hashShareBound` and `verifyStoredPow`/`DEFAULT_SHARE_TARGET_BITS`.
