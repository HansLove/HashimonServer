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
  invites: string[];
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
  invites: string[];
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
           (town_name, block_count, member_count, mayor, home_x, home_y, home_z, blocks, members, invites, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, now())
         ON CONFLICT (town_name) DO UPDATE SET
           block_count  = EXCLUDED.block_count,
           member_count = EXCLUDED.member_count,
           mayor        = EXCLUDED.mayor,
           home_x       = EXCLUDED.home_x,
           home_y       = EXCLUDED.home_y,
           home_z       = EXCLUDED.home_z,
           blocks       = EXCLUDED.blocks,
           members      = EXCLUDED.members,
           invites      = EXCLUDED.invites,
           updated_at   = now()`,
        [t.name, t.blockCount, t.memberCount, t.mayor, t.homeX, t.homeY, t.homeZ,
         JSON.stringify(t.blocks), JSON.stringify(t.members), JSON.stringify(t.invites ?? [])],
        client
      );
    }
  });
  return towns.length;
}

/** Every town's claimed footprint, for the public cadastral map. */
export async function listTownClaims(): Promise<TownClaimsRow[]> {
  const res = await query<TownClaimsRow>(
    `SELECT town_name, block_count, mayor, home_x, home_y, home_z, blocks, members,
            COALESCE(invites, '[]'::jsonb) AS invites
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
  op: string;
  rank: string;
}

export type TownActionOp =
  | "add"
  | "remove"
  | "invite"
  | "invite_revoke"
  | "invite_accept"
  | "invite_deny"
  | "kick"
  | "leave"
  | "claim";

/** Max mapblocks one town may queue/apply via web claim per UTC day. */
export const TOWN_CLAIM_DAILY_LIMIT = 365;

/** One town's footprint row (for soft claim checks). */
export async function getTownClaimsByName(townName: string): Promise<TownClaimsRow | null> {
  const res = await query<TownClaimsRow>(
    `SELECT town_name, block_count, mayor, home_x, home_y, home_z, blocks, members,
            COALESCE(invites, '[]'::jsonb) AS invites
       FROM town_claims
      WHERE town_name = $1`,
    [townName]
  );
  return res.rows[0] ?? null;
}

/** Encode mapblock coords into town_actions.target. */
export function formatClaimTarget(bx: number, by: number, bz: number): string {
  return `${bx},${by},${bz}`;
}

/** Soft adjacency: orthogonal Manhattan distance 1 in mapblock space (Towny rule). */
export function mapblockBordersTown(
  bx: number,
  by: number,
  bz: number,
  blocks: [number, number, number][]
): boolean {
  for (const [ox, oy, oz] of blocks) {
    if (Math.abs(bx - ox) + Math.abs(by - oy) + Math.abs(bz - oz) === 1) return true;
  }
  return false;
}

/** True if this mapblock is already in the town's projected footprint. */
export function mapblockOwnedByTown(
  bx: number,
  by: number,
  bz: number,
  blocks: [number, number, number][]
): boolean {
  return blocks.some(([ox, oy, oz]) => ox === bx && oy === by && oz === bz);
}

/** Claims already used today (UTC) for a town — pending + applied count toward the cap. */
export async function countTownClaimsToday(townName: string): Promise<number> {
  const res = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM town_actions
      WHERE town_name = $1
        AND op = 'claim'
        AND status IN ('pending', 'applied')
        AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC')
                               AT TIME ZONE 'UTC'`,
    [townName]
  );
  return Number(res.rows[0]?.n ?? 0);
}

export async function getTownClaimQuota(townName: string): Promise<{
  used: number;
  limit: number;
  remaining: number;
}> {
  const used = await countTownClaimsToday(townName);
  const limit = TOWN_CLAIM_DAILY_LIMIT;
  return { used, limit, remaining: Math.max(0, limit - used) };
}

/** True if a pending claim already targets this mapblock for the town. */
export async function hasPendingClaimAt(
  townName: string,
  target: string
): Promise<boolean> {
  const res = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM town_actions
      WHERE town_name = $1 AND op = 'claim' AND status = 'pending' AND target = $2`,
    [townName, target]
  );
  return Number(res.rows[0]?.n ?? 0) > 0;
}

