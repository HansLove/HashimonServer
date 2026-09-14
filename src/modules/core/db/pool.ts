import pg from "pg";
import type pino from "pino";
import { config } from "@/modules/core/config";
import { elapsedMs, trackDbQuery } from "@/modules/core/http/wide-event";

//pg numeric types: bigint (int8) comes back as a string by default to avoid
//precision loss. Our bigints (totalHashes, extranonce2) fit in a JS number for
//realistic values, so parse them — but see toSafeInt in domain code for the guard.
pg.types.setTypeParser(20, (v) => Number(v)); //OID 20 = int8

export const pool = new pg.Pool({ connectionString: config.databaseUrl, connectionTimeoutMillis: 5_000 });

const DB_CONNECT_MAX_ATTEMPTS = 10;
const DB_CONNECT_RETRY_DELAY_MS = 3_000;

//`source` defaults to the real pool so production behavior is unchanged; a test
//substitutes a `{ query }` double here instead of needing a live Postgres to
//exercise the retry/backoff loop and the final-attempt failure branch.
export async function waitForDb(logger: pino.Logger, source: Pick<pg.Pool, "query"> = pool): Promise<void> {
  for (let attempt = 1; attempt <= DB_CONNECT_MAX_ATTEMPTS; attempt++) {
    try {
      await source.query("SELECT 1");
      logger.info({ event: "db_connected", attempt });
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt === DB_CONNECT_MAX_ATTEMPTS) {
        logger.error({ event: "db_connect_failed", attempt, max_attempts: DB_CONNECT_MAX_ATTEMPTS, error: message });
        throw new Error(`waitForDb: could not reach the database after ${DB_CONNECT_MAX_ATTEMPTS} attempts: ${message}`);
      }
      logger.warn({ event: "db_connect_retry", attempt, max_attempts: DB_CONNECT_MAX_ATTEMPTS, error: message });
      await new Promise((resolve) => setTimeout(resolve, DB_CONNECT_RETRY_DELAY_MS));
    }
  }
}

export type Sql = pg.Pool | pg.PoolClient;

//The seam domain modules inject instead of importing `query` directly: a test
//double only has to be a function with this shape, never a full pg.Pool/PoolClient.
export type QueryFn = <T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[]
) => Promise<pg.QueryResult<T>>;

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
  client: Sql = pool
): Promise<pg.QueryResult<T>> {
  const startedAt = process.hrtime.bigint();
  try {
    return await client.query<T>(text, params as never[]);
  } finally {
    //Aggregate, never per query: the request's wide event carries the totals. A
    //failed query still counts — its time is time the request spent.
    trackDbQuery(elapsedMs(startedAt));
  }
}

//Run a set of statements in one transaction, rolling back on any error. Used by
//emission so the ledger row and its audit entry commit together or not at all.
export type DbClient = pg.PoolClient;

//`source` defaults to the real pool so every existing caller keeps its exact
//current behavior; a test substitutes a `{ connect }` double here to exercise
//the commit and rollback-on-error branches without a live Postgres.
export async function withTransaction<T>(
  fn: (client: DbClient) => Promise<T>,
  source: Pick<pg.Pool, "connect"> = pool
): Promise<T> {
  const client = await source.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** pg unique_violation (23505), optionally narrowed to one constraint/index name. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (!err || typeof err !== "object" || (err as { code?: string }).code !== "23505") { return false; }
  return constraint === undefined || (err as { constraint?: string }).constraint === constraint;
}
