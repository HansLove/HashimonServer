# Domain

## Overview
Business logic layer between `src/http/routes/` and `src/db/` — the only place that
decides what a request is allowed to do to the ledger. Everything here trusts nothing
from the client and re-derives or re-verifies rather than storing decided values.

## Entry Points
- `players::findOrCreatePlayer` — create-or-restore identity by public key; anonymous if none given.
- `players::registerOwner` — full web registration: validates species/username/password, mints a starter Hashimon and session in one flow.
- `players::loginOwner`, `players::playerForToken` — password login and bearer-token resolution used by `http/auth.ts`.
- `players::canOwn` — the single gate deciding if a player may own creatures (has `public_key`).
- `hashimons::emit` — the only way a Hashimon row is created; server always owns the birth nonce.
- `hashimons::present` — derives the client-facing view (stats/rank/verified) from `dna + pow`; nothing derived is ever stored.
- `mining::issueJob`, `mining::submitShare` — PoW job lifecycle for a bound Hashimon.
- `block-template::getPreparedTemplate` — cached, creature-agnostic Bitcoin block template feeding real-target jobs.

## Key Files
- **crypto.ts** — secp256k1 keygen/validation, scrypt+AES-GCM private-key encryption, and the legacy Luanti SHA1 password format (three unrelated crypto concerns, kept together because `players.ts` needs all three).
- **audit.ts** — append-only log writer; must be called with the same transaction `client` as the mutation it records (see Side Effects).
- **block-template.ts** — talks to a real Bitcoin Core node (`getblocktemplate` RPC) and reduces its response to a compact, extranonce-hole-shaped coinbase + merkle branch; not a mining job itself, `mining.ts` splices per-share extranonce values into it.
- **bitcoin-address.ts** — decodes a bech32/bech32m segwit address (BIP173/BIP350) into a scriptPubKey; `block-template.ts` uses it to pay the coinbase output to `config.coinbaseAddress` instead of an OP_RETURN. Legacy base58 (`1.../3...`) addresses are unsupported.

## Business Logic
- **Ownership gate.** A player can only own creatures (`POST /hashimons`) if `public_key` is set (`players::canOwn`). Anonymous/guest players (Luanti without a key) can play but not own — enforced at the domain layer, not just HTTP.
- **Server owns the birth.** `hashimons::emit` generates the birth nonce itself so a client can never grind for a rare DNA; on the astronomically unlikely `dna` unique-constraint collision (Postgres code `23505`) it retries with a new nonce up to 5 times.
- **Derived, never stored.** Stats, colour, type, rank all come from `present()` recomputing `dna + pow` via the Caos Core on every read — the row only stores provenance and PoW biography, so a ruleset change never requires a data migration.
- **Genesis starters are gated twice.** `registerOwner` requires `speciesKey` to be in the hardcoded `GENESIS_KEYS` set AND pass `hashimons::isGenesisSpecies` AND exist in the species table — belt-and-suspenders against a bad species key minting a rare creature as a "starter".
- **Custody model.** If the caller supplies their own `publicKey`, custody is `"player"` (server never sees the private key). If not, the server generates a keypair and encrypts the private key with a key derived from the account password (`crypto::encryptPrivateKey`) — custody `"server_encrypted"`. `players::claimSelfCustody` lets an owner migrate from server-held to self-held by wiping the encrypted blob.
- **Mining modes.** `mining::issueJob` picks its mode from `config.miningMode`: in `'bound'` (default) it writes the placeholder header (zeroed prevHash, `dna` as merkleRoot, static bits) as before. In `'bitcoin'` it pulls a `PreparedTemplate` from `block-template::getPreparedTemplate`, builds a real header (`prevhashBE`, real `bits`, `curtime` as timestamp), and persists `{...prepared, extranonce1: deriveExtranonce1(row.dna)}` under `header.bitcoin` in the jsonb column; `rowToJob`/`jobResponse` hydrate/expose that payload only when `row.mode === 'bitcoin'`. If the node is unreachable and no template is cached, `issueJob` degrades to `'bound'` rather than failing the request. This template is never submitted to the network (`submitblock` out of scope) — the coinbase pays a real segwit address (`config.coinbaseAddress`, see `bitcoin-address.ts`) but still has no witness commitment, fine for proof-of-work hashing but not for a real broadcast.
- **Template caching.** `getPreparedTemplate` caches one `PreparedTemplate` in module memory for `config.templateRefreshMs`, so many jobs across many creatures reuse one `getblocktemplate` RPC round-trip; on a fetch error it logs (host only, no credentials) and returns the stale cached template rather than failing the caller.
- **Merkle branch reuse trick.** `block-template::computeMerkleBranch` treats the coinbase as tree index 0 with a fixed all-zero placeholder leaf; because index-0's sibling is always position 1 and its own value never feeds other branch entries, the branch is computed once per template from the other txids and reused for every share regardless of the per-share extranonce.
- **Shares are re-verified, never trusted.** `mining::submitShare` calls `verifyJobShare` server-side regardless of what hash the client claims, then dedupes globally by share hash — first via a `SELECT`, then relies on `submitted_shares`'s unique constraint as the race-safe backstop (catches `23505` and converts it to `duplicate_share`).
- **Best-share update is conditional, not overwrite.** In `submitShare`, `best_share_*` columns only update when the new share's `bits` beats the stored one (`CASE WHEN $4 THEN ... ELSE ...` in the UPDATE) — a weaker accepted share still counts toward `valid_shares`/`total_hashes` but does not regress the best-share record.

