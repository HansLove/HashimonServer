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
pnpm migrate:dev       # applies src/db/schema.sql directly — USE THIS in development
pnpm migrate           # node dist/db/migrate.js — applies dist/db/schema.sql (idempotent)
pnpm typecheck         # tsc --noEmit
pnpm test              # node --import tsx --test src/core/core.test.ts src/domain/auth.test.ts
```

Run a single test file directly: `node --import tsx --test src/core/core.test.ts`
(node:test files, not a test-runner framework — no `-t`/`--grep` beyond node:test's
own `--test-name-pattern`).

Requires Node ≥ 20 and Postgres ≥ 13 (`gen_random_uuid`). `cp .env.example .env`
before running migrate/dev.

**`pnpm migrate` applies the copy in `dist/`, not `src/db/schema.sql`.** `pnpm build`
is what refreshes that copy (`cp src/db/schema.sql dist/db/schema.sql`), so running
`pnpm migrate` against a stale `dist/` applies an OLD schema and still prints
`✓ schema applied` — a silent failure that surfaces later as
`column "…" of relation "players" does not exist`. In development use
**`pnpm migrate:dev`**, which reads `src/` directly. Either way the script now prints
which file it read.

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

**Luanti bridge — the DB is the only password store.** `X-Luanti-Secret`
(`LUANTI_SERVER_SECRET`) gates `src/http/routes/internal.ts`. `luanti_password` holds an
engine-format SRP entry (`#1#salt#verifier`, `domain/crypto.ts::luantiSrpEntry`), written
by both signup surfaces: web `/register` and `POST /internal/luanti-register` (the mod
relays what the engine built for an in-game signup — the plaintext never leaves the
client). The world polls `GET /internal/luanti-auth` every ~2s for **every** named
account plus `can_own`, answers the engine's `get_auth` from that mirror, and calls
`POST /internal/luanti-bind` on join for owners. Changing a password in-game is refused;
the web is the only place it changes. A Luanti-only guest (no `password_hash`, no
`public_key`) can log in on the web with that same Luanti password
(`domain/crypto.ts::luantiSrpVerify` recomputes the SRP verifier, no separate hash is
stored) and can claim ownership through the same `POST /register` — same username,
same password, a conditional `UPDATE` (same race-closing pattern as
`domain/players.ts::claimSelfCustody`) instead of an `INSERT` — which mints a keypair, custody and a starter over the existing row without
touching `luanti_password`. `/register` returns 200 on a claim, 201 on a fresh
registration; any other name collision (wrong password, or a row that already has a
`password_hash`/`public_key`) is still 409 `username_taken`.

**Logging is one wide event per request.** `src/http/wide-event.ts` holds an
`AsyncLocalStorage<WideEvent>`; `wideEventMiddleware` (mounted first in `http/app.ts`) is
the *only* thing that emits a request log line, in `res.on("finish")`. Everything else
calls `enrich({ … })` to add fields to the event already in flight — never `console.*`,
never its own `logger.info`. `enrich` is a no-op outside a request, so domain code stays
callable from `db/migrate.ts` and from the test suites. `path` is the route template
(`/hashimons/:id`), never the resolved URL — that field is what queries group by.
Secrets never enter the event: `redact` in `src/logger.ts` is the backstop, the rule is
`dna_prefix` over `dna` and `safeHost()` over `config.btcNodeUrl`. Only three events live
outside the request cycle: `server_start`, `shutdown` and `block_template_fetch`. See the
logging section in README.md.

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
