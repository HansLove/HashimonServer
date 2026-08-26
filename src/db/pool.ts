import pg from "pg";
import { config } from "@/config";
import { elapsedMs, trackDbQuery } from "@/http/wide-event";

//pg numeric types: bigint (int8) comes back as a string by default to avoid
//precision loss. Our bigints (totalHashes, extranonce2) fit in a JS number for
//realistic values, so parse them — but see toSafeInt in domain code for the guard.
pg.types.setTypeParser(20, (v) => Number(v)); //OID 20 = int8

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

export type Sql = pg.Pool | pg.PoolClient;

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

export async function withTransaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
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
