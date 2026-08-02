import { query, type Sql } from "../db/pool";

//Append one row to the audit log. Pass the transaction client so the audit entry
//commits atomically with the mutation it records.
export async function audit(
  client: Sql,
  entry: { playerId?: string | null; hashimonId?: string | null; action: string; detail?: unknown }
): Promise<void> {
  await query(
    `INSERT INTO audit_log (player_id, hashimon_id, action, detail)
     VALUES ($1, $2, $3, $4)`,
    [entry.playerId ?? null, entry.hashimonId ?? null, entry.action, JSON.stringify(entry.detail ?? {})],
    client
  );
}
