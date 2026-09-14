/**
 * One canonical set of test doubles for the DB seams the adapter introduced
 * across modules: `QueryFn` (players.ts), the mutable `query` binding
 * (map-markers.ts's `__setQueryForTest`, same shape as `QueryFn`), `Sql`
 * (alen.ts, magi.ts), and pool.ts's own `Pick<pg.Pool, "query" | "connect">`
 * params (`waitForDb`, `withTransaction`).
 *
 * Build ONE of these per test instead of hand-rolling a `{ query: async () =>
 * ... }` literal per module — every factory here is structurally assignable
 * to every one of those seam types, so the same double works everywhere a
 * fake DB connection is asked for.
 */
import type pg from "pg";
import type { Sql } from "@/modules/core/db/pool";

/**
 * `prefix-<hrtime>` — the exact technique every DB-backed test in the repo
 * already hand-rolls (wolkers.test.ts, armies.test.ts, auth.test.ts,
 * affiliates.test.ts, payments.test.ts) to avoid colliding with other
 * implementers running DB tests concurrently against the same database.
 */
export function uniqueId(prefix: string): string {
  return `${prefix}-${process.hrtime.bigint().toString(36)}`;
}

/** Builds a complete `pg.QueryResult` — the shape every query double below returns. */
export function queryResult<T extends pg.QueryResultRow = pg.QueryResultRow>(
  rows: T[],
  overrides: Partial<Pick<pg.QueryResultBase, "command" | "oid">> = {}
): pg.QueryResult<T> {
  return {
    rows,
    rowCount: rows.length,
    command: overrides.command ?? "SELECT",
    oid: overrides.oid ?? 0,
    fields: [],
  };
}

export type QueryCall = { text: string; params: unknown[] };
type QueryHandler = (text: string, params: unknown[]) => unknown[] | Promise<unknown[]>;

/**
 * A recorded, swappable query function: `handler` returns the rows for a
 * given statement, `calls` records every invocation for assertions. Declared
 * as an actual generic function (not an arrow bound to one `T`) so it stays
 * assignable to `QueryFn`'s own generic signature at the call site.
 */
export function fakeQuery(handler: QueryHandler = () => []) {
  const calls: QueryCall[] = [];
  async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params: unknown[] = []
  ): Promise<pg.QueryResult<T>> {
    calls.push({ text, params });
    const rows = await handler(text, params);
    return queryResult(rows as T[]);
  }
  return { query, calls };
}

/**
 * Matches `Sql` (`pg.Pool | pg.PoolClient`) for the modules whose seam is
 * `client?: Sql` (alen.ts, magi.ts). `Sql`'s real type is the full pg.Pool /
 * pg.PoolClient surface; a double only ever needs `.query()`, so the cast
 * through `unknown` is the honest way to say "this satisfies what callers
 * actually use", not a full pool/client re-implementation.
 */
export function fakeSql(handler?: QueryHandler): Sql & { calls: QueryCall[] } {
  const { query, calls } = fakeQuery(handler);
  return { query, calls } as unknown as Sql & { calls: QueryCall[] };
}

/** For `pool.ts`'s own `waitForDb(logger, source: Pick<pg.Pool, "query"> = pool)`. */
export function fakePoolQuerySource(handler?: QueryHandler): Pick<pg.Pool, "query"> {
  const { query } = fakeQuery(handler);
  return { query } as unknown as Pick<pg.Pool, "query">;
}

export type FakePoolClient = Pick<pg.PoolClient, "query" | "release"> & { calls: string[] };

/**
 * For `pool.ts`'s `withTransaction(fn, source: Pick<pg.Pool, "connect"> =
 * pool)`. `calls` records every statement text plus `"RELEASE"`, so a test
 * asserts the exact `BEGIN`/`COMMIT`/`ROLLBACK`/`RELEASE` sequence instead of
 * re-deriving it from a live Postgres transaction.
 */
export function fakePoolClient(handler?: QueryHandler): FakePoolClient {
  const { query: innerQuery } = fakeQuery(handler);
  const calls: string[] = [];
  async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params: unknown[] = []
  ): Promise<pg.QueryResult<T>> {
    calls.push(text);
    return innerQuery<T>(text, params);
  }
  return {
    query: query as unknown as pg.PoolClient["query"],
    release: () => {
      calls.push("RELEASE");
    },
    calls,
  };
}

/** Pairs a `fakePoolClient()` with `withTransaction`'s `source` parameter. */
export function fakeConnectSource(client: Pick<pg.PoolClient, "query" | "release">): Pick<pg.Pool, "connect"> {
  return { connect: async () => client as pg.PoolClient } as unknown as Pick<pg.Pool, "connect">;
}
