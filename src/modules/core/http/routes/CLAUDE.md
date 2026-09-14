# Core — HTTP routes

## Overview

The two routers no single bounded context owns. Every other router lives in its own
module under `src/modules/<domain>/http/routes/`. See
`src/modules/core/http/CLAUDE.md` for the wide-event pipeline, `requireSession`, and
the error-mapping details — not repeated here.

## Key Files

- **health.ts** — liveness probe; no session, no domain call.
- **internal.ts** — the Luanti bridge, gated by `X-Luanti-Secret`
  (`LUANTI_SERVER_SECRET`) rather than `requireSession`. It is the world's one channel
  into every module — identity (`luanti-register`, `luanti-auth`, `luanti-player-position`),
  ownership (`luanti-bind`), territory (`luanti-territory`, `luanti-towns`, town actions,
  alliances, and the wolker census and council under `luanti-wolkers*`), mining
  (`luanti-vibing-towers`), map (`luanti-map-tiles`, `luanti-map-markers`) and Alen
  (`luanti-alen-*`) — which is why it stays here instead of moving into any one of them.

## Business Logic

**`canOwn` (needs a `public_key`) gates four unrelated things** across three
modules: emitting a Hashimon (`hashimon/http/routes/hashimons.ts`), claiming
self-custody (`player/http/routes/wallet.ts`), binding a Luanti session
(`internal.ts` here) and the V1 -> V2 rebirth (`player/domain/players.ts::rebirthWithBirthDate`,
checked in the domain rather than the route). All four throw the same 403 `cannot_own` — a
keyless player (anonymous `/session` or Luanti guest) cannot do any of them. Changing the
gate means touching all four call sites (`grep -rn "canOwn(" src`).

**The world polls, it does not push.** `GET /internal/luanti-auth` is hit roughly
every 2s for *every* named account plus `can_own`; the mod answers the engine's
`get_auth` from that mirror. Keep the response cheap — it is the highest-frequency
route in the server.
