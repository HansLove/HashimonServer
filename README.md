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
    schema.sql   players, sessions, hashimons (emission ledger), credits_plans,
                 payments, caos_pricing, caos_lots, audit_log
    pool.ts      pg pool + withTransaction
    migrate.ts   applies schema.sql (idempotent)
  domain/
    players.ts      identity + bearer sessions
    hashimons.ts    emission (server-owned birth), inventory, present() (derived view)
    credit-plans.ts the credit catalogue — the price lives here, never in a request
    payments.ts     charges, webhook transitions, once-only credit settlement
    incubation.ts   the credit sink — lot ledger, mark verification, proportional refunds
    caos-client.ts  the single outbound POST that asks CaosEngine for a batch
    audit.ts        append-only audit log
  http/
    app.ts       express wiring          auth.ts    bearer-session gate
    errors.ts    AppError + JSON errors   routes/    session, profile, hashimons, health,
                                                     payments, payments-webhook,
                                                     incubation, incubation-webhook
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
| POST | `/register` | – | **owner signup** → token + genesis Hashimon + publicKey (200 if claiming a Luanti guest, 201 if new) |
| POST | `/login` | – | username/password → token (+ encrypted privkey blob if custody B); Luanti-only guests log in against their Luanti password |
| POST | `/session` | – | anonymous / publicKey restore (2D/dev; no ownership) |
| GET | `/profile` | ✓ | account state (`canOwn`, custody, counts) |
| GET | `/hashimons` | ✓ | inventory |
| GET | `/hashimons/:id` | ✓ | one owned creature |
| POST | `/hashimons` | ✓ | emission — **403 `cannot_own` without public_key** |
| POST | `/wallet/claim-self-custody` | ✓ | drop server-held enc private key |
| GET | `/payments/plans` | – | the credit catalogue (active plans, in display order) |
| POST | `/payments/btcpay-server/invoice` | ✓ | open a charge from a `sku` — **409 `payment_pending`** if one is already live |
| GET | `/payments/btcpay-server/active` | ✓ | the live charge, or **204** when there is none |
| GET | `/payments/btcpay-server/invoice/:orderId` | ✓ | one charge — what the client polls |
| POST | `/payments/btcpay-server/invoice/:orderId/cancel` | ✓ | give up on a `waiting` charge — **409 `payment_in_flight`** once coins are on the wire |
| POST | `/payments/btcpay-server/webhook` | HMAC | BTCPay callback — **401** on a bad signature |
| GET | `/incubation/pricing` | – | the mark ladder (`creditsPerShare` already net of the tier discount) |
| POST | `/hashimons/:id/incubation` | ✓ | open a lot of `shares` marks — **409 `incubation_pending`** if one is already live |
| GET | `/hashimons/:id/incubation` | ✓ | the live lot, or the one that just closed; **204** when there is neither |
| POST | `/incubation/webhook/:lotSecret` | lot secret | CaosEngine callback — one mark, or the batch's close |
| GET | `/internal/luanti-auth` | secret | account list `{name, password, can_own}` for Luanti poll |
| POST | `/internal/luanti-register` | secret | `{name, password}` → 201 guest row (in-game signup) |
| POST | `/internal/luanti-bind` | secret | `{name}` → bearer session (owners only) |
| GET | `/magi/supply` | – | issued vs. cap, backing sats, epoch (public by design) |
| POST | `/internal/magi/issue` | secret | `{holder, count}` → mint into a vault, **409 `supply_exhausted`** past the cap |
| POST | `/internal/magi/withdraw` | secret | `{holder, count}` → sealed tokens to materialize as items |
| POST | `/internal/magi/deposit` | secret | `{holder, notes[]}` → dematerialize; a note that fails custody is not deposited |
| POST | `/internal/magi/custody` | secret | `{holder, notes[], event}` → verdict per note + rotated token |
| GET | `/internal/magi/holder/:name` | secret | vaulted / materialized counts for one account |

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

