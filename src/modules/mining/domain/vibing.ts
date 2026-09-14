import { query, withTransaction, type DbClient } from "@/modules/core/db/pool";
import { zoneAtWorld } from "@/modules/core/core/yield-map";
import type { YieldTier } from "@/modules/core/core/pow";

// Vibing towers (VIBING_V1.md §3). A projection of in-world structures, pushed WHOLE from
// the Luanti world (replace-all, like town_claims) so the website can draw them. The world
// owns where a tower is; the web derives what it yields from the coordinate (zona(x,z)).

export interface VibingTowerRow {
  id: string;
  town_name: string | null;
  owner: string | null;
  x: number;
  y: number;
  z: number;
}

export interface VibingTowerInput {
  id: string;
  townName: string | null;
  owner: string | null;
  x: number;
  y: number;
  z: number;
}

/** Replace the whole tower set in one transaction (the world is authoritative). */
export async function replaceVibingTowers(towers: VibingTowerInput[]): Promise<number> {
  await withTransaction(async (client) => {
    if (towers.length === 0) {
      await query(`DELETE FROM vibing_towers`, [], client);
      return;
    }
    const ids = towers.map((t) => t.id);
    await query(`DELETE FROM vibing_towers WHERE id <> ALL($1::text[])`, [ids], client);
    for (const t of towers) {
      await query(
        `INSERT INTO vibing_towers (id, town_name, owner, x, y, z, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (id) DO UPDATE SET
           town_name = EXCLUDED.town_name,
           owner     = EXCLUDED.owner,
           x = EXCLUDED.x, y = EXCLUDED.y, z = EXCLUDED.z,
           updated_at = now()`,
        [t.id, t.townName, t.owner, t.x, t.y, t.z],
        client
      );
    }
  });
  return towers.length;
}

export async function listVibingTowers(): Promise<VibingTowerRow[]> {
  const res = await query<VibingTowerRow>(
    `SELECT id, town_name, owner, x, y, z FROM vibing_towers ORDER BY town_name ASC, id ASC`
  );
  return res.rows;
}

export function presentVibingTowers(rows: (VibingTowerRow & { heat?: number })[]) {
  return rows.map((r) => {
    const zone = zoneAtWorld(r.x, r.z);
    return {
      id: r.id,
      town: r.town_name,
      owner: r.owner,
      x: r.x,
      y: r.y,
      z: r.z,
      // The server is the authority on what a coordinate yields; the web derives the same
      // tier from (x,z), but shipping it means the two can never silently disagree.
      tier: zone.tier,
      heat: r.heat ?? 0,
    };
  });
}

// ── The spatial link (VIBING_V1.md §2, POW_YIELD_V1.md §3.3) ─────────────────────────────
// WHERE a player's Vibing tower stands decides WHAT the same PoW harvests, and every harvest
// heats that place. The tower is the town's; a player with no tower harvests only the floor
// tier at their own vault. This is resolved server-side so the tier is never a client claim.

export interface HarvestPlace {
  /** Where the drop materializes + accrues heat: a tower id ("x:y:z") or "vault:<player>". */
  place: string;
  /** The tier this place yields — the tower's zona, or the consumable floor without one. */
  tier: YieldTier;
  /** The town the place belongs to (denormalized onto heat for per-town aggregation). */
  townName: string | null;
}

/**
 * Pure — no I/O. The PLACE-ceiling rule (VIBING_V1.md §2): no town, or a town with no tower,
 * floors to the player's own vault; a town with a tower yields that tower's zone. Split out so
 * the rule the auditor flagged as "central to the yield decision" is unit-testable against
 * plain values instead of a live `player_territory`/`vibing_towers` join —
 * harvestPlaceForPlayer only sequences the two reads that feed it.
 */
export function resolveHarvestPlace(
  playerId: string,
  townName: string | null,
  tower: { id: string; x: number; z: number } | null
): HarvestPlace {
  const vault = `vault:${playerId}`;
  if (!townName) return { place: vault, tier: "consumable", townName: null };
  if (!tower) return { place: vault, tier: "consumable", townName };
  return { place: tower.id, tier: zoneAtWorld(tower.x, tower.z).tier, townName };
}

/**
 * Resolve where a player harvests and what tier it yields. A player's harvest is tied to
 * their TOWN's Vibing tower (the world owns where it stands); the tower's coordinate zona is
 * the tier. No town or no tower → the consumable floor at the player's own vault, so browser
 * work always feeds *something* while planting a tower is what unlocks the rich zones.
 */
export async function harvestPlaceForPlayer(playerId: string): Promise<HarvestPlace> {
  const terr = await query<{ town_name: string | null }>(
    `SELECT town_name FROM player_territory WHERE player_id = $1`,
    [playerId]
  );
  const townName = terr.rows[0]?.town_name ?? null;
  if (!townName) return resolveHarvestPlace(playerId, townName, null);

  const tower = await query<{ id: string; x: number; z: number }>(
    `SELECT id, x, z FROM vibing_towers WHERE town_name = $1 ORDER BY id ASC LIMIT 1`,
    [townName]
  );
  return resolveHarvestPlace(playerId, townName, tower.rows[0] ?? null);
}

/** Record one verified harvest's heat at its place. Runs inside the yield transaction. */
export async function bumpHeat(place: HarvestPlace, client?: DbClient): Promise<void> {
  await query(
    `INSERT INTO place_heat (place, town_name, heat, updated_at)
     VALUES ($1, $2, 1, now())
     ON CONFLICT (place) DO UPDATE SET
       heat = place_heat.heat + 1,
       town_name = COALESCE(EXCLUDED.town_name, place_heat.town_name),
       updated_at = now()`,
    [place.place, place.townName],
    client
  );
}

/** Heat by place id, for a set of places (e.g. every tower on the map). */
export async function heatByPlace(places: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (places.length === 0) return out;
  const res = await query<{ place: string; heat: string }>(
    `SELECT place, heat::text FROM place_heat WHERE place = ANY($1::text[])`,
    [places]
  );
  for (const r of res.rows) out.set(r.place, Number(r.heat));
  return out;
}
