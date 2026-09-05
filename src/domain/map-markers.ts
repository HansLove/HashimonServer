/**
 * Synced map waypoints: personal pins, nation POIs, and Hashimon world-care destinations.
 * API is authoritative; Luanti applies into discovery_maps. No web claiming of land.
 */

import { query } from "@/db/pool";
import { AppError } from "@/http/errors";
import { care, loadState } from "@/domain/chat";
import { listMapTiles, MAP_TILE_SIZE } from "@/domain/map-tiles";
import { getPlayerTerritory, getTownMembers, listTownClaims } from "@/domain/territory";
import { getForOwner, listByOwner } from "@/domain/hashimons";

/** Towny mapblock size in nodes — same as GET /territory/map `blockSize`. */
export const BLOCK_SIZE = 16;

/** Arrival radius (nodes) for Hashimon world destinations. */
export const ARRIVE_RADIUS = 32;

export const MAX_PLAYER_WAYPOINTS = 20;
export const MAX_NATION_POIS = 30;

export type MarkerKind = "player" | "nation" | "hashimon";
export type MarkerStatus = "active" | "completed" | "dismissed";

export type MapMarkerRow = {
  id: string;
  kind: MarkerKind;
  owner_player_id: string | null;
  town_name: string | null;
  hashimon_id: string | null;
  x: number;
  y: number;
  z: number;
  label: string;
  color_index: number;
  status: MarkerStatus;
  meta: Record<string, unknown>;
  created_at: string;
  completed_at: string | null;
};

/** discovery_maps color indices: Blue / Purple / Yellow. */
export const COLOR_BY_KIND: Record<MarkerKind, number> = {
  player: 2,
  nation: 5,
  hashimon: 4,
};

/** Mapblock → world center (same formula the website already uses). */
export function homeblockToWorld(
  home: [number, number, number],
  blockSize = BLOCK_SIZE
): { x: number; y: number; z: number } {
  const half = Math.floor(blockSize / 2);
  return {
    x: home[0] * blockSize + half,
    y: home[1] * blockSize + half,
    z: home[2] * blockSize + half,
  };
}

