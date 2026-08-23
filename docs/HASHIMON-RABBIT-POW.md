# Rabbit Mining → Hashimon Integration

Technical reference for replacing Hashimon's simulated local PoW with real proof-of-work (browser grind + server verify), using Rabbit/Spoon as architectural reference.

## Quick links

| Document | Purpose |
|----------|---------|
| [docs/HASHIMON_ADN_Y_EVOLUCION.md](./HASHIMON_ADN_Y_EVOLUCION.md) | ADN, compilador, evolución PoW, genesis elemental (español) |
| [docs/POW_SPEC.md](./POW_SPEC.md) | Byte-level PoW spec + golden test vectors |
| [server/src/core/pow.ts](../server/src/core/pow.ts) | `hashJob`, `verifyShare`, `leadingZeroBits` |
| [server/src/domain/hashimons.ts](../server/src/domain/hashimons.ts) | Job issuance + share submission |
| [game/src/content/hashimonMining.js](../game/src/content/hashimonMining.js) | Browser client (fetch job → grind → POST) |

## Executive summary

Rabbit Mining in Block-Lotto is **not** browser PoW. It rents hashrate via `POST /rabbit/shots/request` → Caos Engine → Spoon, with results on `POST /api/v1/webhook/entropy`. The API trusts webhook nonces and never recomputes hashes.

Hashimon uses the **referee model**: the client grinds; the server recomputes and rejects bad shares. Implementation lives in `server/` and `game/` with **bound mode** PoW:

```
hash = doubleSha256(UTF-8 `${dna}:${extranonce1}:${extranonce2}:${nonce}`)
valid ⇔ leadingZeroBits(hash) >= shareTargetBits (default 12)
```

`extranonce1 = first 8 hex of dna` (same constraint as Rabbit `seed`).

Full Bitcoin header validation (`hashBitcoinJob`) is included for future Spoon job templates — see Spoon reference at `Spoon.energy/private-mini-spoon/mp/mining.service.js`.

## Architecture

```mermaid
sequenceDiagram
  participant Game as game_browser
  participant HS as hashimon_server
  User->>Game: Mine
  Game->>HS: GET /hashimons/:id/job
  HS-->>Game: job + shareTargetBits + extranonce1
  Game->>Game: mineBurst ~260ms
  Game->>HS: POST /hashimons/:id/shares
  HS->>HS: verifyShare recompute
  HS-->>Game: verified progression
```

Rabbit async flow (reference only): see [RABBIT_MINING_HIGH_QUALITY.md](../RABBIT_MINING_HIGH_QUALITY.md).

## API contract (Hashimon server)

Base URL default: `http://localhost:4000`

### `POST /hashimons`

Create creature (emission).

```json
{ "templateId": "tmpl-v1", "birthNonce": "uuid", "speciesKey": "bee" }
```

### `GET /hashimons/:id/job`

Returns active mining job (15 min TTL).

### `POST /hashimons/:id/shares`

```json
{ "jobId": "...", "extranonce2": 9003, "nonce": 30, "hash": "0008..." }
```

Errors: `stale_job` (409), `under_target` (422), `duplicate_share` (409), `dna_mismatch` (400).

## Dev setup

```bash
# Hashimon server
cd server && cp .env.example .env && pnpm install && pnpm dev

# Rabbit stack (reference / pool economics)
cd api && pnpm dev
cd engine && npm run dev
cd front-rabbit-mining && pnpm dev
```

Env: `HASHIMON_SHARE_TARGET_BITS=12` (calibrated for ~260ms bursts @ ~100k H/s).

## Mapping Hashimon ↔ Rabbit

| Hashimon | Rabbit | Notes |
|----------|--------|-------|
| `dna` | — | Bound via `extranonce1` |
| `extranonce2` | Spoon internal counter | Client counter |
| `templateId` | weak | `jobId` for TTL |
| `birthNonce` | — | Identity only |
| `bestShareHash/Bits` | webhook `hash`/`leadingZeros` | Server recomputes |

## Implementation checklist

- [x] POW spec + test vectors (`hashimon/POW_SPEC.md`)
- [x] `pow.ts` with verify + Bitcoin path stub
- [x] `GET job` / `POST shares` endpoints
- [x] Browser `HashimonMining` client
- [x] Dev target calibration (`shareTargetBits=12`)

## Risks

| Risk | Mitigation |
|------|------------|
| mini-PoW byte spec drift | Golden tests in `server/tests/pow.test.ts` |
| Stale jobs | 15 min TTL + refetch on 409 |
| Client lies about hash | Server always recomputes |
| DNA vs BTC template | Bound mode wrapper (current MVP) |
