# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The authoritative Hashimon server: a **referee, not an oracle**. It never fabricates
creatures or decides outcomes — it holds the emission ledger (who owns what) and
**verifies** everything else by recomputing it, since the whole game is deterministic
(DNA = SHA-256, proof of work = re-hashable). See the ADR linked in README.md for the
full rationale.

Phase 1 (current) scope: identity + inventory + emission ledger + bound-mode PoW
mining. Real proof-of-work submission against a live bitcoin/pool target, incubation
/ Caos Engine seeding, credits/payments, and an MCP layer are later phases layered on
top of this — do not build them speculatively.

## Commands

```bash
pnpm install          # package manager is pnpm — enforced via preinstall (only-allow)
pnpm dev               # tsx watch src/server.ts
pnpm build             # tsc --noEmit, then esbuild bundle to dist/, copies schema.sql
pnpm start             # node dist/server.js (run build first)
pnpm migrate           # node dist/db/migrate.js — applies schema.sql (idempotent)
pnpm typecheck         # tsc --noEmit
pnpm test              # node --import tsx --test src/core/core.test.ts src/domain/auth.test.ts
```

Run a single test file directly: `node --import tsx --test src/core/core.test.ts`
(node:test files, not a test-runner framework — no `-t`/`--grep` beyond node:test's
own `--test-name-pattern`).

Requires Node ≥ 20 and Postgres ≥ 13 (`gen_random_uuid`). `cp .env.example .env`
before running migrate/dev.

## Architecture

```
src/core/     The Caos Core — versioned, deterministic ruleset shared with the client.
              sha256.ts (byte-identical to client's window.SHA256), dna.ts (DNA
              derivation), pow.ts (leadingZeroBits, share hashing, rank/stage math,
              verifyShare/verifyJobShare). This is imported to VERIFY, not to decide —
              the client runs an equivalent copy to play. core.test.ts guards parity.
src/data/     Server-side species registry — identity + base stats. Keys gate emission.
src/db/       pool.ts (pg pool + withTransaction), schema.sql (source of truth for
              tables), migrate.ts (applies schema.sql, idempotent — no migration files).
src/domain/   Business logic: players.ts (identity + bearer sessions), hashimons.ts
              (emission/birth, inventory, present() derived view), mining.ts (PoW job
              issuance + share submission), audit.ts (append-only log), crypto.ts.
src/http/     app.ts (express wiring), auth.ts (requireSession bearer gate), errors.ts
              (AppError + errorMiddleware), routes/ (one router per resource).
src/server.ts Entry point.
src/config.ts Env var parsing — single source for all runtime config.
```

**What the ledger stores vs. derives.** A `hashimons` row holds only *provenance*
(dna, species, birth nonce, algo version) and the *PoW biography* (best share, hash
count, etc.). Stats, colour, type and rank are **never stored** — they're derived
from `dna + pow` by the Caos Core on read (`present()` in `domain/hashimons.ts`), so
they can never drift or be forged. When the ruleset changes, re-derive; the ledger
itself needs no migration.

**The server owns the birth.** `POST /hashimons` never accepts a client-chosen nonce
— the server generates the birth nonce and derives the DNA itself so a client can't
grind for a rare identity. `dna` is `UNIQUE` in the schema (the anti-duplication
guarantee).

**Mining jobs (`src/domain/mining.ts`, `mining_jobs` table).** `issueJob()` currently
always writes `mode: 'bound'` with a fixed placeholder header (zeroed `prevHash`,
`dna` as `merkleRoot`, static `bits`) — the row type also allows `'legacy'` and
`'bitcoin'` modes for future real-target mining, not yet wired up. Jobs TTL out
(`HASHIMON_JOB_TTL_MS`, default 15 min); `submitShare()` re-verifies every share
server-side via `verifyJobShare` (never trust client-reported hashes) and dedupes
accepted shares globally by hash (`submitted_shares` table, plus a DB unique
constraint as the second line of defense against races).

**Auth model.** Deliberately thin bearer sessions (`sessions` table, `token` PK) —
`requireSession` (`http/auth.ts`) is the *only* way a request proves identity;
swap for a real provider before production. **Poseer = tener llave (`public_key`).**
Web `/register` creates an owner (username + password + secp256k1 keypair + genesis
starter, `custody: server_encrypted` or `player`). Anonymous `POST /session` and
Luanti guests without a `public_key` can play but **cannot** `POST /hashimons` (403
`cannot_own`) — see `canOwn` in `domain/players.ts`.

**Luanti bridge.** `X-Luanti-Secret` (`LUANTI_SERVER_SECRET`) gates
`src/http/routes/internal.ts`. The Luanti world polls `GET /internal/luanti-auth`
every ~2s for the owner list and calls `POST /internal/luanti-bind` on join (no
password forwarded — the engine already verified the API-published hash). If a guest
name is later registered on the web, the API password wins on the next poll.

**Path aliases.** `@/*` maps to `src/*` (tsconfig `paths` + esbuild bundling) — use
`@/domain/...`, `@/core/...` etc., never relative `../../` imports.

## Full API reference and manual smoke-test commands

See README.md — it documents every route (auth requirements, request/response
shapes for `/register`, `/login`, `/session`, `/hashimons`, `/wallet/*`,
`/internal/*`), the `POST /register` contract in full, and curl-based smoke checks.
Don't duplicate that table here; read it before touching `src/http/routes/`.

## Do not build by hand

Per README/ADR: payments (Phase 4) must go through a provider (Stripe-class), never
hand-rolled — this carries real security/regulatory weight. Owner passwords and
encrypted keys are an intentional stopgap for the web↔Luanti bridge, not
production-grade wallet custody as-is.
