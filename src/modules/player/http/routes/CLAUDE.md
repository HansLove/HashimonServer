# Player — HTTP routes

## Overview

The identity surface: registration, login, anonymous sessions, wallet custody, and
the profile read. Thin adapters over `player/domain/players.ts` — see
`src/modules/core/http/CLAUDE.md` for the wide-event pipeline and `requireSession`.

## Key Files

- **auth.ts** — `/register` and `/login`. `/register` returns 201 on a fresh
  registration and 200 when it claims an existing Luanti-only guest; any other name
  collision is 409 `username_taken`.
- **session.ts** — anonymous `POST /session`. The player it mints has no
  `public_key`, so it can play but cannot own.
- **wallet.ts** — custody transition and key material.
- **profile.ts** — who am I, how many creatures, how many credits.

## Business Logic

**Wallet custody transition is one-way.** `wallet.ts::POST
/wallet/claim-self-custody` drops the server-held encrypted private key
irreversibly; `custody_before`/`custody_after` are always enriched (even on the
happy path) because the transition has no undo and must leave a trace regardless.

**`canOwn` (needs a `public_key`) gates claiming self-custody here**, and the same
403 `cannot_own` guards emitting a Hashimon and binding a Luanti session in two other
modules — see `core/http/routes/CLAUDE.md` for the full picture.

**A wrong claim password and an already-claimed row fail identically.** Both come
back as the same 409 `username_taken` a genuinely-taken username would, so
`/register` never leaks whether an account exists.
