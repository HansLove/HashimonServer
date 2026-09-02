import { query, withTransaction } from "@/db/pool";

// A player's in-world territory, as reported by the Luanti Towny mod. This is a
// PROJECTION, not authoritative state: the world is the source of truth for who
// controls what ground; this table only mirrors a summary so the website can show
// a player their holdings. Never gate ownership or emission on it.
export interface PlayerTerritoryRow {
  player_id: string;
  town_name: string | null;
  town_block_count: number;
  owned_plot_count: number;
  is_mayor: boolean;
  updated_at: string;
}

/** Upsert the single territory row for a player (they belong to at most one town). */
export async function upsertPlayerTerritory(input: {
  playerId: string;
  townName: string | null;
  townBlockCount: number;
  ownedPlotCount: number;
  isMayor: boolean;
}): Promise<PlayerTerritoryRow> {
  const res = await query<PlayerTerritoryRow>(
    `INSERT INTO player_territory
       (player_id, town_name, town_block_count, owned_plot_count, is_mayor, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (player_id) DO UPDATE SET
       town_name        = EXCLUDED.town_name,
       town_block_count = EXCLUDED.town_block_count,
       owned_plot_count = EXCLUDED.owned_plot_count,
       is_mayor         = EXCLUDED.is_mayor,
       updated_at       = now()
     RETURNING *`,
    [input.playerId, input.townName, input.townBlockCount, input.ownedPlotCount, input.isMayor]
  );
  return res.rows[0]!;
}

export async function getPlayerTerritory(playerId: string): Promise<PlayerTerritoryRow | null> {
  const res = await query<PlayerTerritoryRow>(
    `SELECT * FROM player_territory WHERE player_id = $1`,
    [playerId]
  );
  return res.rows[0] ?? null;
}

export interface TownRankRow {
  town_name: string;
  block_count: number;
  member_count: number;
  mayor: string | null;
}

/** Towns ranked by claimed extension (block count), from the authoritative town_claims
 *  snapshot pushed whole from the world — so every town appears regardless of whether a
 *  member is currently logged in. Town names/sizes are public in-world, so no auth. */
export async function listTownRanking(limit = 100): Promise<TownRankRow[]> {
  const res = await query<TownRankRow>(
    `SELECT town_name, block_count, member_count, mayor
       FROM town_claims
      ORDER BY block_count DESC, member_count DESC, town_name ASC
      LIMIT $1`,
    [limit]
  );
  return res.rows;
}

/** A town member's political position. Mirrors Towny's real flags. */
export type TownRank = "mayor" | "comayor" | "resident";
export interface TownMember {
  name: string;
  rank: TownRank;
}

/** One town's claimed footprint for the cadastral map. `blocks` is the deduped list of
 *  [x,y,z] mapblock coordinates (the world is 3D — a sky island and the ground below it
 *  are distinct); `home` is the homeblock, if any; `members` is the roster + ranks. */
export interface TownClaimsRow {
  town_name: string;
  block_count: number;
  mayor: string | null;
  home_x: number | null;
  home_y: number | null;
  home_z: number | null;
  blocks: [number, number, number][];
  members: TownMember[];
}

/** One town in the whole-world snapshot pushed by the Luanti sync mod. */
export interface TownClaimInput {
  name: string;
  blockCount: number;
  memberCount: number;
  mayor: string | null;
  homeX: number | null;
  homeY: number | null;
  homeZ: number | null;
  blocks: [number, number, number][];
  members: TownMember[];
}

/** Replace the entire town snapshot in one transaction: upsert every town in the push
 *  and drop any town no longer present (deleted/renamed in-world). The world is the
 *  source of truth, so a full replace — not an incremental merge — keeps us honest. */
