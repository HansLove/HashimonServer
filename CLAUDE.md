# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The authoritative Hashimon server: a **referee, not an oracle**. It never fabricates
creatures or decides outcomes — it holds the emission ledger (who owns what) and
**verifies** everything else by recomputing it, since the whole game is deterministic
(DNA = SHA-256, proof of work = re-hashable). See the ADR linked in README.md for the
full rationale.

Phase 1 (current) scope: identity + inventory + emission ledger + bound-mode PoW
mining, buying credits with Bitcoin through BTCPay, and the first sink for those credits —
assisted incubation, where CaosEngine's pool mines high-entropy shares for a creature.
Real proof-of-work submission against a live bitcoin/pool target, Caos Engine encounter
seeding, and an MCP layer are later phases layered on top of this — do not build them
speculatively.

**Player-facing vocabulary for incubation is fixed and narrow.** Never mining, miner,
hardware, hashrate, share, bits or PoW in anything a player reads: it is *encubar*,
*encubación asistida*, *incubadora*, *marca*, *estrellas*, and the outcome is a *mutación*,
never an "evolution" or an "improvement". Inside the code and in these docs `share` stays
the technical term.

## Commands

```bash
pnpm install          # package manager is pnpm — enforced via preinstall (only-allow)
pnpm dev               # tsx watch src/server.ts
pnpm build             # tsc --noEmit, then esbuild bundle to dist/, copies schema.sql
pnpm start             # node dist/server.js (run build first)
pnpm migrate:dev       # applies src/modules/core/db/schema.sql directly — USE THIS in development
pnpm migrate           # node dist/modules/core/db/migrate.js — applies dist/modules/core/db/schema.sql (idempotent)
pnpm typecheck         # tsc --noEmit
pnpm test              # node --import tsx --test over the suites listed in package.json
                       # (every suite that imports core/db/pool or test/support/fixtures
                       # is DB-backed and needs a live Postgres — most domain suites)
```

Run a single test file directly: `node --import tsx --test src/modules/core/core/core.test.ts`
(node:test files, not a test-runner framework — no `-t`/`--grep` beyond node:test's
own `--test-name-pattern`).

Requires Node ≥ 20 and Postgres ≥ 13 (`gen_random_uuid`). `cp .env.example .env`
before running migrate/dev.

**`pnpm migrate` applies the copy in `dist/`, not `src/modules/core/db/schema.sql`.** `pnpm build`
is what refreshes that copy (`cp src/modules/core/db/schema.sql dist/modules/core/db/schema.sql`), so running
`pnpm migrate` against a stale `dist/` applies an OLD schema and still prints
`✓ schema applied` — a silent failure that surfaces later as
`column "…" of relation "players" does not exist`. In development use
**`pnpm migrate:dev`**, which reads `src/` directly. Either way the script now prints
which file it read.

## Architecture

**Feature-first, not layer-first.** `src/modules/` holds one directory per bounded
context, and each carries its own layers inside (`domain/`, `http/routes/`, `data/`).
Listing the module root reads like the game, not like an Express scaffold. A feature
lives in one directory; only genuinely shared machinery sits in `core/`.

```
src/server.ts   Entry point — the only file at the root of src/.
src/modules/
  core/         Generic subdomain: what every other module leans on, plus the HTTP
                wiring itself.
    core/       The Caos Core — versioned, deterministic ruleset shared with the
                client. sha256.ts (byte-identical to client's window.SHA256), dna.ts
                (DNA derivation), pow.ts (leadingZeroBits, share hashing, rank/stage
                math, verifyShare/verifyJobShare, evaluateYield), yield-map.ts
                (zona(x,z) — the tier a map coordinate yields, byte-identical to the
                web's copy). Imported to VERIFY, not to decide — the client runs an
                equivalent copy to play. core.test.ts guards parity.
    db/         pool.ts (pg pool + withTransaction), schema.sql (source of truth for
                tables), migrate.ts (applies schema.sql, idempotent — no migrations).
    http/       app.ts (express wiring), auth.ts (requireSession bearer gate),
                errors.ts (AppError + errorMiddleware), wide-event.ts,
                luanti-secret.ts, routes/ (health.ts + internal.ts — the only two
                routers no single domain owns).
    domain/     audit.ts, the append-only log written by hashimon, mining, payments
                and incubation.
    config.ts   Env var parsing — single source for all runtime config.
    logger.ts   pino setup; `redact` is the secrets backstop.
  hashimon/     Core subdomain — emission/birth, inventory, present() derived view.
                data/species.ts is the registry whose keys gate emission.
  mining/       Core subdomain — PoW job issuance + share submission, the yield harvest
                (pow_yield: the Hashi-croquetas creatures and towns both eat), vibing.ts
                (tower projection whose map zone decides a harvest's tier), foods.ts
                (the food graph — which item a harvest yields within its tier),
                block-template.ts, bitcoin-address.ts.
  incubation/   Core subdomain — the lot ledger (the credit sink) and caos-client.ts,
                the single outbound call.
  player/       Identity + bearer sessions, crypto.ts, and the auth / session / wallet /
                profile routers.
  payments/     Charges + webhook transitions, credit-plans.ts (the catalogue — where a
                price comes from).
  affiliate/    Two-level affiliate book — referral codes resolved at /register,
                commissions accrued inside the payment's settle transaction, and the
                router behind the partners portal.
  companion/    chat.ts, chat-helpers.ts, companion.ts, anthropic.ts (also the LLM
                gateway alen/ and territory/ call).
  territory/    Towny projection (territory.ts, diplomacy.ts) and the town simulation
                on top of it: wolkers.ts (native population), wolker-council.ts
                (posture, rule-first) and armies.ts (the Risk layer) with its router.
  map/          map-markers.ts, map-tiles.ts.
  magi/         magi.ts.
  alen/         alen.ts (order channel + state), alen-planner.ts, alen-chat.ts.
```

## Full API reference and manual smoke-test commands

See README.md — it documents every route (auth requirements, request/response
shapes for `/register`, `/login`, `/session`, `/hashimons`, `/wallet/*`,
`/internal/*`), the `POST /register` contract in full, and curl-based smoke checks.
Don't duplicate that table here; read it before touching `src/modules/*/http/routes/`.

## Do not build by hand

Per README/ADR: payments must go through a provider, never hand-rolled — this carries
real security/regulatory weight. Crypto goes through BTCPay via
`@taloon/btcpay-middleware` (which owns the HMAC verification); fiat, if it ever
happens, goes through a Stripe-class provider. **Never verify a signature, compute a
rate, or reconcile a payment by hand.** Owner passwords and encrypted keys are an
intentional stopgap for the web↔Luanti bridge, not production-grade wallet custody
as-is.

Known gaps in both money flows are recorded, not closed — see *Known gaps in the
payment flow* and *Known gaps in the incubation flow* in README.md before assuming
something is missing by accident.
