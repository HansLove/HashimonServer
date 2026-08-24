# HTTP Layer

## Overview

Express wiring, session auth gate, error translation, and the wide-event logging
pipeline. Every route in `routes/` is a thin adapter over `domain/` — validate
input, call domain, enrich the request's event, respond.

## Entry Points

- `app::createApp` — builds the Express app; takes an optional `Logger` so tests
  can point wide events at a sink instead of stdout.
- `auth::requireSession` — the only middleware that proves identity; attaches
  `req.player` and stamps `auth_source`/`custody`/`can_own` on the event.
- `wide-event::enrich` — the sole way any layer (routes, domain, middleware) adds
  fields to the in-flight request event.
- `wide-event::trackDbQuery` — called from `db/pool.ts` to accumulate query count
  and duration onto the event instead of logging per-query.
- `errors::AppError` / `errors::asyncHandler` — the only sanctioned way to fail a
  route; thrown `AppError`s become clean JSON, everything else becomes a leak-free 500.

## Business Logic

**One structured event per request, not scattered log lines.** `wide-event.ts`
opens a `WideEvent` in `AsyncLocalStorage` before any other middleware runs and
emits it exactly once, in `res.on("finish")`. Every layer that learns something —
`requireSession`, route handlers, `errorMiddleware`, `db/pool.ts` — calls `enrich()`
to add a field to that same object; nobody else calls the logger directly. Tests
(`wide-event.test.ts`) assert exactly one JSON line per request as the core contract.

**Ordering is load-bearing.** `wideEventMiddleware` is registered first in
`app::createApp` specifically so CORS rejections, body-parse failures, and 404s all
happen *inside* the event's `store.run()` and land in the same line — moving it
later silently drops those failures from the log.

**Path over URL, always.** The finish handler prefers `req.route` (the matched
route template, e.g. `/hashimons/:id`) over `req.originalUrl`; an unmatched request
falls back to `path: "unmatched"` plus a separate `path_raw`. Never log the raw URL
on a matched route — resolved `:id`s would blow up log cardinality.

**AsyncLocalStorage, not `req.event`.** Chosen because `db/pool.ts` and mining/
domain code never receive a `Request` object, so passing the event down would mean
threading it through signatures that don't otherwise need it. `enrich()` is a no-op
outside a request (`store.getStore()` is undefined) — this is intentional, not a
bug: `db/migrate.ts` and node:test suites call domain code with no event in flight.

**`enrich` merges, `trackDbQuery` accumulates.** Fields set via `enrich` overwrite;
`db_query_count`/`db_duration_ms` add up across the whole request instead of one
line per query. Transaction control (BEGIN/COMMIT/ROLLBACK) bypasses this counter
deliberately.

**Auth model:** `requireSession` (bearer token via `Authorization` header) is the
only way a request proves identity for the public API. `internal.ts` uses a
separate secret-header gate (`X-Luanti-Secret`, constant-time compared) for the
Luanti bridge, and stamps `auth_source: "luanti"` instead. `auth_source` defaults to
`"none"` on the event and is always overwritten by whichever gate actually ran.

**Emission gating (`routes/hashimons.ts`):** `POST /hashimons` requires
`canOwn(player)` (a public key), rejects unknown species, and additionally enforces
genesis species must use `provenance: "starter"` and only once per player
(`countStarterEmissions >= 1` → 409). The server derives the birth nonce/DNA itself
via `domain::emit` — a client-chosen nonce is never accepted (anti-grinding).

**Error taxonomy on shares (`POST /hashimons/:id/shares`):** `submitShare`'s
`outcome.error` maps to specific HTTP codes — `stale_job`/`duplicate_share` → 409,
`under_target` → 422, `dna_mismatch` → 400 — because each represents a different
class of client behavior (retry vs. cheat vs. race), not a single generic failure.

## Dependencies

**Internal:**
- `@/domain/players`, `@/domain/hashimons`, `@/domain/mining` — routes are thin
  adapters; all business logic and DB access live there, not in `http/`.
- `@/logger` — default pino instance; overridable per-app for tests.

**External:**
- `zod` — request body validation; every route with a body parses through a schema
  before touching domain code (fail fast at the boundary).
- `cors` — origin is `config.corsOrigin`, `credentials: true` (bearer tokens are
  sent, not cookies, but the frontend still needs the header echoed).

**Environment Variables:**
- `LUANTI_SERVER_SECRET` — missing → `/internal/*` routes 503 "misconfigured"
  instead of silently accepting requests.

## Failure Modes

- A client that aborts mid-request never fires `finish`, so it produces **no event
  at all**. Known and accepted (the plan specifies `finish`); `res.on("close")`
  is the upgrade path if aborted requests ever need to be visible.
- An async route body not wrapped in `asyncHandler` rejects into an unhandled
  promise instead of reaching `errorMiddleware`: the response hangs, no
  `error_code` is enriched, and the event only lands when the socket times out.
- `timingSafeEqual` throws on length-mismatched buffers — `internal.ts` checks
  buffer length equality before calling it, not just secret equality.
