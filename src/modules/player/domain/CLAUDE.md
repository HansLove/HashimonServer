# Player — domain

## Overview
Identity: who a player is, how they prove it, and whether they may own creatures.
Also the crypto that backs all three. This is the module the Luanti bridge leans on —
the DB here is the only password store the engine ever sees.

## Entry Points
- `players::findOrCreatePlayer` — create-or-restore identity by public key; anonymous if none given.
- `players::registerOwner` — full web registration: validates species/username/password, mints a starter Hashimon and session in one flow. Also the claim path — see Business Logic.
- `players::loginOwner`, `players::playerForToken` — password login (argon2, or SRP for a Luanti-only guest) and bearer-token resolution used by `core/http/auth.ts`.
- `players::canOwn` — the single gate deciding if a player may own creatures (has `public_key`).
- `players::claimSelfCustody` — migrates an owner from server-held to self-held keys.

## Key Files
- **crypto.ts** — secp256k1 keygen/validation, scrypt+AES-GCM private-key encryption, and Luanti SRP-6a password entries (three unrelated crypto concerns, kept together because `players.ts` needs all three).

## Business Logic
- **The DB is the only password store for Luanti.** `luanti_password` holds an SRP entry (`#1#<b64 salt>#<b64 verifier>`) built by `crypto::luantiSrpEntry`, byte-compatible with the engine's `encode_srp_verifier` — the mod serves it back to the engine instead of letting a local `auth.sqlite` verifier exist. Two writers: `registerOwner` (web) and `registerLuantiGuest` (in-game signup relayed by `POST /internal/luanti-register`, the only hook the engine leaves, since it never reveals the plaintext). The verifier is derived from the **lowercased** name, which is what kills the old casing divergence.
- **A Luanti-only guest can log in and claim ownership on the web, same password, no separate hash ever stored.** `loginOwner` falls back to `crypto::luantiSrpVerify` (recomputes the verifier from the SRP entry's own salt, constant-time compare) whenever `password_hash` is `null` — nothing gets written, the SRP entry is verified fresh on every login. `registerOwner`'s username-collision branch checks if the existing row is a reclaimable guest (`password_hash IS NULL AND public_key IS NULL`); if the supplied password verifies against its `luanti_password`, `claimLuantiGuest` runs the same keypair/custody derivation a fresh registration would (`deriveOwnerKeyMaterial`, extracted so both paths share it) and `UPDATE`s the row instead of inserting one — `luanti_password` itself is never touched. The `UPDATE ... WHERE id = $1 AND password_hash IS NULL AND public_key IS NULL` guard is what closes the race between two concurrent claims, same pattern as `claimSelfCustody`. A wrong claim password or an already-claimed row both fail as the same 409 `username_taken` a genuinely-taken username would — no account-existence leak. `/register` returns 200 for a claim, 201 for a fresh row, distinguished by the `claimed` flag on `registerOwner`'s result.
- **`listLuantiAuthEntries` lists everyone, `can_own` decides ownership.** It returns every row with a username and a password entry, guests included, each carrying `can_own` — the mod needs guests in the mirror to authenticate them at all, so "present in the list" no longer means "is an owner".
- **Ownership gate.** A player can only own creatures (`POST /hashimons`) if `public_key` is set (`players::canOwn`). Anonymous/guest players (Luanti without a key) can play but not own — enforced at the domain layer, not just HTTP.
- **Custody model.** If the caller supplies their own `publicKey`, custody is `"player"` (server never sees the private key). If not, the server generates a keypair and encrypts the private key with a key derived from the account password (`crypto::encryptPrivateKey`) — custody `"server_encrypted"`. `players::claimSelfCustody` lets an owner migrate from server-held to self-held by wiping the encrypted blob.
- **Genesis starters are gated twice.** `registerOwner` requires `speciesKey` to be in the hardcoded `GENESIS_KEYS` set AND pass `hashimon/domain/hashimons.ts::isGenesisSpecies` AND exist in the species table — belt-and-suspenders against a bad species key minting a rare creature as a "starter".

## Dependencies

**Internal:**
- `@/modules/hashimon/domain/hashimons` (`emit`, `isGenesisSpecies`) — `registerOwner` mints the starter creature through the same emission path everything else uses.
- `@/modules/core/db/pool` (`query`, `withTransaction`) — registration and claims are transactional.
- `@/modules/core/domain/audit` — identity mutations record themselves.

**External:**
- `argon2` — password hashing for `password_hash` (registerOwner/loginOwner/claimLuantiGuest). It is unrelated to `luanti_password`, whose format is dictated by the engine (SRP-6a verifier); `loginOwner` verifies that one itself via `luantiSrpVerify` when `password_hash` is absent, rather than treating it as an opaque hash.
- `@noble/secp256k1` — key generation/validation matching the same curve the client/wallet uses.

## Common Pitfalls
- Adding a mutation to `players` without an `audit()` call breaks the append-only trail other tooling assumes exists for every state change.
- Treating `luanti_password` as an opaque hash. It is an SRP verifier with its own salt; verifying it means recomputing through `luantiSrpVerify`, never comparing strings.
