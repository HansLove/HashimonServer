# Core — HTTP routes

## Overview

The two routers no single bounded context owns. Every other router lives in its own
module under `src/modules/<domain>/http/routes/`. See
`src/modules/core/http/CLAUDE.md` for the wide-event pipeline, `requireSession`, and
the error-mapping details — not repeated here.

## Key Files

- **health.ts** — liveness probe; no session, no domain call.
- **internal.ts** — the Luanti bridge, gated by `X-Luanti-Secret`
  (`LUANTI_SERVER_SECRET`) rather than `requireSession`. It spans several domains at
  once — identity (`luanti-register`, `luanti-auth`) and ownership (`luanti-bind`) —
  which is why it stays here instead of moving into `player/`.

## Business Logic

**`canOwn` (needs a `public_key`) gates three unrelated things** across three
modules: emitting a Hashimon (`hashimon/http/routes/hashimons.ts`), claiming
self-custody (`player/http/routes/wallet.ts`), and binding a Luanti session
(`internal.ts` here). All three throw the same 403 `cannot_own` — a keyless player
(anonymous `/session` or Luanti guest) cannot do any of them. Changing the gate means
touching all three call sites, which is why it is documented in each.

**The world polls, it does not push.** `GET /internal/luanti-auth` is hit roughly
every 2s for *every* named account plus `can_own`; the mod answers the engine's
`get_auth` from that mirror. Keep the response cheap — it is the highest-frequency
route in the server.