If `username` belongs to an existing Luanti-only guest (no `password_hash`, no
`publicKey` yet) and `password` matches that account's Luanti password, this is a
**claim**, not a signup: the existing row gets a keypair/custody and its starter, status
is **200** instead of 201, and `luanti_password` is left untouched. A wrong password or a
username that already has a `password_hash`/`publicKey` both fail as 409
`username_taken` — the response never reveals which.

### Luanti bridge

**The `players` table is the only password store.** Both signup surfaces — web
`/register` and the Luanti join screen — end with one row in `players`, and
`luanti_password` holds an SRP entry the engine can authenticate against directly:
`#1#<b64 salt>#<b64 verifier>`, exactly what `encode_srp_verifier` writes into
`auth.sqlite` (`luanti/src/util/auth.cpp`). The verifier is derived from the
**lowercased** name, so the casing a player types on the join screen can no longer
diverge from the casing stored here.

Set `LUANTI_SERVER_SECRET` in API `.env` and the same value as `hashimon_server_secret`
in `minetest.conf` — without it the mod treats every player as a local guest and the
bridge is silently off.

- The world polls `GET /internal/luanti-auth` every ~2s for **every** named account, not
  just owners, and answers the engine's `get_auth` from that mirror. `can_own` (not mere
  presence in the list) is what marks a player as an owner.
- A player who registers from the Luanti client is pushed to `POST
  /internal/luanti-register` with the entry the engine just built — the engine never
  reveals the plaintext, so this is the only hook available. The row is a guest:
  `username` + `luanti_password`, no `password_hash`, no key, `canOwn: false`.
- **Changing a password in-game is refused** (`/setpassword`); the web is the only place
  a password changes. `auth.sqlite` still owns privileges and `last_login`.
- A Luanti guest who wants to own registers under the **same** username and password on
  `/register` — see the claim paragraph above. A collision with an already-owned name, or
  the wrong password for a guest, is 409 `username_taken` either way.

Owners created before this change still carry the legacy `base64(SHA1(name+password))`
entry until they register again; the engine accepts those through its legacy password
mechanism, but nothing writes that format any more.

### Quick manual check (owner)

```bash
curl -s -X POST localhost:4000/register -H 'content-type: application/json' \
  -d '{"username":"Hans","password":"password123","speciesKey":"genesis_fuego"}' | jq
curl -s localhost:4000/internal/luanti-auth -H "X-Luanti-Secret: $LUANTI_SERVER_SECRET" | jq
```

### Quick manual check (in-game signup)

```bash
ENTRY='#1#CWvgWHs19Sugq+uNeEFcKQ==#MVCq88fj…'   # what the engine hands the mod
curl -s -X POST localhost:4000/internal/luanti-register \
  -H "X-Luanti-Secret: $LUANTI_SERVER_SECRET" -H 'content-type: application/json' \
  -d "{\"name\":\"Hans\",\"password\":\"$ENTRY\"}" | jq
```

### MAGI — the finite cubic object

A MAGI lives as an **item in a Luanti inventory** (`3d-world/mods/hashimon_magi`);
`magi_notes` is the authority on whether that item is real. Two layers:

- **Seal** — HMAC over `(serial, sats, epoch, custody_nonce)` with `MAGI_SEAL_SECRET`,
  which never leaves this process. Catches a fabricated or edited note.
- **Custody nonce** — rotated on *every* check. A seal alone cannot catch duplication:
  a byte-identical clone carries a byte-identical valid seal. Rotation makes custody a
  chain, so once either copy is checked the other presents a retired nonce and is
  destroyed. A dupe glitch leaves **exactly one** surviving MAGI — the server never has
  to decide which copy was the original, because supply is preserved either way.

