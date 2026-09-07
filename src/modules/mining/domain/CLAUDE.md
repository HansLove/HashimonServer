# Mining — domain

## Overview
PoW job issuance and share submission for a bound Hashimon, plus the Bitcoin block
template machinery that feeds real-target jobs. Trusts nothing the client reports:
every share is re-hashed server-side before it counts.

## Entry Points
- `mining::issueJob`, `mining::submitShare` — PoW job lifecycle for a bound Hashimon.
- `block-template::getPreparedTemplate` — cached, creature-agnostic Bitcoin block template feeding real-target jobs.

## Key Files
- **block-template.ts** — talks to a real Bitcoin Core node (`getblocktemplate` RPC) and reduces its response to a compact, extranonce-hole-shaped coinbase + merkle branch; not a mining job itself, `mining.ts` splices per-share extranonce values into it.
- **bitcoin-address.ts** — decodes a bech32/bech32m segwit address (BIP173/BIP350) into a scriptPubKey; `block-template.ts` uses it to pay the coinbase output to `config.coinbaseAddress` instead of an OP_RETURN. Legacy base58 (`1.../3...`) addresses are unsupported.

## Business Logic
- **Mining modes.** `mining::issueJob` picks its mode from `config.miningMode`: in `'bound'` (default) it writes the placeholder header (zeroed prevHash, `dna` as merkleRoot, static bits) as before. In `'bitcoin'` it pulls a `PreparedTemplate` from `block-template::getPreparedTemplate`, builds a real header (`prevhashBE`, real `bits`, `curtime` as timestamp), and persists `{...prepared, extranonce1: deriveExtranonce1(row.dna)}` under `header.bitcoin` in the jsonb column; `rowToJob`/`jobResponse` hydrate/expose that payload only when `row.mode === 'bitcoin'`. If the node is unreachable and no template is cached, `issueJob` degrades to `'bound'` rather than failing the request. This template is never submitted to the network (`submitblock` out of scope) — the coinbase pays a real segwit address (`config.coinbaseAddress`, see `bitcoin-address.ts`) but still has no witness commitment, fine for proof-of-work hashing but not for a real broadcast.
- **Template caching.** `getPreparedTemplate` caches one `PreparedTemplate` in module memory for `config.templateRefreshMs`, so many jobs across many creatures reuse one `getblocktemplate` RPC round-trip; on a fetch error it logs (host only, no credentials) and returns the stale cached template rather than failing the caller.
- **Merkle branch reuse trick.** `block-template::computeMerkleBranch` treats the coinbase as tree index 0 with a fixed all-zero placeholder leaf; because index-0's sibling is always position 1 and its own value never feeds other branch entries, the branch is computed once per template from the other txids and reused for every share regardless of the per-share extranonce.
- **Shares are re-verified, never trusted.** `mining::submitShare` calls `verifyJobShare` server-side regardless of what hash the client claims, then dedupes globally by share hash — first via a `SELECT`, then relies on `submitted_shares`'s unique constraint as the race-safe backstop (catches `23505` and converts it to `duplicate_share`).
- **Best-share update is conditional, not overwrite.** In `submitShare`, `best_share_*` columns only update when the new share's `bits` beats the stored one (`CASE WHEN $4 THEN ... ELSE ...` in the UPDATE) — a weaker accepted share still counts toward `valid_shares`/`total_hashes` but does not regress the best-share record.

## Dependencies

**Internal:**
- `@/modules/core/core` (`verifyJobShare`) — the deterministic ruleset; this module calls it to verify, never to decide outcomes itself.
- `@/modules/core/db/pool` (`query`, `withTransaction`) — `submitShare` wraps its INSERT/UPDATE + `audit()` call in one transaction so the audit trail can never desync from the mutation.
- `@/modules/core/domain/audit` — every mutation records itself; see that module's constraint on passing the transaction `client`.
- `@/modules/core/config` — `blockTargetBits`, `jobTtlMs`, `templateRefreshMs`, `btcNodeUrl` all live here; `mining.ts`/`block-template.ts` never hardcode tuning values.

**Environment Variables:**
- `btcNodeUrl` (config) — RPC URL with embedded basic-auth credentials for `block-template.ts`; wrong/missing → `getPreparedTemplate` fails silently and serves the last cached template (or `null` before first success).
- `coinbaseAddress` (config, `HASHIMON_COINBASE_ADDRESS`) — required only when `miningMode` is `'bitcoin'`, no default; `core/config.ts` throws at import time if unset in that mode. Unused and optional in `'bound'` mode (the default), so a fresh clone still boots without it.

## Side Effects & Constraints
- `submitShare` is transactional; a caller that only does part of the transaction (e.g. inserts a share row without going through `submitShare`) breaks the dedupe/audit invariant.
- `block-template.ts` holds a module-level mutable cache (`cached`) — not per-request, shared across all callers in the process; a test or script that needs a fresh template must account for the TTL rather than assuming a clean fetch.

## Common Pitfalls
- Adding a new mutation to `mining_jobs` without an `audit()` call breaks the append-only trail other tooling assumes exists for every state change.
- Forgetting the `23505` duplicate handling when adding new unique-constrained inserts — `submitShare` (share hash) relies on catching this Postgres error code rather than pre-checking, to close the race window.
- `getPreparedTemplate` swallowing RPC errors and returning stale/`null` templates means callers must handle `null` explicitly — it does not throw on node downtime.
