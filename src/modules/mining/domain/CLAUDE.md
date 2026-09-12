# Mining — domain

## Overview
PoW job issuance and share submission for a bound Hashimon, the yield harvest that
turns work below the share target into Hashi-croquetas, plus the Bitcoin block
template machinery that feeds real-target jobs. Trusts nothing the client reports:
every share and every yield is re-hashed server-side before it counts.

## Entry Points
- `mining::issueJob`, `mining::submitShare` — PoW job lifecycle for a bound Hashimon.
- `mining::submitYield` — the second harvest: the same job and nonce as a share, judged against the yield window instead of the share target.
- `mining::consumeCroqueta` / `mining::croquetaBalance` — spend (FIFO) and count a creature's unspent consumable yields; `consumeCroqueta` requires the caller's transaction.
- `vibing::harvestPlaceForPlayer` — where a player's harvest lands and which tier it yields.
- `block-template::getPreparedTemplate` — cached, creature-agnostic Bitcoin block template feeding real-target jobs.

## Key Files
- **vibing.ts** — projection of the world's Vibing towers, pushed whole by `POST /internal/luanti-vibing-towers` (`replaceVibingTowers`, replace-all like `town_claims`), plus the per-place heat (`place_heat`) every harvest bumps. The world owns where a tower stands; the server derives its tier from the coordinate via `core/core/yield-map.ts::zoneAtWorld`.
- **block-template.ts** — talks to a real Bitcoin Core node (`getblocktemplate` RPC) and reduces its response to a compact, extranonce-hole-shaped coinbase + merkle branch; not a mining job itself, `mining.ts` splices per-share extranonce values into it.
- **bitcoin-address.ts** — decodes a bech32/bech32m segwit address (BIP173/BIP350) into a scriptPubKey; `block-template.ts` uses it to pay the coinbase output to `config.coinbaseAddress` instead of an OP_RETURN. Legacy base58 (`1.../3...`) addresses are unsupported.

## Business Logic
- **Mining modes.** `mining::issueJob` picks its mode from `config.miningMode`: in `'bound'` (default) it writes the placeholder header (zeroed prevHash, `dna` as merkleRoot, static bits) as before. In `'bitcoin'` it pulls a `PreparedTemplate` from `block-template::getPreparedTemplate`, builds a real header (`prevhashBE`, real `bits`, `curtime` as timestamp), and persists `{...prepared, extranonce1: deriveExtranonce1(row.dna)}` under `header.bitcoin` in the jsonb column; `rowToJob`/`jobResponse` hydrate/expose that payload only when `row.mode === 'bitcoin'`. If the node is unreachable and no template is cached, `issueJob` degrades to `'bound'` rather than failing the request. This template is never submitted to the network (`submitblock` out of scope) — the coinbase pays a real segwit address (`config.coinbaseAddress`, see `bitcoin-address.ts`) but still has no witness commitment, fine for proof-of-work hashing but not for a real broadcast.
- **Template caching.** `getPreparedTemplate` caches one `PreparedTemplate` in module memory for `config.templateRefreshMs`, so many jobs across many creatures reuse one `getblocktemplate` RPC round-trip; on a fetch error it logs (host only, no credentials) and returns the stale cached template rather than failing the caller.
- **Merkle branch reuse trick.** `block-template::computeMerkleBranch` treats the coinbase as tree index 0 with a fixed all-zero placeholder leaf; because index-0's sibling is always position 1 and its own value never feeds other branch entries, the branch is computed once per template from the other txids and reused for every share regardless of the per-share extranonce.
- **Shares are re-verified, never trusted.** `mining::submitShare` calls `verifyJobShare` server-side regardless of what hash the client claims, then dedupes globally by share hash — first via a `SELECT`, then relies on `submitted_shares`'s unique constraint as the race-safe backstop (catches `23505` and converts it to `duplicate_share`).
- **Best-share update is conditional, not overwrite.** In `submitShare`, `best_share_*` columns only update when the new share's `bits` beats the stored one (`CASE WHEN $4 THEN ... ELSE ...` in the UPDATE) — a weaker accepted share still counts toward `valid_shares`/`total_hashes` but does not regress the best-share record.
- **A yield is decided on three axes, and the player steers none of them.** `submitYield` recomputes the hash and requires `evaluateYield`'s window to clear its floor — that is the *event* (`no_yield` otherwise). The *tier* is `minTier(rollYieldTier(hash), placeCeiling)`: PLACE (the zone of the player's town tower, or the consumable floor at `vault:<player>` with no town/tower) is the ceiling, and LUCK — a roll off a disjoint hash window, weighted ~75/19/6 — rolls the tier under it. So a food zone only ever yields food, and capital needs both a capital zone and a rare roll. All resolved server-side; the hash's own depth is kept only as `yield_bits` telemetry.
- **One hash harvests once.** `pow_yield.hash` is the primary key, so a repeated hash is a `23505` turned into `duplicate_yield`; the insert, `vibing::bumpHeat` and `audit()` ride one transaction.
- **The croqueta pantry is shared across modules.** Unspent consumable `pow_yield` rows are a creature's food — `companion/domain/chat.ts::care('hunger')` spends one through `consumeCroqueta` and fails with 409 `no_food` when none are left — and the same rows are a town's larder in `territory/domain/wolkers.ts`. Feeding one starves the other by design.

## Dependencies

**Internal:**
- `@/modules/core/core` (`verifyJobShare`, `evaluateYield`) — the deterministic ruleset; this module calls it to verify, never to decide outcomes itself.
- `@/modules/core/core/yield-map` (`zoneAtWorld`, from `vibing.ts`) — the tier a tower's coordinate yields.
- `player_territory` (territory's projection, read directly in `vibing::harvestPlaceForPlayer`) — the town a player harvests for; a stale Luanti sync means a stale tier.
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
