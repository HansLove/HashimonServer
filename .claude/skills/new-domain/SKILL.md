---
name: new-domain
description: Checklist for integrating a new bounded context into hashimon-server as src/modules/<domain> — naming and subdomain class, layout, router conventions (asyncHandler, zod, requireSession or requireLuantiSecret, enrich, AppError), mounting in core/http/app.ts, idempotent tables in schema.sql, transactions with audit, env vars, a test registered in package.json, and the docs that ship with it (README API table, CLAUDE.md tree, rules, module CLAUDE.md). Use this whenever the user wants a new module, feature area, subsystem, or a set of routes and tables that no existing module owns — "new domain", "nuevo módulo", "nuevo bounded context", "add endpoints and a table for X" — or asks where new server code should live.
---

# Integrate a new domain

A new bounded context touches about eight places, and the ones that get forgotten —
the `package.json` test list, the README API table, the CLAUDE.md tree — are exactly the
ones where nothing fails. Work through the checklist in order. There are no templates on
purpose: the existing modules are the templates, and each step names the one to copy.

| Reference | What to copy from it |
|---|---|
| `src/modules/magi/http/routes/magi.ts` | Internal routes behind the Luanti secret; a 503 `misconfigured` mapping |
| `src/modules/map/http/routes/map-markers.ts` | Player routes behind a session, zod bodies, `enrich` keys |
| `src/modules/payments/domain/payments.ts` | `withTransaction`, `audit()`, once-only transitions in SQL (`settleAndCredit`) |

## 1. Confirm it is new, then name and classify it

- Read the module tree in the root `CLAUDE.md` first. A feature that extends an existing
  context belongs in that module, not in a new one.
- Name the directory in the game's ubiquitous language (`incubation`, `territory`), never
  after a technical role (`jobs`, `webhooks`, `utils`).
- Classify the subdomain, since the tree line carries it: **Core** (what makes Hashimon
  itself — `hashimon`, `mining`, `incubation`), **Supporting** (needed, not the
  differentiator — `player`, `payments`, `map`, ...), or **Generic** (shared machinery —
  that goes into `core/`, not a new module).

## 2. Layout

```
src/modules/<domain>/
  domain/        business logic and its SQL: <domain>.ts, <domain>.test.ts
  http/routes/   <domain>.ts exporting <domain>Router
  data/          only for a static registry, like hashimon/data/species.ts
```

Create only the layers the domain needs. Do not add an `index.ts` barrel; import the file
itself. Every import is `@/modules/...` (`.claude/rules/conventions/code.md`), which is what
keeps later moves between modules cheap.

## 3. Router

`export const <domain>Router = Router();`, shaped like the reference routers:

- Wrap every async handler in `asyncHandler`. Without it a rejection hangs the request
  and never reaches `errorMiddleware`.
- Parse bodies and params with zod at the edge; a `ZodError` already becomes 400
  `bad_request`. Use `.strict()` whenever a smuggled field could matter — anything near a
  price, an amount or an owner.
- Pick the gate:
  - Player-facing: the `requireSession` middleware, then `req.player!`.
  - Called by the Luanti world: path under `/internal/<domain>/...` and
    `requireLuantiSecret(req)` as the handler's first line.
  - Public by design: leave a comment saying why, like `/magi/supply`.
- Add facts to the request's single wide event with `enrich({...})`, keys prefixed by the
  domain (`magi_issued`, `map_marker`). Never `logger` or `console`, never a secret or a
  whole row.
- Fail with `new AppError(status, "functionName: what failed", "snake_code")`. The message
  is for developers; clients branch on `code`, so keep it stable.
- A missing configuration value is a deployment fault, not a client error: throw a domain
  error class and map it to `AppError(503, err.message, "misconfigured")` in a router-level
  error middleware at the end of the router, like the last `magiRouter.use(...)`: map
  `instanceof` your own class and pass everything else on with `next(err)`.

## 4. Mount in `src/modules/core/http/app.ts`

