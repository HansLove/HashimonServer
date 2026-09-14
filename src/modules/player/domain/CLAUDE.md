# Player — domain

## Overview
Identity: who a player is, how they prove it, and whether they may own creatures.
Also the crypto that backs all three. This is the module the Luanti bridge leans on —
the DB here is the only password store the engine ever sees.

## Entry Points
- `players::findOrCreatePlayer` — create-or-restore identity by public key; anonymous if none given.
- `players::registerOwner` — full web registration: validates username/password/dob, derives the starter's species from the date of birth, mints the starter Hashimon and a session. Also the claim path — see Business Logic.
- `players::loginOwner`, `players::playerForToken` — password login (argon2, or SRP for a Luanti-only guest) and bearer-token resolution used by `core/http/auth.ts`.
- `players::canOwn` — the single gate deciding if a player may own creatures (has `public_key`).
- `players::claimSelfCustody` — migrates an owner from server-held to self-held keys.
- `players::rebirthWithBirthDate` — the one-time V1→V2 migration behind `POST /profile/birth`: gives a pre-birth-date account its Birth Identity, archives its V1 starter and mints the birth-date Genesis.

## Key Files
- **crypto.ts** — secp256k1 keygen/validation, scrypt+AES-GCM private-key encryption, and Luanti SRP-6a password entries (three unrelated crypto concerns, kept together because `players.ts` needs all three).

## Business Logic
- **The DB is the only password store for Luanti.** `luanti_password` holds an SRP entry (`#1#<b64 salt>#<b64 verifier>`) built by `crypto::luantiSrpEntry`, byte-compatible with the engine's `encode_srp_verifier` — the mod serves it back to the engine instead of letting a local `auth.sqlite` verifier exist. Two writers: `registerOwner` (web) and `registerLuantiGuest` (in-game signup relayed by `POST /internal/luanti-register`, the only hook the engine leaves, since it never reveals the plaintext). The verifier is derived from the **lowercased** name, which is what kills the old casing divergence.
- **A Luanti-only guest can log in and claim ownership on the web, same password, no separate hash ever stored.** `loginOwner` falls back to `crypto::luantiSrpVerify` (recomputes the verifier from the SRP entry's own salt, constant-time compare) whenever `password_hash` is `null` — nothing gets written, the SRP entry is verified fresh on every login. `registerOwner`'s username-collision branch checks if the existing row is a reclaimable guest (`password_hash IS NULL AND public_key IS NULL`); if the supplied password verifies against its `luanti_password`, `claimLuantiGuest` runs the same keypair/custody derivation a fresh registration would (`deriveOwnerKeyMaterial`, extracted so both paths share it) and `UPDATE`s the row instead of inserting one — `luanti_password` itself is never touched. The `UPDATE ... WHERE id = $1 AND password_hash IS NULL AND public_key IS NULL` guard is what closes the race between two concurrent claims, same pattern as `claimSelfCustody`. A wrong claim password or an already-claimed row both fail as the same 409 `username_taken` a genuinely-taken username would — no account-existence leak. `/register` returns 200 for a claim, 201 for a fresh row, distinguished by the `claimed` flag on `registerOwner`'s result.
- **`listLuantiAuthEntries` lists everyone, `can_own` decides ownership.** It returns every row with a username and a password entry, guests included, each carrying `can_own` — the mod needs guests in the mirror to authenticate them at all, so "present in the list" no longer means "is an owner".
- **Ownership gate.** A player can only own creatures (`POST /hashimons`) if `public_key` is set (`players::canOwn`). Anonymous/guest players (Luanti without a key) can play but not own — enforced at the domain layer, not just HTTP.
- **Custody model.** If the caller supplies their own `publicKey`, custody is `"player"` (server never sees the private key). If not, the server generates a keypair and encrypts the private key with a key derived from the account password (`crypto::encryptPrivateKey`) — custody `"server_encrypted"`. `players::claimSelfCustody` lets an owner migrate from server-held to self-held by wiping the encrypted blob.
- **The starter's species is never chosen.** `registerOwner` derives it from the date of birth (`core/core/birth-identity.ts::birthIdentityOf`), so a client cannot pick a rare Genesis. The body-supplied Genesis gate lives on `POST /hashimons` instead (`hashimon/http/routes/hashimons.ts`, via `isGenesisSpecies`).
- **Rebirth archives, never rewrites.** `rebirthWithBirthDate` guards `canOwn` (403 `cannot_own`), refuses an account that already has `birth_spirit` (409 `birth_already_set`) and `invalid_dob` (422), then claims the identity with `UPDATE players ... WHERE id = $1 AND birth_spirit IS NULL` — the anti-reroll guard and the race closer, same pattern as `claimLuantiGuest`; zero rows is the same 409. The existing starter gets `archived_at`/`archive_reason = 'rebirth_v2'` instead of a new species in place, because `speciesKey` is in the DNA preimage and changing it would break every stored share. The new starter is minted through `emit()` at stage 1 — the PoW biography cannot transfer. Like registration, these writes are not one transaction.
- **Registration is not one transaction.** The player `INSERT` (or the claim `UPDATE`) commits on its own; `emitStarterAndBindSession` then calls `emit()` and `createSession()` outside it and, on failure, runs a best-effort compensation (`DELETE` for a fresh row, revert-to-NULL for a claim) whose own error is swallowed. A crash between the two, or a failed compensation, leaves a half-registered account. A new write after the `INSERT` gets no rollback — add it to the compensation.

## Dependencies

**Internal:**
- `@/modules/hashimon/domain/hashimons` (`emit`, `present`) — `registerOwner` mints the starter creature through the same emission path everything else uses.
- `@/modules/core/db/pool` (`query`, `isUniqueViolation`) — plain autocommit queries; the only transaction in the flow is the one `emit` owns. Once-only claims rely on conditional `UPDATE ... WHERE` guards, not a transaction.
- `@/modules/affiliate/domain/affiliates` (`resolveAffiliateCode`) — `registerOwner` resolves the optional `ref` against the affiliate table before inserting, so `players.referred_by` only ever holds an existing, active code; an invalid one becomes `null` and registration carries on.

**External:**
- `argon2` — password hashing for `password_hash` (registerOwner/loginOwner/claimLuantiGuest). It is unrelated to `luanti_password`, whose format is dictated by the engine (SRP-6a verifier); `loginOwner` verifies that one itself via `luantiSrpVerify` when `password_hash` is absent, rather than treating it as an opaque hash.
- `@noble/secp256k1` — key generation/validation matching the same curve the client/wallet uses.

## Common Pitfalls
- Treating `luanti_password` as an opaque hash. It is an SRP verifier with its own salt; verifying it means recomputing through `luantiSrpVerify`, never comparing strings.
