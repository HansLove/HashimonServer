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

/** One town's claimed footprint for the cadastral map. `blocks` is the deduped list of
 *  [x,z] mapblock coordinates (top-down projection); `home` is the homeblock, if any. */
export interface TownClaimsRow {
  town_name: string;
  block_count: number;
  mayor: string | null;
  home_x: number | null;
  home_z: number | null;
  blocks: [number, number][];
}

/** One town in the whole-world snapshot pushed by the Luanti sync mod. */
export interface TownClaimInput {
  name: string;
  blockCount: number;
  memberCount: number;
  mayor: string | null;
  homeX: number | null;
  homeZ: number | null;
  blocks: [number, number][];
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
           (town_name, block_count, member_count, mayor, home_x, home_z, blocks, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now())
         ON CONFLICT (town_name) DO UPDATE SET
           block_count  = EXCLUDED.block_count,
           member_count = EXCLUDED.member_count,
           mayor        = EXCLUDED.mayor,
           home_x       = EXCLUDED.home_x,
           home_z       = EXCLUDED.home_z,
           blocks       = EXCLUDED.blocks,
           updated_at   = now()`,
        [t.name, t.blockCount, t.memberCount, t.mayor, t.homeX, t.homeZ, JSON.stringify(t.blocks)],
        client
      );
    }
  });
  return towns.length;
}

/** Every town's claimed footprint, for the public cadastral map. */
export async function listTownClaims(): Promise<TownClaimsRow[]> {
  const res = await query<TownClaimsRow>(
    `SELECT town_name, block_count, mayor, home_x, home_z, blocks
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
    home: r.home_x !== null && r.home_z !== null ? ([r.home_x, r.home_z] as [number, number]) : null,
    blocks: r.blocks,
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