Verdicts are `ok | stale | forged | unknown | retired`; only those destroy an item.
A transport failure is never a verdict — the mod leaves the note alone and marks it
unverified, so an outage cannot confiscate money. Every check, accepted or rejected,
lands in `magi_custody_log` with the presented nonce and the ledger's sequence number.

Issuance is capped at `MAGI_SUPPLY_CAP` under an exclusive table lock, so two
concurrent mints cannot both take the last note. `reserveSats` is *derived*
(`issued × MAGI_SATS_PER_MAGI`), asserted rather than proven on chain — the reserve is
a public constraint on issuance, not a redemption promise.

```bash
curl -s localhost:4000/magi/supply | jq
curl -s -X POST localhost:4000/internal/magi/issue \
  -H "X-Luanti-Secret: $LUANTI_SERVER_SECRET" -H 'content-type: application/json' \
  -d '{"holder":"Hans","count":2}' | jq
```

### Credit purchases (BTCPay Server)

`players.credits` only ever moves through this flow. The client sends a **`sku`, never
an amount** — the price is read from `credits_plans` on the server, and a body carrying
`amount` or `price` is a 400, not a silently ignored field.

```json
// POST /payments/btcpay-server/invoice   → 201
{ "payment": {
    "orderId": "credits-3f2a…", "status": "waiting",
    "sku": "credits_1200", "credits": 1200, "amountUsd": 10,
    "amountBtc": "0.00008412", "address": "bc1q…",
    "bip21": "bitcoin:bc1q…?amount=0.00008412",
    "checkoutLink": "https://btcpay…/i/…",
    "expiresAt": "2026-08-27T18:05:09.123Z", "settledAt": null } }
```

Six statuses, all decided here: `waiting → confirming → settled | expired | failed |
cancelled` (the last four terminal). The client runs no state machine of its own — the
phase of its UI *is* `status`. `amountUsd` is a number; `amountBtc` stays a decimal
string, because it is money.

Two guarantees live in SQL rather than in an `if` (`src/db/schema.sql`):

- **one live charge per player** — `payments_active_per_player_idx`, a unique partial
  index over `status IN ('waiting','confirming')`. A second concurrent POST gets `23505`,
  which the route turns into 409 `payment_pending` **with the live charge in the body**,
  so the client can offer resume-or-discard without a second round trip.
- **credits granted exactly once** — `UPDATE … WHERE status <> 'settled' RETURNING *`.
  BTCPay redelivers webhooks (`isRedelivery`), so a repeat is the normal case; only the
  first update returns a row, and crediting rides in the same transaction as the audit entry.

**Cancelling is only allowed while `waiting`.** Once the charge is `confirming` BTCPay has
already seen coins, so a cancel there is a mistake every time — it is refused with 409
`payment_in_flight` (an already-terminal charge gives 409 `payment_terminal`). That is not
the last net, though: `settleAndCredit` guards on `status <> 'settled'`, *not* on "not
terminal", so money that actually arrives is credited even to a charge the player cancelled
or that BTCPay let expire. Refusing to honour a real payment over our own bookkeeping would
be the worse bug.

`payments` snapshots `sku`/`credits`/`amount_usd` when the charge opens. Raising a plan's
price never revalues a charge already issued — the FK to `credits_plans` is referential
integrity, nothing more. Plans are edited by SQL; there is no admin CRUD yet.

Webhook events map as: `InvoiceReceivedPayment`/`InvoiceProcessing` → `confirming`,
`InvoiceSettled` → `settled` (+credits), `InvoiceExpired` → `expired`, `InvoiceInvalid` →
`failed`. `InvoiceCreated` and `InvoicePaymentSettled` transition nothing.

### Quick manual check (credit purchase)

The webhook is mounted **before** `express.json()` so the HMAC can be computed over the
raw bytes — the signature covers the exact body, so `--data-raw` must send it byte for byte:

Run it from the project root — `node -e` resolves `@taloon/btcpay-middleware` from
`node_modules`. `SECRET` must be the same value the running server has in
`BTCPAY_WEBHOOK_SECRET`; `node -e` does not read `.env`, so pass it explicitly.

```bash
curl -s localhost:4000/payments/plans | jq

SECRET=smoke-secret   # whatever the server was started with
BODY='{"deliveryId":"d1","webhookId":"w1","originalDeliveryId":"d1","isRedelivery":false,"type":"InvoiceSettled","timestamp":0,"storeId":"s","invoiceId":"inv-demo"}'
SIG=$(BODY="$BODY" SECRET="$SECRET" node --input-type=module \
  -e 'import {computeSignature} from "@taloon/btcpay-middleware";
      process.stdout.write(computeSignature(Buffer.from(process.env.BODY,"utf8"), process.env.SECRET));')

curl -s -X POST localhost:4000/payments/btcpay-server/webhook \
  -H 'content-type: application/json' -H "btcpay-sig: sha256=$SIG" --data-raw "$BODY"
# {"status":"ok"} — send it twice: credits move once.
```

The `sha256=` prefix is required; without it the middleware rejects the header before
comparing anything. Seed a row with that `invoice_id` first, or the webhook is a no-op on an
unknown invoice. Forcing `status` in the DB is also how to walk the client through every
screen without waiting on the Bitcoin network.

**With no `BTCPAY_WEBHOOK_SECRET` set, the route answers 503 and never reaches the
middleware.** That is deliberate: the library verifies the HMAC only `if (webhookSecret)`, so
a blank secret would make this an anonymous credit-minting endpoint, and nothing else about
the app would fail to announce it.

### Known gaps in the payment flow

Recorded rather than fixed — each needs a decision, not just code:

- **No reconciliation against BTCPay.** `applyWebhook` is the only writer of `settled`. If
  every delivery of an `InvoiceSettled` fails (server down through the whole retry window),
  the charge stays `confirming` forever: money in, credits never granted, no alarm.
  `BTCPayClient.getInvoice` exists and is unused — a sweeper over stale `confirming` rows is
  the fix when this matters.
- **Cancelling does not archive the invoice at BTCPay**, which the library exposes no method
  for. A cancelled charge's address stays payable; it still credits if paid
  (`settleAndCredit` guards only on `<> 'settled'`), but orphan invoices accumulate.
- **Buying is gated by `requireSession` only, not `canOwn`.** A keyless anonymous player can
  spend real BTC on credits reachable only through that one bearer token — clear the browser
  storage and they are gone. Deliberate (the checkout is only reachable from the portal, which
  requires `/register` or `/login`), but it is the one value-bearing route with no `canOwn`.

### Assisted incubation (CaosEngine)

The sink for those credits, and the second and last path by which `players.credits` moves.
A player buys **marks of high entropy** — proof of work mined for their creature by
CaosEngine's pool — instead of grinding for them in the browser. A browser reaches ~5 stars
normally and 8 at the ceiling; a bought mark starts at 12.

**Player-facing vocabulary is fixed and narrow**: *encubar*, *incubadora*, *marca*,
*estrellas*, and the outcome is a *mutación*. Never mining, miner, hardware, hashrate,
share, bits or PoW in anything a player reads. `share` remains the technical term in code
and in this file.

The request carries a **count, never an amount**. `caos_pricing` is the ladder, and
`GET /incubation/pricing` publishes it **already multiplied out** — the 10-24 tier arrives
as `creditsPerShare: 9.8, discountPct: 2`, so a client cannot apply the discount a second
time. `discountPct` is a label. Totals: 1 → 10, 10 → 98, 25 → 241, 50 → 475 credits.

```json
// POST /hashimons/:id/incubation  {"shares": 10}   → 201
{ "lot": {
    "id": "1dd93f68…", "status": "assigned",
    "sharesRequested": 10, "sharesDelivered": 0,
    "creditsCharged": 98, "creditsRefunded": 0,
    "starsBefore": 5, "bestStars": 0, "bestShareIndex": null, "mutated": false,
    "createdAt": "…", "assignedAt": "…", "closedAt": null } }
```