export function presentMarker(row: MapMarkerRow) {
  return {
    id: row.id,
    kind: row.kind,
    townName: row.town_name,
    hashimonId: row.hashimon_id,
    x: row.x,
    y: row.y,
    z: row.z,
    label: row.label,
    colorIndex: row.color_index,
    status: row.status,
    meta: row.meta ?? {},
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function parseMeta(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

async function fetchMarker(id: string): Promise<MapMarkerRow | null> {
  const res = await query<MapMarkerRow>(`SELECT * FROM map_markers WHERE id = $1`, [id]);
  const row = res.rows[0];
  if (!row) return null;
  return { ...row, meta: parseMeta(row.meta) };
}

export async function listPlayerWaypoints(playerId: string): Promise<MapMarkerRow[]> {
  const res = await query<MapMarkerRow>(
    `SELECT * FROM map_markers
      WHERE kind = 'player' AND owner_player_id = $1 AND status = 'active'
      ORDER BY created_at ASC`,
    [playerId]
  );
  return res.rows.map((r) => ({ ...r, meta: parseMeta(r.meta) }));
}

export async function listNationPois(townName: string): Promise<MapMarkerRow[]> {
  const res = await query<MapMarkerRow>(
    `SELECT * FROM map_markers
      WHERE kind = 'nation' AND town_name = $1 AND status = 'active'
      ORDER BY created_at ASC`,
    [townName]
  );
  return res.rows.map((r) => ({ ...r, meta: parseMeta(r.meta) }));
}

export async function listActiveHashimonQuests(playerId: string): Promise<MapMarkerRow[]> {
  const res = await query<MapMarkerRow>(
    `SELECT * FROM map_markers
      WHERE kind = 'hashimon' AND owner_player_id = $1 AND status = 'active'
      ORDER BY created_at ASC`,
    [playerId]
  );
  return res.rows.map((r) => ({ ...r, meta: parseMeta(r.meta) }));
}

async function countActive(kind: MarkerKind, key: string, value: string): Promise<number> {
  const col = kind === "player" || kind === "hashimon" ? "owner_player_id" : "town_name";
  const res = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM map_markers
      WHERE kind = $1 AND ${col} = $2 AND status = 'active'`,
    [kind, value]
  );
  return Number(res.rows[0]?.n ?? 0);
}

export async function createPlayerWaypoint(input: {
  playerId: string;
  x: number;
  y: number;
  z: number;
  label: string;
}): Promise<MapMarkerRow> {
  const n = await countActive("player", "owner_player_id", input.playerId);
  if (n >= MAX_PLAYER_WAYPOINTS) {
    throw new AppError(409, `at most ${MAX_PLAYER_WAYPOINTS} personal waypoints`, "waypoint_limit");
  }
  const label = input.label.trim().slice(0, 80) || "Waypoint";
  const res = await query<MapMarkerRow>(
    `INSERT INTO map_markers
       (kind, owner_player_id, x, y, z, label, color_index, status, meta)
     VALUES ('player', $1, $2, $3, $4, $5, $6, 'active', '{}'::jsonb)
     RETURNING *`,
    [input.playerId, input.x, input.y, input.z, label, COLOR_BY_KIND.player]
  );
  return { ...res.rows[0]!, meta: {} };
}

export async function deletePlayerWaypoint(playerId: string, id: string): Promise<void> {
  const res = await query(
    `UPDATE map_markers SET status = 'dismissed', completed_at = now()
      WHERE id = $1 AND kind = 'player' AND owner_player_id = $2 AND status = 'active'`,
    [id, playerId]
  );
  if ((res.rowCount ?? 0) === 0) {
    throw new AppError(404, "waypoint not found", "not_found");
  }
}

/** Mayor or co-mayor of the caller's town may place nation POIs. */
export async function assertCanEditNation(
  playerId: string,
  username: string | null
): Promise<{ townName: string; isMayor: boolean }> {
  const pt = await getPlayerTerritory(playerId);
  if (!pt?.town_name) {
    throw new AppError(400, "you are not in a town", "no_town");
  }
  if (pt.is_mayor) return { townName: pt.town_name, isMayor: true };
  if (!username) {
    throw new AppError(403, "only mayor or co-mayor can edit nation POIs", "forbidden");
  }
  const members = await getTownMembers(pt.town_name);
  const me = members.find((m) => m.name.toLowerCase() === username.toLowerCase());
  if (!me || (me.rank !== "mayor" && me.rank !== "comayor")) {
    throw new AppError(403, "only mayor or co-mayor can edit nation POIs", "forbidden");
  }
  return { townName: pt.town_name, isMayor: false };
}

export async function createNationPoi(input: {
  townName: string;
  ownerPlayerId: string;
  x: number;
  y: number;
  z: number;
  label: string;
}): Promise<MapMarkerRow> {
  const n = await countActive("nation", "town_name", input.townName);
  if (n >= MAX_NATION_POIS) {
    throw new AppError(409, `at most ${MAX_NATION_POIS} nation POIs`, "poi_limit");
  }
  const label = input.label.trim().slice(0, 80) || "POI";
  const res = await query<MapMarkerRow>(
    `INSERT INTO map_markers
       (kind, owner_player_id, town_name, x, y, z, label, color_index, status, meta)
     VALUES ('nation', $1, $2, $3, $4, $5, $6, $7, 'active', '{}'::jsonb)
     RETURNING *`,
    [
      input.ownerPlayerId,
      input.townName,
      input.x,
      input.y,
      input.z,
      label,
      COLOR_BY_KIND.nation,
    ]
  );
  return { ...res.rows[0]!, meta: {} };
}

export async function deleteNationPoi(townName: string, id: string): Promise<void> {
  const res = await query(
    `UPDATE map_markers SET status = 'dismissed', completed_at = now()
      WHERE id = $1 AND kind = 'nation' AND town_name = $2 AND status = 'active'`,
    [id, townName]
  );
  if ((res.rowCount ?? 0) === 0) {
    throw new AppError(404, "nation POI not found", "not_found");
  }
}

export type CapitalInfo = {
  townName: string;
  home: [number, number, number];
  world: { x: number; y: number; z: number };
  blockSize: number;
};

export async function capitalForPlayer(playerId: string): Promise<CapitalInfo | null> {
  const pt = await getPlayerTerritory(playerId);
  if (!pt?.town_name) return null;
  const towns = await listTownClaims();
  const row = towns.find((t) => t.town_name === pt.town_name);
  if (!row || row.home_x == null || row.home_y == null || row.home_z == null) return null;
  const home: [number, number, number] = [row.home_x, row.home_y, row.home_z];
  return {
    townName: row.town_name,
    home,
    world: homeblockToWorld(home),
    blockSize: BLOCK_SIZE,
  };
}

/**
 * Pick a world destination for a Hashimon world-care quest.
 * Prefers a discovered map tile far from the capital / last sector; falls back to offset.
 */
export function pickWorldDestination(opts: {
  tiles: [number, number][];
  lastSector: string | null;
  capitalWorld: { x: number; y: number; z: number } | null;
  hashimonId: string;
}): { x: number; y: number; z: number; sector: string } {
  const y = opts.capitalWorld?.y ?? 8;
  const avoid = new Set<string>();
  if (opts.lastSector?.startsWith("tile:")) avoid.add(opts.lastSector);
  if (opts.capitalWorld) {
    const tx = Math.floor(opts.capitalWorld.x / MAP_TILE_SIZE);
    const tz = Math.floor(opts.capitalWorld.z / MAP_TILE_SIZE);
    avoid.add(`tile:${tx}:${tz}`);
  }

  const candidates = opts.tiles.filter(([tx, tz]) => !avoid.has(`tile:${tx}:${tz}`));
  const pool = candidates.length > 0 ? candidates : opts.tiles;

  if (pool.length > 0) {
    // Stable pick from hashimon id so re-ensure doesn't jump destinations mid-want.
    let h = 0;
    for (let i = 0; i < opts.hashimonId.length; i++) {
      h = (h * 31 + opts.hashimonId.charCodeAt(i)) >>> 0;
    }
    const [tx, tz] = pool[h % pool.length]!;
    const half = Math.floor(MAP_TILE_SIZE / 2);
    return {
      x: tx * MAP_TILE_SIZE + half,
      y,
      z: tz * MAP_TILE_SIZE + half,
      sector: `tile:${tx}:${tz}`,
    };
  }

  // No tiles uploaded yet — offset from capital or origin.
  const base = opts.capitalWorld ?? { x: 0, y, z: 0 };
  let h = 0;
  for (let i = 0; i < opts.hashimonId.length; i++) {
    h = (h * 31 + opts.hashimonId.charCodeAt(i)) >>> 0;
  }
  const angle = (h % 360) * (Math.PI / 180);
  const dist = 200 + (h % 200);
  const x = Math.round(base.x + Math.cos(angle) * dist);
  const z = Math.round(base.z + Math.sin(angle) * dist);
  return { x, y: base.y, z, sector: `xz:${x}:${z}` };
}

/** Ensure one active hashimon destination when companion wants `world` care. */
export async function ensureHashimonDestination(input: {
  playerId: string;
  hashimonId: string;
  creatureName: string;
}): Promise<MapMarkerRow | null> {
  const state = await loadState(input.hashimonId, input.playerId);
  if (state.wellbeing.want?.kind !== "world") return null;

  const existing = await query<MapMarkerRow>(
    `SELECT * FROM map_markers
      WHERE kind = 'hashimon' AND hashimon_id = $1 AND status = 'active'
      LIMIT 1`,
    [input.hashimonId]
  );
  if (existing.rows[0]) {
    return { ...existing.rows[0], meta: parseMeta(existing.rows[0].meta) };
  }

  const capital = await capitalForPlayer(input.playerId);
  const tiles = await listMapTiles();
  const rowState = await query<{ last_sector: string | null }>(
    `SELECT last_sector FROM companion_state WHERE hashimon_id = $1`,
    [input.hashimonId]
  );
  const dest = pickWorldDestination({
    tiles,
    lastSector: rowState.rows[0]?.last_sector ?? null,
    capitalWorld: capital?.world ?? null,
    hashimonId: input.hashimonId,
  });

  const label = `${input.creatureName}: llévame aquí`.slice(0, 80);
  const meta = { sector: dest.sector, radius: ARRIVE_RADIUS };
  const res = await query<MapMarkerRow>(
    `INSERT INTO map_markers
       (kind, owner_player_id, hashimon_id, x, y, z, label, color_index, status, meta)
     VALUES ('hashimon', $1, $2, $3, $4, $5, $6, $7, 'active', $8::jsonb)
     RETURNING *`,
    [
      input.playerId,
      input.hashimonId,
      dest.x,
      dest.y,
      dest.z,
      label,
      COLOR_BY_KIND.hashimon,
      JSON.stringify(meta),
    ]
  );
  return { ...res.rows[0]!, meta };
}

/** Ensure destinations for every owned Hashimon that currently wants world care. */
export async function ensureAllHashimonDestinations(playerId: string): Promise<MapMarkerRow[]> {
  const creatures = await listByOwner(playerId);
  const out: MapMarkerRow[] = [];
  for (const c of creatures) {
    const m = await ensureHashimonDestination({
      playerId,
      hashimonId: c.id,
      creatureName: c.name,
    });
    if (m) out.push(m);
  }
  return out;
}

/**
 * Hook after a world destination is completed.
 * V1: wellbeing + optional keepsake only. Mutation rolls are a later extension.
 */
export async function onWorldDestinationComplete(
  hashimonId: string,
  sector: string
): Promise<void> {
  await care(hashimonId, "world", sector);
  const line = `Me llevaste a ${sector}. Ya no veo la misma pared.`.slice(0, 240);
  await query(
    `INSERT INTO companion_memory (hashimon_id, text) VALUES ($1, $2)`,
    [hashimonId, line]
  );
}

export async function arriveAtMarker(input: {
  playerId: string;
  markerId: string;
  x: number;
  y: number;
  z: number;
}): Promise<{ completed: boolean; marker: MapMarkerRow }> {
  const marker = await fetchMarker(input.markerId);
  if (!marker || marker.status !== "active") {
    throw new AppError(404, "marker not found", "not_found");
  }
  if (marker.kind !== "hashimon") {
    throw new AppError(400, "only hashimon destinations can be arrived at", "invalid_kind");
  }
  if (marker.owner_player_id !== input.playerId) {
    throw new AppError(403, "not your quest", "forbidden");
  }

  const radius =
    typeof marker.meta.radius === "number" ? marker.meta.radius : ARRIVE_RADIUS;
  const dx = input.x - marker.x;
  const dy = input.y - marker.y;
  const dz = input.z - marker.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist > radius + 8) {
    throw new AppError(400, "too far from destination", "too_far");
  }

  const sector =
    typeof marker.meta.sector === "string"
      ? marker.meta.sector
      : `xz:${Math.round(marker.x)}:${Math.round(marker.z)}`;

  if (marker.hashimon_id) {
    await onWorldDestinationComplete(marker.hashimon_id, sector);
  }

  const res = await query<MapMarkerRow>(
    `UPDATE map_markers SET status = 'completed', completed_at = now()
      WHERE id = $1 AND status = 'active'
      RETURNING *`,
    [marker.id]
  );
  return {
    completed: true,
    marker: { ...res.rows[0]!, meta: parseMeta(res.rows[0]!.meta) },
  };
}

/** Bundle for the website map page. */
export async function bundleForPlayer(
  playerId: string,
  username: string | null
): Promise<{
  waypoints: ReturnType<typeof presentMarker>[];
  nationPois: ReturnType<typeof presentMarker>[];
  hashimonQuests: ReturnType<typeof presentMarker>[];
  capital: CapitalInfo | null;
  canEditNation: boolean;
  townName: string | null;
}> {
  await ensureAllHashimonDestinations(playerId);
  const pt = await getPlayerTerritory(playerId);
  const townName = pt?.town_name ?? null;
  let canEditNation = false;
  if (townName) {
    try {
      await assertCanEditNation(playerId, username);
      canEditNation = true;
    } catch {
      canEditNation = false;
    }
  }

  const [waypoints, nationPois, hashimonQuests, capital] = await Promise.all([
    listPlayerWaypoints(playerId),
    townName ? listNationPois(townName) : Promise.resolve([]),
    listActiveHashimonQuests(playerId),
    capitalForPlayer(playerId),
  ]);

  return {
    waypoints: waypoints.map(presentMarker),
    nationPois: nationPois.map(presentMarker),
    hashimonQuests: hashimonQuests.map(presentMarker),
    capital,
    canEditNation,
    townName,
  };
}

/** Markers Luanti should inject for a username (API account). */
export async function markersForLuantiUsername(username: string): Promise<{
  playerId: string | null;
  markers: ReturnType<typeof presentMarker>[];
  capital: CapitalInfo | null;
}> {
  const { getPlayerByUsername } = await import("@/domain/players");
  const player = await getPlayerByUsername(username);
  if (!player) return { playerId: null, markers: [], capital: null };

  await ensureAllHashimonDestinations(player.id);
  const pt = await getPlayerTerritory(player.id);
  const townName = pt?.town_name ?? null;

  const [waypoints, nationPois, hashimonQuests, capital] = await Promise.all([
    listPlayerWaypoints(player.id),
    townName ? listNationPois(townName) : Promise.resolve([]),
    listActiveHashimonQuests(player.id),
    capitalForPlayer(player.id),
  ]);

  return {
    playerId: player.id,
    markers: [...waypoints, ...nationPois, ...hashimonQuests].map(presentMarker),
    capital,
  };
}

export async function arriveForLuantiUsername(input: {
  username: string;
  markerId: string;
  x: number;
  y: number;
  z: number;
}): Promise<{ completed: boolean; marker: ReturnType<typeof presentMarker> }> {
  const { getPlayerByUsername } = await import("@/domain/players");
  const player = await getPlayerByUsername(input.username);
  if (!player) throw new AppError(404, "player not found", "not_found");
  const result = await arriveAtMarker({
    playerId: player.id,
    markerId: input.markerId,
    x: input.x,
    y: input.y,
    z: input.z,
  });
  return { completed: result.completed, marker: presentMarker(result.marker) };
}

/** Used by companion GET to attach an active world quest when want.kind === world. */
export async function questForHashimon(
  playerId: string,
  hashimonId: string,
  creatureName: string
): Promise<ReturnType<typeof presentMarker> | null> {
  const owned = await getForOwner(hashimonId, playerId);
  if (!owned) return null;
  const m = await ensureHashimonDestination({
    playerId,
    hashimonId,
    creatureName: creatureName || owned.name,
  });
  return m ? presentMarker(m) : null;
}
