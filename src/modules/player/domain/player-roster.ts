import { query } from "@/modules/core/db/pool";
import { progressionFromBits } from "@/modules/core/core/pow";
import { Hashimons } from "@/modules/hashimon/data/species";

//The admin roster: every owner account with what a back office needs to see at a
//glance. Read-only by design — nothing here can move credits or creatures.
//
//Deliberately absent: password hashes, encrypted keys, luanti_password, public keys
//and the Luanti checkpoint. A roster for an operator has no use for any of them, and
//every column left out is one that cannot leak through a back office.

export interface RosterRow {
  id: string;
  username: string;
  credits: number;
  created_at: Date;
  custody: string | null;
  can_own: boolean;
  birth_spirit: string | null;
  genesis_element: string | null;
  referred_by: string | null;
  hashimon_count: number;
  species_key: string | null;
  best_share_bits: number;
}

export interface RosterPlayer {
  id: string;
  username: string;
  credits: number;
  joinedAt: string;
  custody: string | null;
  canOwn: boolean;
  birthSpirit: string | null;
  genesisElement: string | null;
  referredBy: string | null;
  hashimonCount: number;
  /** The player's main creature: the starter if they still have it, else the oldest. */
  speciesKey: string | null;
  speciesName: string | null;
  /** Best share across ALL their active creatures, not just the main one. */
  bestShareBits: number;
  bestShareStars: number;
}

export interface RosterTotals {
  players: number;
  totalCredits: number;
  totalHashimons: number;
  topBestShareBits: number;
}

//Only the registered-species label is derived here; stats, colour and rank stay the
//Caos Core's job. An unknown key (a species retired from the registry) falls back to
//the raw key instead of disappearing, so the roster never hides a real creature.
function speciesNameOf(key: string | null): string | null {
  if (!key) { return null; }
  return Hashimons[key]?.name ?? key;
}

function present(row: RosterRow): RosterPlayer {
  const bits = Number(row.best_share_bits) || 0;
  return {
    id: row.id,
    username: row.username,
    credits: Number(row.credits),
    joinedAt: new Date(row.created_at).toISOString(),
    custody: row.custody,
    canOwn: row.can_own,
    birthSpirit: row.birth_spirit,
    genesisElement: row.genesis_element,
    referredBy: row.referred_by,
    hashimonCount: row.hashimon_count,
    speciesKey: row.species_key,
    speciesName: speciesNameOf(row.species_key),
    bestShareBits: bits,
    bestShareStars: progressionFromBits(bits).stars,
  };
}

export type RosterSort = "joined" | "credits" | "best_share";

//Whitelisted ORDER BY fragments. The sort arrives from a query string, so it is
//never interpolated: it selects one of these literals or the default.
const ORDER_BY: Record<RosterSort, string> = {
  joined: "p.created_at DESC",
  credits: "p.credits DESC, p.created_at DESC",
  best_share: "best_share_bits DESC, p.created_at DESC",
};

/**
 * One page of the roster plus totals over the whole filtered set.
 *
 * Only accounts with a username: anonymous `POST /session` rows are device
 * identities, not people, and would bury the real players under noise.
 */
export async function listRoster(opts: {
  search?: string;
  sort?: RosterSort;
  limit: number;
  offset: number;
}): Promise<{ players: RosterPlayer[]; totals: RosterTotals }> {
  const search = opts.search?.trim() ? `%${opts.search.trim()}%` : null;
  const orderBy = ORDER_BY[opts.sort ?? "joined"] ?? ORDER_BY.joined;

  const rows = await query<RosterRow>(
    `SELECT p.id, p.username, p.credits, p.created_at, p.custody,
            (p.public_key IS NOT NULL)          AS can_own,
            p.birth_spirit, p.genesis_element, p.referred_by,
            COALESCE(agg.hashimon_count, 0)     AS hashimon_count,
            COALESCE(agg.best_bits, 0)          AS best_share_bits,
            main.species_key
       FROM players p
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS hashimon_count, MAX(best_share_bits) AS best_bits
           FROM hashimons
          WHERE owner_id = p.id AND archived_at IS NULL
       ) agg ON true
       LEFT JOIN LATERAL (
         SELECT species_key
           FROM hashimons
          WHERE owner_id = p.id AND archived_at IS NULL
          ORDER BY (provenance = 'starter') DESC, born_at ASC
          LIMIT 1
       ) main ON true
      WHERE p.username IS NOT NULL
        AND ($1::text IS NULL OR p.username ILIKE $1)
      ORDER BY ${orderBy}
      LIMIT $2 OFFSET $3`,
    [search, opts.limit, opts.offset]
  );

  const totals = await query<{
    players: number;
    total_credits: string;
    total_hashimons: number;
    top_bits: number;
  }>(
    `SELECT COUNT(*)::int                                   AS players,
            COALESCE(SUM(p.credits), 0)                     AS total_credits,
            COALESCE(SUM(agg.hashimon_count), 0)::int       AS total_hashimons,
            COALESCE(MAX(agg.best_bits), 0)::int            AS top_bits
       FROM players p
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS hashimon_count, MAX(best_share_bits) AS best_bits
           FROM hashimons
          WHERE owner_id = p.id AND archived_at IS NULL
       ) agg ON true
      WHERE p.username IS NOT NULL
        AND ($1::text IS NULL OR p.username ILIKE $1)`,
    [search]
  );
  const t = totals.rows[0]!;

  return {
    players: rows.rows.map(present),
    totals: {
      players: t.players,
      totalCredits: Number(t.total_credits),
      totalHashimons: t.total_hashimons,
      topBestShareBits: t.top_bits,
    },
  };
}