Seven statuses, all decided here: `queued → assigned → mining → complete | partial |
failed | expired`. As with payments, the client runs no state machine — the phase of its UI
*is* `status`. A closed lot keeps answering `GET` for 24 hours, because a player who shut
the tab has to find the outcome when they come back.

**Nothing the pool reports is believed.** Every mark is re-hashed from the template
delivered with it (`hashBitcoinJob`), and counted only if three independent checks hold: the
rebuilt header hashes to the hash claimed, the coinbase — which the merkle root commits to —
carries this creature's DNA, **and** the recomputed hash clears the star floor the lot
bought. The second stops a pool billing one player for another's work, or replaying one mark
across every creature it ever mined for. The third is what makes a mark worth paying for at
all: the first two prove a mark is *ours*, not that it cost anything, and a header with
`nonce: 0` carrying the right DNA passes both. Without the floor a pool could deliver fifty
of those, close the lot `complete`, owe no refund, and leave the creature untouched. The
floor is measured on the recomputed hash — `stars` and `leadingZeros` ride in the payload and
are worth exactly as much as any other number a pool reports.

`caos_lots.stars_requested` carries that floor per lot, snapshotted at creation for the same
reason `payments` snapshots its price: changing the product's floor must never revalue a lot
already open. The delivered mark is stored in `hashimons.best_share_bitcoin`, so `present()`
re-verifies it on every read exactly like a browser-mined one; `verified` is `true` or the
mark is not there.

**`mutated` is recorded by the mark that caused it**, never derived on read. It means the
creature's *star* count rose — four bits buy one star, so most new records are invisible on
the creature sheet, and `mutación` is the one word the vocabulary rules do not allow to be
approximate. Deriving it from `stars_before` would have been wrong: that number is frozen
when the lot opens, and a player who keeps incubating in the browser meanwhile leaves it
behind, so a mark the creature had already beaten would still compare favourably against it.

**The delivery count decides how a lot closes.** CaosEngine's own label can agree with the
ledger or lower it, never raise it: a batch it calls `completed` whose marks did not all
reach us — three exhausted webhook retries is enough — closes `partial` here, because the
refund is computed from that same count and a lot cannot be complete and owe money back at
once.

Three guarantees are SQL, not `if`s (`src/db/schema.sql`):

- **one live lot per player** — `caos_lots_active_per_player_idx` over
  `status IN ('queued','assigned','mining')`. This is stricter than the product's
  one-per-creature rule and therefore subsumes it. A second concurrent POST gets `23505` →
  409 `incubation_pending` **with the live lot in the body**.
- **a mark counted once** — `submitted_shares.hash` is the primary key (global dedupe) and
  `submitted_shares_lot_index_idx` closes the other door, so the same position in the same
  lot cannot be counted twice even under two different hashes. CaosEngine redelivers; a
  repeat is the normal case.
- **a refund paid once** — `UPDATE … WHERE status = ANY(live) RETURNING *`. The redelivered
  close event lands on zero rows. `applyShare`'s own lot UPDATE carries the same guard, and
  it is not decoration: a mark that arrives after a stale sweep or a close settled the lot
  would otherwise put it back into `mining`, and a resurrected lot passes the refund's live
  check a second time. That mark is rolled back whole — a delivery after the lot is settled
  leaves no trace of having been counted.
- **a record that only moves up** — the creature's `best_share_*` columns are decided in the
  UPDATE itself (`CASE WHEN $2 > best_share_bits`), against the column and never against a
  value read before the transaction opened. A player browser-incubating while their lot runs
  is two writers on one creature, and the loser of that race must not be able to overwrite a
  better mark with a worse one. The row is also taken `FOR UPDATE` first, so the star count
  before and after come from one view of it.