Import the router and `app.use(<domain>Router)` among the other domain routers:

- After `express.json()`. The single exception is a webhook that verifies an HMAC over the
  raw body — it goes before, next to `paymentsWebhookRouter`, with a comment saying why.
- Above `internalRouter`, and never below the 404 handler, where it would be unreachable.

## 5. Tables

Append to `src/modules/core/db/schema.sql`. There are no migrations: the whole file is
re-applied on every start, in production too (the systemd unit's `ExecStartPre` runs
`node dist/modules/core/db/migrate.js` in the image, see the `hashimon_server` IaC role),
so every statement must be idempotent —
`CREATE TABLE IF NOT EXISTS`, `CREATE [UNIQUE] INDEX IF NOT EXISTS`,
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. Put a comment above each table or index stating
the invariant it enforces (see the `caos_lots` indexes). Apply with `pnpm migrate:dev`.

## 6. Mutations

- A mutation with more than one statement runs in `withTransaction(async (client) => ...)`
  and passes `client` to every `query(..., client)` and to `audit(client, {...})`. Leaving
  `client` out silently runs that statement outside the transaction.
- Every ledger state change writes an `audit()` row in the same transaction.
- Once-only rules live in SQL, not in an `if` after a `SELECT` (two requests pass the same
  check): a conditional `UPDATE ... WHERE status <> 'x' RETURNING *`, where only the first
  caller gets a row, or a unique partial index whose `23505` you catch with
  `isUniqueViolation(err, "<index_name>")` and turn into a 409.

## 7. Environment variables

Use the `add-env-var` skill for each one — it carries the variable into the IaC role as
well, which is the part that gets missed.

## 8. Test

- `domain/<domain>.test.ts` with `node:test` and `node:assert/strict`.
- A DB-backed test creates its own fixtures and deletes exactly those by id in `after()`,
  then calls `pool.end()` (see `payments.test.ts`). Never `DELETE FROM <table>` without a
  `WHERE`: the suites run against the developer's own database.
- Add the file to the `test` script in `package.json`. The list is explicit, so an
  unlisted test silently never runs.
- Run it through the `db-tests` skill when it touches the database.

## 9. Docs, in the same change

- `README.md`, `## API`: one table row per route (method, path, auth, purpose, and any
  status code a client must handle), plus a `### <Domain>` subsection when a flow needs
  more than a row.
- Root `CLAUDE.md`: one line in the `src/modules/` tree with the subdomain class and what
  the module owns.
- `.claude/rules/domains/<domain>.md` with `paths: ["src/modules/<domain>/**"]`
  frontmatter — only when the domain has invariants the code does not make obvious
  (`payments.md` is the bar).
- `src/modules/<domain>/domain/CLAUDE.md`: run the `claudify` skill if it is available;
  otherwise follow the sections of `src/modules/core/domain/CLAUDE.md` (Overview, Entry
  Points, Side Effects & Constraints, Common Pitfalls) with `file::Symbol` references.

## 10. Money and custody

If the domain moves `players.credits`, or touches custody material (encrypted keys, KDF
salts):

- Run the `money-flow-reviewer` agent over the diff before calling it done.
- Update the statements about who moves credits in `.claude/rules/domains/payments.md`,
  `.claude/rules/domains/incubation.md` and `src/modules/incubation/domain/CLAUDE.md`,
  which enumerate the movers, and add the new mover's path to the `paths` frontmatter of
  `payments.md` so its invariants load there.

## 11. Verify

- `pnpm typecheck`.
- The new test: `node --import tsx --test src/modules/<domain>/domain/<domain>.test.ts`.
- `pnpm dev`, then one curl per gate: a session route without a token must answer 401
  `unauthenticated`, and with a token from the README's quick manual checks it must
  succeed; an `/internal/...` route needs `-H "X-Luanti-Secret: ..."`. Confirm the request's
  wide event in the dev log carries your `enrich` keys.
