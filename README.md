# Hashimon Server — Phase 1

The authoritative Hashimon server. Its stance, from the [ADR](https://claude.ai/code/artifact/a3d3129d-8e09-43e0-a6c5-b203e5aa2f63):
a **referee, not an oracle**. It does not fabricate creatures or decide outcomes —
it holds the ledger of what has been born and who owns it, and it **verifies**
everything else by recomputing it, because the whole game is deterministic
(DNA = SHA-256, proof of work = re-hashable).

Phase 1 scope: **identity + inventory + the emission ledger**. Proof-of-work
submission (Phase 2), incubation / Caos Engine seeding (Phase 3), credits/payments
(Phase 4) and the MCP layer (Phase 5) build on top of this.

> This is a fresh service. The legacy `../api` (MongoDB + on-chain minting with a
> server key) is the *oracle* model the ADR moves away from and is not used here.

## What's here

```
src/
  core/        The Caos Core — the shared deterministic ruleset.
    sha256.ts    SHA-256 + double-SHA-256 (byte-identical to the client's window.SHA256)
    dna.ts       DNA derivation + nibble readers (port of HashimonDNA)
    pow.ts       leadingZeroBits, share hashing, rank/stage math, verifyShare
    core.test.ts the tests that guard verification parity with the client
  data/
    species.ts   server-side species registry (identity + base stats; keys gate emission)
  db/
    schema.sql   players, sessions, hashimons (emission ledger), audit_log
    pool.ts      pg pool + withTransaction
    migrate.ts   applies schema.sql (idempotent)
  domain/
    players.ts   identity + bearer sessions
    hashimons.ts emission (server-owned birth), inventory, present() (derived view)
    audit.ts     append-only audit log
  http/
    app.ts       express wiring          auth.ts    bearer-session gate
    errors.ts    AppError + JSON errors   routes/    session, profile, hashimons, health
  server.ts      entry point
```

**What the ledger stores vs. derives.** A `hashimons` row holds only *provenance*
(dna, species, birth nonce, algo version) and the *pow biography* (best share, hashes,
etc.). Stats, colour, type and rank are **never stored** — they are derived from
`dna + pow` by the Caos Core on read (`present()`), so they can never drift or be
forged. Change the rules, re-derive; the ledger doesn't need a migration.

**The server owns the birth.** `POST /hashimons` does not accept a client-chosen
nonce. The server generates the birth nonce and derives the DNA itself, so a client
can't grind for a rare identity. `dna` is `UNIQUE` — the anti-duplication guarantee.
(Server-seeded *encounters* — controlling even *which* species you meet — is the
Phase 3 Caos Engine hook that plugs into this same gate.)

## Run it

Requires **Node ≥ 20** and **Postgres ≥ 13** (for `gen_random_uuid`).

```bash
# 1. install deps
yarn install          # see note below on npm in this sandbox

# 2. database
createdb hashimon
cp .env.example .env   # adjust DATABASE_URL if needed
yarn migrate           # or: npm run migrate

# 3. start
yarn start             # http://localhost:4000   (yarn dev for watch mode)
```

Scripts: `dev` (watch), `start`, `migrate`, `typecheck` (`tsc --noEmit`),
`test` (core parity tests).

> **npm note:** on this machine `npm install` dies silently in its reify/extract
> step (an environment quirk, not a dependency problem — `npm view` works, and the
> *core* tests run dependency-free). `yarn install` works and was used to verify
> everything below. Once installed, `npm run <script>` is fine.

## API (Phase 1)

All bodies are JSON. Authenticated routes need `Authorization: Bearer <token>`.

| Method | Path              | Auth | Purpose |
|--------|-------------------|------|---------|
| GET    | `/health`         | –    | liveness + DB round-trip |
| POST   | `/session`        | –    | create-or-restore identity → `{ token, player }` |
| GET    | `/profile`        | ✓    | account state (credits, counts) |
| GET    | `/hashimons`      | ✓    | inventory, each with derived rank + self-verifying proof |
| GET    | `/hashimons/:id`  | ✓    | one owned creature (404 if not yours) |
| POST   | `/hashimons`      | ✓    | **emission gate** — server births a creature of `{ speciesKey }` |

`POST /session` body: `{ publicKey?, displayName? }` (all optional; no key ⇒ a
fresh anonymous identity). `POST /hashimons` body: `{ speciesKey, provenance?, name? }`.

Each creature comes back with derived `tier / stars / stage / progress`, its `pow`
biography, and `verified`: `true` (recomputed and matches), `false` (tampered), or
`null` (born but never mined).

### Quick manual check

```bash
TOKEN=$(curl -s -X POST localhost:4000/session -H 'content-type: application/json' -d '{}' | jq -r .token)
curl -s -X POST localhost:4000/hashimons -H "authorization: Bearer $TOKEN" \
     -H 'content-type: application/json' -d '{"speciesKey":"solarCub"}' | jq
curl -s localhost:4000/hashimons -H "authorization: Bearer $TOKEN" | jq
```

## Verified so far

- `tsc --noEmit` — clean.
- Core parity tests (`npm test`) — SHA-256 vectors, double-hash, DNA determinism +
  exact `template:nonce:species` format, `leadingZeroBits`, rank/stage mapping, and
  `verifyShare` accepting a real share while rejecting a forged one, an over-claim,
  and reporting an unmined creature. Includes a byte-for-byte match against the
  client's DNA convention.
- Boot smoke test (no DB): clean 404 on unknown routes, JSON 500 on a DB-less
  `/health` (no stack leak), 401 on a protected route without a token.
- **Pending local Postgres:** the DB-backed end-to-end (session → emit → inventory).
  Bring up Postgres and run the Quick manual check above.

## Next phases (not built yet)

2. **PoW submission** — `POST /hashimons/:id/shares` verifies a submitted best
   share with `verifyShare` (already in core) before it lets a creature evolve.
3. **Incubation / Caos Engine** — server-owned seed so births can't be grinded.
4. **Credits / payments** — via a provider (Stripe-class), never hand-rolled.
5. **MCP layer** — the player's own AI reads and *suggests*; it never writes
   authoritative state.

Do not grow the Phase-1 bearer sessions into a home-made auth system, and do not
build payments by hand — both carry real security/regulatory weight (see ADR §8).