**Refunds are proportional to what was actually paid**: undelivered marks come back at the
lot's own price, discount included (3 of 10 on a 98-credit lot returns 69). CaosEngine does
not refund us; Hashimon eats the cost of the marks already mined. A lot that never reached
the pool is written off in full, and so is one whose miner hangs.

**The one-hour timeout starts at assignment, not at payment** (`assigned_at`, not
`created_at`). A lot waiting in CaosEngine's queue for lack of energy supply must never
refund itself just for waiting. The longest lot takes ~6 minutes, so an hour is 10x the worst
case — past it the miner is genuinely hung. Note the approximation: CaosEngine exposes no
"a miner picked this up" event, so the clock starts when it answers 202.

`origin` and `caos_lot_id` on `submitted_shares` record where every mark came from. That is
never shown — stars are mined, not bought, and a bought mark is as real as a browser one —
but it is the field a pay-to-win argument, a separate ranking or an audit would need, and it
cannot be reconstructed later.

### Quick manual check (assisted incubation)

`GET /incubation/pricing` is public and needs nothing running but the server. Exercising the
webhook without CaosEngine takes a seeded lot plus the golden vector from
`src/core/core.test.ts` — the same external vector that pins the header byte order:

```bash
curl -s localhost:4000/incubation/pricing | jq
# creditsPerShare must be 9.8 for the 10-24 tier, not 10 — it is published net.

# Seed a player, a creature whose DNA the vector's coinbase commits to, and an assigned lot
# (see the fixtures in src/domain/incubation.test.ts), then deliver one mark:
curl -s -X POST localhost:4000/incubation/webhook/<lot_secret> \
  -H 'content-type: application/json' --data-binary @share.json
# {"received":true,"accepted":true,"duplicate":false} — send it twice: the second is duplicate:true.

curl -s localhost:4000/hashimons/<id> -H "authorization: Bearer <token>" | jq '.verified'
# true — present() recomputed the pool's share and agreed.
```

A close event is the other shape on the same URL:
`{"requestId":"…","status":"partial","sharesDelivered":1,"terminationReason":"…"}`. Send it
twice; the refund moves once. Delivery is counted from the ledger, never from the number the
pool reports — the refund is money, and only verified marks are an honest basis for it.

An unset `CAOS_ENGINE_URL`, `HASHIMON_PUBLIC_URL` or `HASHIMON_COINBASE_ADDRESS` makes
`POST /hashimons/:id/incubation` answer 503 `incubation_unavailable` rather than charge for a
lot with nowhere to send the work.

### Known gaps in the incubation flow

- **CaosEngine does not sign its deliveries.** The lot's 32-byte secret in the URL is the
  entire credential. It is weaker than the BTCPay webhook and accepted knowingly: a forged
  *mark* has to solve the proof of work to be counted, which is the thing being sold. A
  forged *close* is the real exposure, and its worst outcome is refunding the player early —
  never charging them. Ask CaosEngine for an HMAC before this carries more value.
- **`assigned` is inferred from the 202**, not from a real assignment event, so a batch
  queued on CaosEngine's side burns the player's hour. Harmless at today's depth; the fix is
  the event, not a longer timeout.
- **The stale sweep runs on read paths, not on a schedule.** A lot belonging to a player who
  never comes back stays live until someone reads it. It blocks only that player.
- **That sweep is an unindexed scan on a polling endpoint.** `expireStaleLots` runs on every
  `GET /hashimons/:id/incubation`, and its `OR` of two predicates over `created_at` and
  `assigned_at` is not supported by an index of its own — so as terminal lots accumulate,
  each poll pays to sweep every other player's rot. `caos_lots_active_per_player_idx` covers
  the live rows, which are the tiny minority, but the `OR` will still seq-scan. Fine at the
  current ledger size; the fix is a partial index over the live statuses, or scoping the
  sweep to the player being read the way `expireStaleCharges` does.
