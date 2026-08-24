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

## Ownership rule

**Poseer = tener llave (`public_key`).** Web `/register` creates an owner (username +
password + secp256k1 + genesis starter). Luanti guests who only click *Registrarse*
in-game have no API key and **cannot** emit or bind a Hashimon roster. They can still
explore the world.

Anonymous `POST /session` remains for 2D/dev; those players also cannot `POST /hashimons`
until they have a `public_key`.

## API

All bodies are JSON. Authenticated routes need `Authorization: Bearer <token>`.
Internal Luanti routes need `X-Luanti-Secret: <LUANTI_SERVER_SECRET>`.

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/health` | – | liveness + DB round-trip |
| POST | `/register` | – | **owner signup** → token + genesis Hashimon + publicKey |
| POST | `/login` | – | username/password → token (+ encrypted privkey blob if custody B) |
| POST | `/session` | – | anonymous / publicKey restore (2D/dev; no ownership) |
| GET | `/profile` | ✓ | account state (`canOwn`, custody, counts) |
| GET | `/hashimons` | ✓ | inventory |
| GET | `/hashimons/:id` | ✓ | one owned creature |
| POST | `/hashimons` | ✓ | emission — **403 `cannot_own` without public_key** |
| POST | `/wallet/claim-self-custody` | ✓ | drop server-held enc private key |
| GET | `/internal/luanti-auth` | secret | owner list `{name, password}` for Luanti poll |
| POST | `/internal/luanti-bind` | secret | `{name}` → bearer session (owners only) |

### `POST /register` (Lovable contract)

```json
{
  "username": "Hans",
  "password": "at-least-8-chars",
  "speciesKey": "genesis_fuego",
  "publicKey": "02…",
  "custody": "player"
}
```

- `username`: same rules as Luanti (`[A-Za-z0-9_-]`, 1–20).
- `speciesKey`: one of `genesis_fuego` | `genesis_agua` | `genesis_aire` | `genesis_tierra` | `genesis_electrico`.
- Omit `publicKey` / `custody` → API generates secp256k1, stores **AES-GCM encrypted** private key (`custody: server_encrypted`).
- Send browser-derived `publicKey` + `custody: "player"` for self-custody (mnemonic step is optional in the UI).

Response includes `{ token, player, publicKey, custody, hashimon }`. Never returns the private key in cleartext.

Use the **same username and password** on the Luanti join screen (IP/port of Hashiworld).

### Luanti bridge

Set `LUANTI_SERVER_SECRET` in API `.env` and the same value as `hashimon_server_secret` in `minetest.conf`. The world polls `/internal/luanti-auth` every ~2s and, on join for cached owners, calls `/internal/luanti-bind` (no password forwarded — the engine already verified the API-published hash).

If a guest name is later registered on the web, **the API password wins** on the next poll.

### Quick manual check (owner)

```bash
curl -s -X POST localhost:4000/register -H 'content-type: application/json' \
  -d '{"username":"Hans","password":"password123","speciesKey":"genesis_fuego"}' | jq
curl -s localhost:4000/internal/luanti-auth -H "X-Luanti-Secret: $LUANTI_SERVER_SECRET" | jq
```

## Logging — one wide event per request

The server does not scatter log lines through a handler. Every HTTP request produces
**exactly one** JSON event, emitted when the response finishes, and every layer that
learns something worth knowing adds a field to that event instead of printing its own
line. Two levels only: `info` for what happened, `error` for what broke.

```bash
curl -s localhost:4000/profile -H "Authorization: Bearer $TOKEN" >/dev/null
# {"level":"info","time":"2026-08-24T18:11:04.812Z","service":"hashimon-server",
#  "env":"development","commit":"9ba76b6","instance":"hashimon-droplet",
#  "core_version":"caos-core@1","algo_version":"caos-core@1","mining_mode":"bound",
#  "event":"http_request","request_id":"3f2a…","method":"GET","path":"/profile",
#  "auth_source":"session","player_id":"…","custody":"server_encrypted","can_own":true,
#  "hashimon_count":3,"credits":0,"status_code":200,"outcome":"success",
#  "duration_ms":12.4,"db_query_count":2,"db_duration_ms":4.1}
```

- **Envelope** (`src/logger.ts`): `service`, `env`, `commit`, `instance`, `core_version`,
  `algo_version`, `mining_mode` — on every event. `commit` comes from `COMMIT_SHA`, baked
  into the image as a build arg (`docker build --build-arg COMMIT_SHA=$(git rev-parse --short HEAD)`).
- **Adding a field**: call `enrich({ … })` from `src/http/wide-event.ts` anywhere inside a
  request — routes, domain code, the error middleware. It is a no-op outside a request, so
  domain functions stay callable from `migrate.ts` and from tests.
- **Emitting is not yours to do.** `wideEventMiddleware` is the only caller of `logger.info`
  for requests; `errorMiddleware` enriches `error_code` and returns.
- **Outside the request cycle** there are three events of their own: `server_start`,
  `shutdown`, and `block_template_fetch` (only on a real RPC round-trip or a failure —
  never on a cache hit, since the fetch is shared across all miners).
- **Never put a secret in an event.** `redact` in `src/logger.ts` is a belt, not the rule:
  identifiers go in prefixed (`dna_prefix`, 8 hex), and `config.btcNodeUrl` — which embeds
  `user:pass@` — is logged only through `safeHost()`.
- **`X-Request-Id`** is returned on every response, so a client report can be matched to
  its event.

## Verified so far

- `tsc --noEmit` — clean.
- Core + auth helper tests (`pnpm test`) — SHA-256 / DNA / PoW parity plus username, Luanti hash, key encrypt round-trip, `canOwn`.
- Owner smoke: `/register` → `/internal/luanti-auth` → `/internal/luanti-bind`; anonymous `POST /hashimons` → 403 `cannot_own`.

## Next phases (not built yet)

3. **Incubation / Caos Engine** — server-owned seed so births can't be grinded.
4. **Credits / payments** — via a provider (Stripe-class), never hand-rolled.
5. **MCP layer** — the player's own AI reads and *suggests*; it never writes
   authoritative state.

Do not build payments by hand — that carries real security/regulatory weight (see ADR §8).
Owner passwords and encrypted keys are intentional for the web↔Luanti bridge; harden
(SRP `#1#`, challenge signing) before treating this as production-grade wallet custody.