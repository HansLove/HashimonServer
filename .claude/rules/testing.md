---
paths:
  - "**/*.test.ts"
  - "**/*.spec.ts"
  - "**/*.test.tsx"
---

# Testing

## How to Run Tests

- **Run tests**: `pnpm test` (node:test via `node --import tsx --test --test-concurrency=1` over the suite list in package.json; DB-backed suites need a live Postgres)
- **Single file**: `node --import tsx --test src/modules/<domain>/domain/<file>.test.ts` (filter with `--test-name-pattern`)
- **Run with coverage**: `node --import tsx --test --experimental-test-coverage src/modules/<domain>/domain/<file>.test.ts`
- **Watch mode**: `node --import tsx --test --watch src/modules/<domain>/domain/<file>.test.ts`
- **New test file**: add its path to the `test` script in package.json. The script lists files explicitly, so a file left off the list never runs.

## Test Organization

- **Location**: co-located next to the source (`src/modules/<domain>/domain/foo.ts` -> `foo.test.ts`); shared doubles in `src/test/support/`
- **Naming convention**: kebab-case `foo.test.ts`
- **Structure**: `node:test` (`test`, or `describe`+`it`) + `node:assert/strict`; no Jest/Vitest
- **Test names**: `"<function>: <case> — <expected behavior>"`, where case is `degenerate`, `simple`, `general`, `edge` or `error`
- **Sections**: group each function's tests under a `// ----` banner comment naming the function and whether it is pure or touches the DB
- **Imports**: `@/` aliases only, never relative

## Test Utilities

- **Location**: `src/test/support/`: `db.ts` (query/pool doubles), `fixtures.ts` (real-DB seeds), `llm.ts` (model doubles)
- **Available**:
  - `uniqueId(prefix)` (helper, db.ts): `prefix-<hrtime>` for collision-free names in DB tests
  - `queryResult(rows, overrides?)` (builder, db.ts): a complete `pg.QueryResult`, for use inside custom handlers
  - `fakeQuery(handler?)` (mock, db.ts): `{ query, calls }`; fits `QueryFn` (players.ts) and `__setQueryForTest` (map-markers.ts); `calls` records `{text, params}`
  - `fakeSql(handler?)` (mock, db.ts): fits the `client?: Sql` seam in alen.ts and magi.ts
  - `fakePoolQuerySource(handler?)` (mock, db.ts): fits the `source` param of `waitForDb(logger, source)` (retry/backoff branches)
  - `fakePoolClient(handler?)` + `fakeConnectSource(client)` (mock, db.ts): fits the `source` param of `withTransaction(fn, source)`; assert `client.calls` equals `["BEGIN", ..., "COMMIT"|"ROLLBACK", "RELEASE"]`
  - `seedPlayer(overrides?, client?)` (builder, fixtures.ts): real INSERT with a unique display_name
  - `seedHashimon(ownerId, overrides?, client?)` (builder, fixtures.ts): real INSERT with a random 64-hex dna (dna is UNIQUE)
  - `randomDna()` (helper, fixtures.ts): `crypto.randomBytes(32).toString("hex")`
  - `deletePlayers(ids)` (helper, fixtures.ts): cleanup in `after()`; cascades to hashimons, then `await pool.end()`
  - `fakeAskModel(reply?)` (mock, llm.ts): fits `ChatDeps.askModel` in companion/chat.ts; no network, no API key
  - `fakeAskModelStructured(data, overrides?)` / `fakeAskModelStructuredNull(raw?)` (mock, llm.ts): fit `deps.askModel` in alen-planner.ts and alen-chat.ts
- **Convention**: reuse before creating; extract a new builder/helper/custom assertion into `src/test/support/` as soon as two tests share setup. Never hand-roll a `{ query: async () => ... }` literal per file.

## Coverage

- **Target**: 85% line coverage per module (every retrofitted module reached 93-100%)
- **Coverage report**: `node --import tsx --test --experimental-test-coverage <test files>`
- **Exclusions**: bootstrapping (`src/server.ts`, `core/db/migrate.ts`, `core/http/app.ts` wiring), `core/config.ts`, `core/logger.ts`, the LLM network gateway `companion/domain/anthropic.ts` (faked at its seam), and type-only declarations

## Patterns Established

- **Dependency seams over module mocking**: production code takes an optional, defaulted dependency (`client: Sql = pool`, `source: Pick<pg.Pool,"connect"> = pool`, a `deps.askModel` object, a `db: QueryFn` param, `__setQueryForTest`). Tests pass a double through that parameter.
- **The real DB is never mocked for data-layer behavior**: emission, ledgers, credits and SQL guards run against local Postgres with `seedPlayer`/`seedHashimon` and `after()` cleanup. Fakes are only for branches a live DB cannot reach easily: retries, rollback, connection failure.
- **Tolerate concurrent suites**: unique names and dna on every seed, never fixed IDs or table truncation
- **Pure functions first**: pure logic (`decideCharge`, `present`, `parseCompanionReply`) is tested with no I/O and no config import
- **Global fetch**: stub it with `t.mock.method(globalThis, "fetch", ...)`, which restores automatically per test (caos-client.test.ts)
- **Env-dependent modules**: fill gaps with `process.env.X ??= "..."` (never override real config), then `await import(...)` the module under test (caos-client.test.ts, magi.test.ts)
- **Transaction sequence assertions**: check the exact BEGIN/COMMIT/ROLLBACK/RELEASE order through `fakePoolClient`
- **Parity guards**: core.test.ts pins sha256/dna/yield-map byte-parity with the client's copy

## What to Test

- Money paths: credit debits, refunds, charge transitions, commission accrual, and all-or-nothing transactions
- Verification logic: share re-hashing, DNA commitment, star floors, dedupe; anything the server must not trust from a client or pool
- Deterministic derivations (`present()`, temperament, wellbeing, zones): same input gives the same output
- Error paths: `AppError`/`ChatDenied` codes, 409 conflicts, provider failures that happen before any DB write
- Edge boundaries: exact-cost credits, TTL expiry, unique-constraint (`23505`) retries, empty or `null` inputs
- The "degenerate / simple / general / edge / error" case set for each exported function

## What NOT to Test

- Entry points and bootstrapping (`server.ts`, `migrate.ts`, express wiring)
- Config parsing and logger setup
- Real LLM or CaosEngine network calls: fake them at the seam
- The BTCPay HMAC signature check, which `@taloon/btcpay-middleware` owns
- Type-only files and data registries with no logic, beyond the gate behavior they drive (e.g. species keys gating `emit`)
- Private implementation details that no exported function exposes
