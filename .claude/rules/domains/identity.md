---
paths:
  - "src/modules/player/**"
  - "src/modules/core/http/auth.ts"
  - "src/modules/core/http/routes/internal.ts"
---

# Identity, sessions and the Luanti bridge

**Auth model.** Deliberately thin bearer sessions (`sessions` table, `token` PK) —
`requireSession` (`core/http/auth.ts`) is the *only* way a request proves identity;
swap for a real provider before production. **Poseer = tener llave (`public_key`).**
Web `/register` creates an owner (username + password + secp256k1 keypair + genesis
starter, `custody: server_encrypted` or `player`). Anonymous `POST /session` and
Luanti guests without a `public_key` can play but **cannot** `POST /hashimons` (403
`cannot_own`) — see `canOwn` in `player/domain/players.ts`.

**Luanti bridge — the DB is the only password store.** `X-Luanti-Secret`
(`LUANTI_SERVER_SECRET`) gates `src/modules/core/http/routes/internal.ts`. `luanti_password` holds an
engine-format SRP entry (`#1#salt#verifier`, `player/domain/crypto.ts::luantiSrpEntry`), written
by both signup surfaces: web `/register` and `POST /internal/luanti-register` (the mod
relays what the engine built for an in-game signup — the plaintext never leaves the
client). The world polls `GET /internal/luanti-auth` every ~2s for **every** named
account plus `can_own`, answers the engine's `get_auth` from that mirror, and calls
`POST /internal/luanti-bind` on join for owners. Changing a password in-game is refused;
the web is the only place it changes. A Luanti-only guest (no `password_hash`, no
`public_key`) can log in on the web with that same Luanti password
(`player/domain/crypto.ts::luantiSrpVerify` recomputes the SRP verifier, no separate hash is
stored) and can claim ownership through the same `POST /register` — same username,
same password, a conditional `UPDATE` (same race-closing pattern as
`player/domain/players.ts::claimSelfCustody`) instead of an `INSERT` — which mints a keypair, custody and a starter over the existing row without
touching `luanti_password`. `/register` returns 200 on a claim, 201 on a fresh
registration; any other name collision (wrong password, or a row that already has a
`password_hash`/`public_key`) is still 409 `username_taken`.
