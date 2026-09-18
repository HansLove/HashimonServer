---
paths:
  - "src/modules/mining/**"
  - "src/modules/core/db/schema.sql"
  - "src/modules/hashimon/**"
---

# Emission ledger and mining jobs

**What the ledger stores vs. derives.** A `hashimons` row holds only *provenance*
(dna, species, birth nonce, algo version) and the *PoW biography* (best share, hash
count, etc.). Stats, colour, type and rank are **never stored** — they're derived
from `dna + pow` by the Caos Core on read (`present()` in `hashimon/domain/hashimons.ts`), so
they can never drift or be forged. When the ruleset changes, re-derive; the ledger
itself needs no migration.

**The server owns the birth.** `POST /hashimons` never accepts a client-chosen nonce
— the server generates the birth nonce and derives the DNA itself so a client can't
grind for a rare identity. `dna` is `UNIQUE` in the schema (the anti-duplication
guarantee).

**Mining jobs (`src/modules/mining/domain/mining.ts`, `mining_jobs` table).** `issueJob()` writes
`mode: 'bitcoin'` when `HASHIMON_MINING_MODE=bitcoin` and a node template is available
(`block-template.ts::getPreparedTemplate`), and falls back to `mode: 'bound'` otherwise
(enriched as `template_fallback: true`). Bound mode uses a fixed placeholder header (zeroed
`prevHash`, `dna` as `merkleRoot`, static `bits`). `'legacy'` (the original client's
mode) is still verified by `core/core/pow.ts` but no code writes it. Readers such as
`mining.ts::rowToJob` and `pow.ts::verifyStoredPow` must keep handling all three. Jobs TTL out
(`HASHIMON_JOB_TTL_MS`, default 15 min); `submitShare()` re-verifies every share
server-side via `verifyJobShare` (never trust client-reported hashes) and dedupes
accepted shares globally by hash (`submitted_shares` table, plus a DB unique
constraint as the second line of defense against races). A bitcoin-mode share also stores its `BitcoinShareSnapshot` in `submitted_shares.template`
(the job row, and the template with it, expires); bound shares store NULL there because their
preimage re-derives from the DNA and the nonces already in the row.