export async function replaceTownClaims(towns: TownClaimInput[]): Promise<number> {
  await withTransaction(async (client) => {
    if (towns.length === 0) {
      await query(`DELETE FROM town_claims`, [], client);
      return;
    }
    const names = towns.map((t) => t.name);
    await query(`DELETE FROM town_claims WHERE town_name <> ALL($1::text[])`, [names], client);
    for (const t of towns) {
      await query(
        `INSERT INTO town_claims
           (town_name, block_count, member_count, mayor, home_x, home_y, home_z, blocks, members, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, now())
         ON CONFLICT (town_name) DO UPDATE SET
           block_count  = EXCLUDED.block_count,
           member_count = EXCLUDED.member_count,
           mayor        = EXCLUDED.mayor,
           home_x       = EXCLUDED.home_x,
           home_y       = EXCLUDED.home_y,
           home_z       = EXCLUDED.home_z,
           blocks       = EXCLUDED.blocks,
           members      = EXCLUDED.members,
           updated_at   = now()`,
        [t.name, t.blockCount, t.memberCount, t.mayor, t.homeX, t.homeY, t.homeZ,
         JSON.stringify(t.blocks), JSON.stringify(t.members)],
        client
      );
    }
  });
  return towns.length;
}

/** Every town's claimed footprint, for the public cadastral map. */
export async function listTownClaims(): Promise<TownClaimsRow[]> {
  const res = await query<TownClaimsRow>(
    `SELECT town_name, block_count, mayor, home_x, home_y, home_z, blocks, members
       FROM town_claims
      ORDER BY block_count DESC, town_name ASC`
  );
  return res.rows;
}

export function presentTownClaims(rows: TownClaimsRow[]) {
  return rows.map((r) => ({
    townName: r.town_name,
    blockCount: r.block_count,
    mayor: r.mayor,
    home:
      r.home_x !== null && r.home_y !== null && r.home_z !== null
        ? ([r.home_x, r.home_y, r.home_z] as [number, number, number])
        : null,
    blocks: r.blocks,
    members: r.members,
  }));
}

export function presentTownRanking(rows: TownRankRow[]) {
  return rows.map((r, i) => ({
    rank: i + 1,
    townName: r.town_name,
    blockCount: r.block_count,
    memberCount: r.member_count,
    mayor: r.mayor,
  }));
}

/** Client-facing shape. A player with no town (or no row yet) reads as hasTown:false. */
export function presentTerritory(row: PlayerTerritoryRow | null) {
  if (!row || !row.town_name) {
    return {
      hasTown: false,
      townName: null as string | null,
      townBlockCount: 0,
      ownedPlotCount: 0,
      isMayor: false,
      updatedAt: row?.updated_at ?? null,
    };
  }
  return {
    hasTown: true,
    townName: row.town_name,
    townBlockCount: row.town_block_count,
    ownedPlotCount: row.owned_plot_count,
    isMayor: row.is_mayor,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Town politics — the website manages co-mayors; the Luanti world carries it out.
// ---------------------------------------------------------------------------

/** The roster + ranks of one town (from the projection the world pushes). */
export async function getTownMembers(townName: string): Promise<TownMember[]> {
  const res = await query<{ members: TownMember[] }>(
    `SELECT members FROM town_claims WHERE town_name = $1`,
    [townName]
  );
  return res.rows[0]?.members ?? [];
}

export interface TownActionRow {
  id: number;
  town_name: string;
  actor: string;
  target: string;
  op: "add" | "remove";
  rank: string;
}

/** Queue a rank change requested from the web. The route has already checked the actor
 *  is the town's mayor; the world re-validates before applying, so this is a request,
 *  not authority. */
export async function enqueueRankAction(input: {
  townName: string;
  actor: string;
  target: string;
  op: "add" | "remove";
  rank: string;
}): Promise<void> {
  await query(
    `INSERT INTO town_actions (town_name, actor, target, op, rank) VALUES ($1, $2, $3, $4, $5)`,
    [input.townName, input.actor, input.target, input.op, input.rank]
  );
}

/** Pending actions for the Luanti poller to apply. */
export async function listPendingTownActions(limit = 50): Promise<TownActionRow[]> {
  const res = await query<TownActionRow>(
    `SELECT id, town_name, actor, target, op, rank
       FROM town_actions
      WHERE status = 'pending'
      ORDER BY id ASC
      LIMIT $1`,
    [limit]
  );
  return res.rows;
}

/** Close out an action once the world applied or rejected it. */
export async function resolveTownAction(
  id: number,
  result: "applied" | "rejected",
  detail?: string
): Promise<void> {
  await query(
    `UPDATE town_actions SET status = $2, detail = $3, applied_at = now()
      WHERE id = $1 AND status = 'pending'`,
    [id, result, detail ?? null]
  );
}