/** Parse "bx,by,bz" from town_actions.target. */
export function parseClaimTarget(target: string): [number, number, number] | null {
  const m = /^(-?\d+),(-?\d+),(-?\d+)$/.exec(target.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Claim blocks that should paint on the cadastral map even before town_claims
 * catches up: still pending, or applied in the last 2 minutes (push may lag).
 */
export async function listVisibleClaimOverlays(): Promise<
  { townName: string; block: [number, number, number]; status: "pending" | "applied" }[]
> {
  const res = await query<{ town_name: string; target: string; status: string }>(
    `SELECT town_name, target, status FROM town_actions
      WHERE op = 'claim'
        AND (
          status = 'pending'
          OR (status = 'applied' AND applied_at >= now() - interval '2 minutes')
        )
      ORDER BY id ASC`
  );
  const out: {
    townName: string;
    block: [number, number, number];
    status: "pending" | "applied";
  }[] = [];
  for (const row of res.rows) {
    const block = parseClaimTarget(row.target);
    if (!block) continue;
    out.push({
      townName: row.town_name,
      block,
      status: row.status === "pending" ? "pending" : "applied",
    });
  }
  return out;
}

/** Merge pending/recent claim overlays into the cadastral snapshot so F5 paints. */
export function mergeClaimOverlaysIntoTowns(
  towns: ReturnType<typeof presentTownClaims>,
  overlays: { townName: string; block: [number, number, number] }[]
): ReturnType<typeof presentTownClaims> {
  if (overlays.length === 0) return towns;
  const byTown = new Map<string, [number, number, number][]>();
  for (const o of overlays) {
    const key = o.townName.toLowerCase();
    const list = byTown.get(key) ?? [];
    list.push(o.block);
    byTown.set(key, list);
  }
  return towns.map((t) => {
    const extra = byTown.get(t.townName.toLowerCase());
    if (!extra || extra.length === 0) return t;
    const have = new Set(t.blocks.map(([x, y, z]) => `${x}:${y}:${z}`));
    const added: [number, number, number][] = [];
    for (const b of extra) {
      const k = `${b[0]}:${b[1]}:${b[2]}`;
      if (have.has(k)) continue;
      have.add(k);
      added.push(b);
    }
    if (added.length === 0) return t;
    const blocks = [...t.blocks, ...added];
    return { ...t, blocks, blockCount: Math.max(t.blockCount, blocks.length) };
  });
}

/** Pending claim blocks for one town (authenticated map merge / poll). */
export async function listPendingClaimsForTown(
  townName: string
): Promise<[number, number, number][]> {
  const res = await query<{ target: string }>(
    `SELECT target FROM town_actions
      WHERE town_name = $1 AND op = 'claim' AND status = 'pending'
      ORDER BY id ASC`,
    [townName]
  );
  const blocks: [number, number, number][] = [];
  for (const row of res.rows) {
    const b = parseClaimTarget(row.target);
    if (b) blocks.push(b);
  }
  return blocks;
}

/** Queue a political action from the web. The world re-validates before applying. */
export async function enqueueTownAction(input: {
  townName: string;
  actor: string;
  target: string;
  op: TownActionOp;
  rank?: string;
}): Promise<void> {
  await query(
    `INSERT INTO town_actions (town_name, actor, target, op, rank) VALUES ($1, $2, $3, $4, $5)`,
    [input.townName, input.actor, input.target, input.op, input.rank ?? ""]
  );
}

/** @deprecated prefer enqueueTownAction — kept for call sites that only do comayor. */
export async function enqueueRankAction(input: {
  townName: string;
  actor: string;
  target: string;
  op: "add" | "remove";
  rank: string;
}): Promise<void> {
  await enqueueTownAction(input);
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

/** Invites sent by one town (from the Towny projection). */
export async function getTownInvites(townName: string): Promise<string[]> {
  const res = await query<{ invites: string[] }>(
    `SELECT COALESCE(invites, '[]'::jsonb) AS invites FROM town_claims WHERE town_name = $1`,
    [townName]
  );
  return res.rows[0]?.invites ?? [];
}

/** Towns that have invited this luanti username (case-insensitive). */
export async function listInvitesForPlayer(username: string): Promise<string[]> {
  const res = await query<{ town_name: string }>(
    `SELECT town_name FROM town_claims
      WHERE EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(COALESCE(invites, '[]'::jsonb)) AS inv(name)
         WHERE lower(inv.name) = lower($1)
      )
      ORDER BY town_name ASC`,
    [username]
  );
  return res.rows.map((r) => r.town_name);
}

/** True if username is mayor or comayor in the town roster. */
export function memberIsOfficer(members: TownMember[], username: string): boolean {
  const m = members.find((x) => x.name.toLowerCase() === username.toLowerCase());
  return m?.rank === "mayor" || m?.rank === "comayor";
}