## Dependencies

**Internal:**
- `@/core` (`Dna`, `progressionOf`, `verifyStoredPow`, `verifyJobShare`) — the deterministic ruleset; domain calls it to verify/derive, never to decide game outcomes itself.
- `@/data/species` (`Hashimons`) — species registry; gates which `speciesKey` values `emit`/`registerOwner` accept.
- `@/db/pool` (`query`, `withTransaction`) — `emit` and `submitShare` both wrap their INSERT/UPDATE + `audit()` call in one transaction so the audit trail can never desync from the mutation.
- `@/config` — `blockTargetBits`, `jobTtlMs`, `templateRefreshMs`, `btcNodeUrl` all live here; `mining.ts`/`block-template.ts` never hardcode tuning values.

**External:**
- `argon2` — password hashing for `password_hash` (registerOwner/loginOwner); chosen over the legacy SHA1 `luanti_password` which exists only for backward compat with the Luanti server's own auth format.
- `@noble/secp256k1` — key generation/validation matching the same curve the client/wallet uses.

**Environment Variables:**
- `btcNodeUrl` (config) — RPC URL with embedded basic-auth credentials for `block-template.ts`; wrong/missing → `getPreparedTemplate` fails silently and serves the last cached template (or `null` before first success).
- `coinbaseAddress` (config, `HASHIMON_COINBASE_ADDRESS`) — required only when `miningMode` is `'bitcoin'`, no default; `config.ts` throws at import time if unset in that mode. Unused and optional in `'bound'` mode (the default), so a fresh clone still boots without it.

## Side Effects & Constraints
- `audit()` must be called with the transaction's `client`, not a bare `query()` — passing the wrong client silently writes the audit row outside the transaction, breaking the "commits atomically" guarantee `emit`/`submitShare` rely on.
- `emit` and `submitShare` are transactional; a caller that only does part of the transaction (e.g. inserts a share row without going through `submitShare`) breaks the dedupe/audit invariant.
- `block-template.ts` holds a module-level mutable cache (`cached`) — not per-request, shared across all callers in the process; a test or script that needs a fresh template must account for the TTL rather than assuming a clean fetch.

## Common Pitfalls
- Adding a new mutation to `hashimons`/`mining_jobs` without an `audit()` call breaks the append-only trail other tooling assumes exists for every state change.
- Forgetting the `23505` retry/duplicate handling when adding new unique-constrained inserts — both `emit` (dna) and `submitShare` (share hash) rely on catching this Postgres error code rather than pre-checking, to close the race window.
- `getPreparedTemplate` swallowing RPC errors and returning stale/`null` templates means callers must handle `null` explicitly — it does not throw on node downtime.
