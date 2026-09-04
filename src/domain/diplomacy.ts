import { query } from "@/db/pool";

// Meta-diplomacy between towns — Towny has no nations/alliances, so this layer is the
// API's own. A pair is stored canonically (town_a < town_b) so one row = one relation.
// An alliance is a PEACE PACT: the Luanti world reads the active ones and won't declare
// war or allow attacks between allied towns. proposed → active on the other side accepting.

export interface AllianceRow {
  id: number;
  town_a: string;
  town_b: string;
  status: "proposed" | "active";
  proposed_by: string;
}

/** Canonical ordering, so (A,B) and (B,A) address the same row. */
function pair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/** Resolve a user-typed town name to its canonical spelling (case-insensitive), or null
 *  if no such town exists in the snapshot. Keeps "brújula" and "Brújula" the same pact. */
export async function resolveTownName(name: string): Promise<string | null> {
  const r = await query<{ town_name: string }>(
    `SELECT town_name FROM town_claims WHERE lower(town_name) = lower($1) LIMIT 1`,
    [name]
  );
  return r.rows[0]?.town_name ?? null;
}

export async function getAlliance(a: string, b: string): Promise<AllianceRow | null> {
  const [lo, hi] = pair(a, b);
  const r = await query<AllianceRow>(
    `SELECT id, town_a, town_b, status, proposed_by FROM town_alliances
      WHERE town_a = $1 AND town_b = $2`,
    [lo, hi]
  );
  return r.rows[0] ?? null;
}

export async function insertProposal(from: string, to: string): Promise<void> {
  const [lo, hi] = pair(from, to);
  await query(
    `INSERT INTO town_alliances (town_a, town_b, status, proposed_by)
     VALUES ($1, $2, 'proposed', $3)
     ON CONFLICT (town_a, town_b) DO NOTHING`,
    [lo, hi, from]
  );
}

export async function activateAlliance(a: string, b: string): Promise<void> {
  const [lo, hi] = pair(a, b);
  await query(
    `UPDATE town_alliances SET status = 'active', updated_at = now()
      WHERE town_a = $1 AND town_b = $2`,
    [lo, hi]
  );
}

export async function deleteAlliance(a: string, b: string): Promise<void> {
  const [lo, hi] = pair(a, b);
  await query(`DELETE FROM town_alliances WHERE town_a = $1 AND town_b = $2`, [lo, hi]);
}

/** Every relationship a town is part of (proposed or active). */
export async function listAlliancesForTown(town: string): Promise<AllianceRow[]> {
  const r = await query<AllianceRow>(
    `SELECT id, town_a, town_b, status, proposed_by FROM town_alliances
      WHERE town_a = $1 OR town_b = $1
      ORDER BY status DESC, updated_at DESC`,
    [town]
  );
  return r.rows;
}

/** Active alliances only, as [a, b] pairs, for the Luanti world to read. */
export async function listActiveAlliancePairs(): Promise<[string, string][]> {
  const r = await query<{ town_a: string; town_b: string }>(
    `SELECT town_a, town_b FROM town_alliances WHERE status = 'active'`
  );
  return r.rows.map((row) => [row.town_a, row.town_b]);
}

/** Shape a town's diplomacy for the web: who it's allied with, and the pending proposals
 *  split into incoming (someone asked us) and outgoing (we asked). */
export function presentDiplomacy(town: string, rows: AllianceRow[]) {
  const other = (r: AllianceRow) => (r.town_a === town ? r.town_b : r.town_a);
  const allies: string[] = [];
  const incoming: string[] = [];
  const outgoing: string[] = [];
  for (const r of rows) {
    if (r.status === "active") allies.push(other(r));
    else if (r.proposed_by === town) outgoing.push(other(r));
    else incoming.push(other(r));
  }
  return { allies, incoming, outgoing };
}