- **No reconciliation against CaosEngine.** If every delivery of a batch is lost, the lot
  expires and refunds in full — the player is made whole, but the marks are paid for and gone.

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
- Core + auth helper tests (`pnpm test`) — SHA-256 / DNA / PoW parity plus username, Luanti SRP entry (against a vector the engine's own `core.check_password_entry` accepted), key encrypt round-trip, `canOwn`.
- Owner smoke: `/register` → `/internal/luanti-auth` → `/internal/luanti-bind`; anonymous `POST /hashimons` → 403 `cannot_own`.
- Guest smoke: `/internal/luanti-register` → 201, same name in another casing → 409, non-SRP password → 422, then `/login` on that name with the right password → 200, wrong password → 401, then `/register` with the right password → 200 (claimed) and `canOwn: true`.
- Payments smoke (disposable Postgres, no live BTCPay): `pnpm migrate` twice — idempotent, seed not duplicated; a second live charge for one player rejected by `payments_active_per_player_idx`; a status outside the six rejected by the CHECK; signed webhook → 200 and credits +1200, the same delivery repeated → 200 and credits still 1200; wrong signature → 401; `sku` unknown → 400, `amount` in the body → 400, `/active` with nothing live → 204.
- **Not verified:** anything against the real BTCPay instance. No invoice has been created
  or paid end to end — `POST /invoice` has only been exercised against an unreachable
  gateway (correctly → 502 `gateway_error`).
- Incubation unit + ledger tests (`src/domain/incubation.test.ts`, live Postgres): the four
  ladder totals, proportional refunds with the discount carried through, the golden vector
  accepted and a forged hash / swapped merkle branch / wrong creature all rejected, the
  per-player index rejecting a second lot (charging nothing), redelivery not double-counting,
  a partial close refunding exactly once, a queued lot swept and refunded in full, and an
  `assigned` lot surviving five minutes but not three hours. Plus: a genuine, correctly
  committed mark that did no work refused as `below_floor` while the lot stays open; the
  pool's claimed `stars` ignored in favour of the recomputed hash; a mark arriving after the
  lot settled refused and rolled back whole, with the refund not paid twice; a weaker mark
  failing to displace the creature's record; no `mutación` claimed for a mark the creature
  had already beaten, and one reported when a mark really crosses a star; and a batch id
  still claimed when the first mark beat the 202 to the row.
- Incubation smoke (running server, local Postgres, no CaosEngine): `/incubation/pricing`
  publishes the ladder net of discounts; the golden vector delivered to
  `/incubation/webhook/:lotSecret` → `accepted`, repeated → `duplicate`, and
  `GET /hashimons/:id` then returns `verified: true` — `present()` recomputed a pool-mined
  share and agreed. Partial close → `partial` + 10 of 20 credits back, repeated → no second
  payout. `POST` with CaosEngine unreachable → 502 `caos_unavailable` and the full charge
  returned. The lot secret appears in no log line.
- **Not verified:** anything against a real CaosEngine or spoon. No batch has been requested
  or mined end to end.

## Next phases (not built yet)

3. **Incubation / Caos Engine** — server-owned seed so births can't be grinded.
4. **Credits / payments** — buying credits with Bitcoin is built, and so is the first sink:
   assisted incubation (see above). Still missing is any admin surface for either catalogue —
   `credits_plans` and `caos_pricing` are edited by SQL. Fiat, if it ever happens, goes
   through a provider (Stripe-class), never hand-rolled.
5. **MCP layer** — the player's own AI reads and *suggests*; it never writes
   authoritative state.

Do not build payments by hand — that carries real security/regulatory weight (see ADR §8).
Owner passwords and encrypted keys are intentional for the web↔Luanti bridge; harden
(SRP `#1#`, challenge signing) before treating this as production-grade wallet custody.