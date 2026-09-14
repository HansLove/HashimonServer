import { isUniqueViolation, query, withTransaction, type DbClient, type Sql } from "@/modules/core/db/pool";
import { audit } from "@/modules/core/domain/audit";
import { config } from "@/modules/core/config";
import {
  calibratedShareTargetBits,
  deriveExtranonce1,
  evaluateYield,
  rollYieldTier,
  minTier,
  MATERIAL_WINDOW,
  hashJob,
  verifyJobShare,
  type MiningJobRecord,
  type ShareSubmitInput,
  type JobHeader,
  type BitcoinShareSnapshot,
  type YieldTier,
} from "@/modules/core/core/pow";
import { getPreparedTemplate, type PreparedTemplate } from "@/modules/mining/domain/block-template";
import { harvestPlaceForPlayer, bumpHeat } from "@/modules/mining/domain/vibing";
import { foodFor, foodByKey } from "@/modules/mining/domain/foods";
import type { HashimonRow } from "@/modules/hashimon/domain/hashimons";
import { enrich } from "@/modules/core/http/wide-event";

type BitcoinPayload = NonNullable<MiningJobRecord["bitcoin"]>;
type StoredHeader = JobHeader & { templateId?: string; bitcoin?: BitcoinPayload };

export interface MiningJobRow {
  id: string;
  hashimon_id: string;
  owner_id: string;
  extranonce1: string;
  share_target_bits: number;
  block_target_bits: number;
  mode: "bound" | "legacy" | "bitcoin";
  header: JobHeader;
  expires_at: string;
  created_at: string;
}

function rowToJob(row: MiningJobRow): MiningJobRecord {
  const header = row.header as StoredHeader;
  return {
    id: row.id,
    hashimonId: row.hashimon_id,
    templateId: header.templateId ?? "",
    extranonce1: row.extranonce1,
    shareTargetBits: row.share_target_bits,
    blockTargetBits: row.block_target_bits,
    expiresAt: new Date(row.expires_at),
    mode: row.mode,
    header: row.header,
    bitcoin: row.mode === "bitcoin" ? header.bitcoin : undefined,
  };
}

export async function issueJob(row: HashimonRow): Promise<MiningJobRow> {
  const shareTargetBits = calibratedShareTargetBits();
  const extranonce1 = deriveExtranonce1(row.dna);
  const now = Date.now();

  const prepared = config.miningMode === "bitcoin" ? await getPreparedTemplate(now) : null;
  const { mode, header } = buildJobHeader(row, prepared, extranonce1, now);

  //Enriched here rather than in the route because this is where the degradation is
  //visible: template_fallback true means bitcoin mode was configured and the node
  //could not be reached, which until now was a silent downgrade to bound mode.
  enrich({
    job_mode: mode,
    share_target_bits: shareTargetBits,
    block_target_bits: config.blockTargetBits,
    template_id: prepared?.templateId ?? null,
    template_fallback: config.miningMode === "bitcoin" && !prepared,
    template_age_ms: prepared ? now - prepared.fetchedAt : null,
  });

  await query(`DELETE FROM mining_jobs WHERE hashimon_id = $1 AND expires_at < now()`, [row.id]);

  const res = await query<MiningJobRow>(
    `INSERT INTO mining_jobs (hashimon_id, owner_id, extranonce1, share_target_bits, block_target_bits, mode, header, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      row.id,
      row.owner_id,
      extranonce1,
      shareTargetBits,
      config.blockTargetBits,
      mode,
      JSON.stringify(header),
      new Date(now + config.jobTtlMs).toISOString(),
    ]
  );
  enrich({ job_id: res.rows[0]!.id });
  return res.rows[0]!;
}

/**
 * Pure — no I/O. Which mode a job gets and what header shape it's issued with, given whether
 * a template was available. Split out so the bound-vs-bitcoin branch (the auditor's
 * mode-selection concern) is unit-testable against a plain `PreparedTemplate | null` instead
 * of dragging in block-template's module cache or a live Bitcoin node — issueJob only
 * sequences the template fetch and the insert around it.
 */
export function buildJobHeader(
  row: HashimonRow,
  prepared: PreparedTemplate | null,
  extranonce1: string,
  now: number
): { mode: MiningJobRow["mode"]; header: StoredHeader } {
  if (!prepared) {
    return {
      mode: "bound",
      header: {
        version: 0x20000000,
        prevHash: "0000000000000000000000000000000000000000000000000000000000000000",
        merkleRoot: row.dna,
        timestamp: Math.floor(now / 1000),
        bits: "1d00ffff",
      },
    };
  }
  return {
    mode: "bitcoin",
    header: {
      version: parseInt(prepared.versionHex, 16),
      prevHash: prepared.prevhashBE,
      merkleRoot: row.dna,
      timestamp: prepared.curtime,
      bits: prepared.bits,
      templateId: prepared.templateId,
      bitcoin: { ...prepared, extranonce1 },
    },
  };
}

export async function getJobForOwner(jobId: string, ownerId: string): Promise<MiningJobRow | null> {
  const res = await query<MiningJobRow>(
    `SELECT * FROM mining_jobs WHERE id = $1 AND owner_id = $2 AND expires_at > now()`,
    [jobId, ownerId]
  );
  return res.rows[0] ?? null;
}

export function jobResponse(job: MiningJobRow, extranonce2Start: number) {
  const base = {
    jobId: job.id,
    templateId: job.hashimon_id,
    expiresAt: job.expires_at,
    shareTargetBits: job.share_target_bits,
    blockTargetBits: job.block_target_bits,
    extranonce1: job.extranonce1,
    extranonce2Start,
    header: job.header,
    dnaBinding: "verified" as const,
    mode: job.mode,
  };

  const bitcoin = (job.header as StoredHeader).bitcoin;
  if (job.mode !== "bitcoin" || !bitcoin) {
    return base;
  }

  const { prevhashBE, versionHex, bits, merkleBranch, coinbasePrefix, coinbaseSuffix, extranonce2Size, versionBits } = bitcoin;
  return {
    ...base,
    bitcoin: { prevhashBE, versionHex, bits, merkleBranch, coinbasePrefix, coinbaseSuffix, extranonce2Size, versionBits },
  };
}

export interface ShareSubmitBody {
  jobId: string;
  extranonce2: number;
  nonce: number;
  hash?: string;
  totalHashesAttempted?: number;
}

export async function submitShare(
  row: HashimonRow,
  body: ShareSubmitBody,
): Promise<{ ok: true; bits: number; hash: string; row: HashimonRow } | { ok: false; error: string; bits?: number; hash?: string }> {
  const jobRow = await getJobForOwner(body.jobId, row.owner_id);
  if (!jobRow || jobRow.hashimon_id !== row.id) {
    enrich({ reject_reason: "stale_job" });
    return { ok: false, error: "stale_job" };
  }
  //Age of the job the client mined against: separates "the TTL is too short" from
  //"this client took minutes to come back" when stale_job spikes.
  enrich({
    job_mode: jobRow.mode,
    job_age_ms: Date.now() - new Date(jobRow.created_at).getTime(),
    share_target_bits: jobRow.share_target_bits,
  });

  const job = rowToJob(jobRow);
  const submit: ShareSubmitInput = {
    jobId: body.jobId,
    extranonce2: body.extranonce2,
    nonce: body.nonce,
    hash: body.hash,
  };

  const result = verifyJobShare(job, row.dna, submit, new Set());
  enrich({ share_bits: result.bits });
  if (!result.accepted) {
    enrich({ reject_reason: result.error ?? "rejected" });
    return { ok: false, error: result.error ?? "rejected", bits: result.bits, hash: result.hash };
  }

  const dupCheck = await query(`SELECT 1 FROM submitted_shares WHERE hash = $1`, [result.hash]);
  if (dupCheck.rows.length > 0) {
    //precheck means the share was already stored; pg_23505 below means two requests
    //raced for the same hash. Only the second is a concurrency signal.
    enrich({ reject_reason: "duplicate_share", dup_source: "precheck" });
    return { ok: false, error: "duplicate_share", hash: result.hash };
  }

  //Read back after the transaction commits: an attempt that rolls back must not
  //leave the event claiming hashes and a best share that were never persisted.
  let isNewBest = false;
  let hashDelta = 0;
  try {
    const outcome = await withTransaction(async (client: DbClient) => {
      await query(
        `INSERT INTO submitted_shares (hash, hashimon_id, job_id, bits, extranonce2, nonce)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [result.hash, row.id, job.id, result.bits, body.extranonce2, body.nonce],
        client
      );

      hashDelta = typeof body.totalHashesAttempted === "number" && body.totalHashesAttempted > 0
        ? body.totalHashesAttempted
        : 0;
      const newExtranonce2 = Math.max(Number(row.extranonce2), body.extranonce2 + 1);
      const updateBest = result.bits > row.best_share_bits;
      isNewBest = updateBest;
      const bitcoinSnapshot: BitcoinShareSnapshot | null =
        job.mode === "bitcoin" && job.bitcoin
          ? {
              prevhashBE: job.bitcoin.prevhashBE,
              versionHex: job.bitcoin.versionHex,
              bits: job.bitcoin.bits,
              merkleBranch: job.bitcoin.merkleBranch,
              coinbasePrefix: job.bitcoin.coinbasePrefix,
              coinbaseSuffix: job.bitcoin.coinbaseSuffix,
              extranonce2Size: job.bitcoin.extranonce2Size,
              versionBits: job.bitcoin.versionBits,
              nTimeHex: job.header.timestamp.toString(16).padStart(8, "0"),
            }
          : null;

      const updateRes = await query<HashimonRow>(
        `UPDATE hashimons SET
           valid_shares = valid_shares + 1,
           extranonce2 = $2,
           total_hashes = total_hashes + $3,
           best_share_bits = CASE WHEN $4 THEN $5 ELSE best_share_bits END,
           best_share_hash = CASE WHEN $4 THEN $6 ELSE best_share_hash END,
           best_share_nonce = CASE WHEN $4 THEN $7 ELSE best_share_nonce END,
           best_share_extranonce2 = CASE WHEN $4 THEN $8 ELSE best_share_extranonce2 END,
           best_share_bitcoin = CASE WHEN $4 THEN $9 ELSE best_share_bitcoin END
         WHERE id = $1
         RETURNING *`,
        [
          row.id,
          newExtranonce2,
          hashDelta,
          updateBest,
          result.bits,
          result.hash,
          body.nonce,
          body.extranonce2,
          bitcoinSnapshot ? JSON.stringify(bitcoinSnapshot) : null,
        ],
        client
      );

      const updated = updateRes.rows[0]!;
      await audit(client, {
        playerId: row.owner_id,
        hashimonId: row.id,
        action: "share_accepted",
        detail: { jobId: job.id, bits: result.bits, hash: result.hash },
      });

      return { ok: true as const, bits: result.bits, hash: result.hash, row: updated };
    });
    enrich({
      is_new_best: isNewBest,
      best_share_bits: outcome.row.best_share_bits,
      hash_delta: hashDelta,
    });
    return outcome;
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      enrich({ reject_reason: "duplicate_share", dup_source: "pg_23505" });
      return { ok: false, error: "duplicate_share", hash: result.hash };
    }
    throw err;
  }
}

export interface YieldSubmitBody {
  jobId: string;
  extranonce2: number;
  nonce: number;
}

export type YieldOutcome =
  | {
      ok: true;
      tier: YieldTier;
      materialKey: string;
      yieldBits: number;
      hash: string;
      /** The named item within the tier (foods.ts). */
      foodKey: string;
      foodName: string;
    }
  | { ok: false; error: string; yieldBits?: number };

/**
 * PoW YIELD submission — the second harvest (docs/POW_YIELD_V1.md, VIBING_V1.md §2). Same
 * body as a share, but the floor is the YIELD window, not the share-target bits: most yield
 * hashes are BELOW the share threshold, which is the whole point (harvest work otherwise
 * discarded). The server recomputes the hash and dedupes by `hash` (PK), so the same hash —
 * or a submit to both routes — drops once.
 *
 * Three independent axes decide the drop, and the player steers none of them (VIBING_V1.md
 * §2, the "player never chooses" law):
 *  - WORK (event): the hash's yield window clearing the floor is the strike — you FOUND
 *    something. Below it: `no_yield`.
 *  - PLACE (ceiling): your Vibing tower's coordinate `zona(x,z)` caps the tier. No town or
 *    tower → the consumable floor at your vault; every harvest heats that place.
 *  - LUCK (roll): a disjoint hash window rolls the tier UNDER the place ceiling, weighted so
 *    food dominates and capital is rarest. `minTier(rolled, ceiling)` is the harvested tier.
 * All three are resolved server-side by recomputation, so a tier is never a client claim.
 * The hash's own strike depth is kept only as `yield_bits` telemetry.
 */
export async function submitYield(row: HashimonRow, body: YieldSubmitBody): Promise<YieldOutcome> {
  const jobRow = await getJobForOwner(body.jobId, row.owner_id);
  if (!jobRow || jobRow.hashimon_id !== row.id) {
    enrich({ reject_reason: "stale_job" });
    return { ok: false, error: "stale_job" };
  }
  const job = rowToJob(jobRow);

  // Same binding as verifyJobShare, minus the share-bits floor (yield has its own floor).
  if (job.expiresAt.getTime() < Date.now()) return { ok: false, error: "stale_job" };
  if (job.extranonce1 !== deriveExtranonce1(row.dna)) return { ok: false, error: "dna_mismatch" };
  if (!Number.isInteger(body.extranonce2) || body.extranonce2 < 0) return { ok: false, error: "invalid_nonce" };
  if (!Number.isInteger(body.nonce) || body.nonce < 0 || body.nonce > 0xffffffff) {
    return { ok: false, error: "invalid_nonce" };
  }

  const hash = hashJob(job, body.extranonce2, body.nonce);
  const drop = evaluateYield(hash);
  // The WORK gate: the yield window must clear the floor (drop.tier != null) to be a strike.
  if (!drop.tier) {
    enrich({ yield_bits: drop.yieldBits, yield_tier: "none" });
    return { ok: false, error: "no_yield", yieldBits: drop.yieldBits };
  }

  // PLACE is the ceiling, LUCK is a roll under it — the player never chooses (VIBING_V1
  // §2). The tower's zone caps what a coordinate can ever yield; a disjoint hash window
  // rolls the tier under that cap, weighted so food dominates and capital is rarest. A
  // food zone can only give food; a capital zone gives all three, capital seldom.
  const spot = await harvestPlaceForPlayer(row.owner_id);
  const rolled = rollYieldTier(hash);
  const tier = minTier(rolled, spot.tier);
  // Which named item within the tier (the food graph) — weighted by the material window.
  const food = foodFor(drop.materialKey, tier);
  enrich({
    yield_bits: drop.yieldBits,
    yield_rolled: rolled,
    yield_ceiling: spot.tier,
    yield_tier: tier,
    yield_place: spot.place,
    yield_food: food.key,
  });

  try {
    await withTransaction(async (client: DbClient) => {
      await query(
        `INSERT INTO pow_yield
           (hash, hashimon_id, owner_id, job_id, yield_bits, tier, material_key, extranonce2, nonce, place, food_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [hash, row.id, row.owner_id, job.id, drop.yieldBits, tier, drop.materialKey,
         body.extranonce2, body.nonce, spot.place, food.key],
        client
      );
      await bumpHeat(spot, client);
      await audit(client, {
        playerId: row.owner_id,
        hashimonId: row.id,
        action: "yield_harvested",
        detail: { jobId: job.id, tier, food: food.key, materialKey: drop.materialKey, yieldBits: drop.yieldBits, place: spot.place },
      });
    });
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      enrich({ reject_reason: "duplicate_yield" });
      return { ok: false, error: "duplicate_yield" };
    }
    throw err;
  }

  return { ok: true, tier, materialKey: drop.materialKey, yieldBits: drop.yieldBits, hash, foodKey: food.key, foodName: food.name };
}

export interface YieldSummary {
  total: number;
  byTier: Record<YieldTier, number>;
  /** Unspent consumable yields — the Hashi-croqueta stock for Alimentar. */
  croquetas: number;
}

/** Unspent Hashi-croquetas for this creature (consumable yields with no consumed_at). */
export async function croquetaBalance(hashimonId: string, client?: Sql): Promise<number> {
  const sql =
    `SELECT count(*)::text AS n FROM pow_yield
      WHERE hashimon_id = $1 AND tier = 'consumable' AND consumed_at IS NULL`;
  const res = client
    ? await query<{ n: string }>(sql, [hashimonId], client)
    : await query<{ n: string }>(sql, [hashimonId]);
  return Number(res.rows[0]?.n ?? 0);
}

/**
 * Spend one croqueta (FIFO). Returns false if the creature has none left.
 * Caller must run this inside a transaction when paired with care(hunger).
 */
export async function consumeCroqueta(hashimonId: string, client: DbClient): Promise<boolean> {
  const res = await query<{ hash: string }>(
    `UPDATE pow_yield
        SET consumed_at = now()
      WHERE hash = (
        SELECT hash FROM pow_yield
         WHERE hashimon_id = $1 AND tier = 'consumable' AND consumed_at IS NULL
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING hash`,
    [hashimonId],
    client
  );
  return res.rows.length > 0;
}

/** What a creature has harvested so far, counted per tier (for the client to show). */
export async function yieldSummary(hashimonId: string): Promise<YieldSummary> {
  const res = await query<{ tier: YieldTier; n: string }>(
    `SELECT tier, count(*)::text AS n FROM pow_yield WHERE hashimon_id = $1 GROUP BY tier`,
    [hashimonId]
  );
  const byTier: Record<YieldTier, number> = { consumable: 0, durable: 0, capital: 0 };
  let total = 0;
  for (const r of res.rows) {
    const n = Number(r.n);
    byTier[r.tier] = n;
    total += n;
  }
  const croquetas = await croquetaBalance(hashimonId);
  return { total, byTier, croquetas };
}

export interface FoodStack {
  key: string;
  name: string;
  tier: YieldTier;
  /** Unspent count of this food in the creature's larder. */
  count: number;
}

/**
 * The creature's larder grouped by named food — what the food-graph UI shows. Only UNSPENT
 * yields count (a consumed croqueta is gone). `food_key` is a stored convenience; a row from
 * before the food graph (null food_key) is re-derived from its hash+tier so nothing is lost.
 */
export async function foodInventory(hashimonId: string): Promise<FoodStack[]> {
  const res = await query<{ food_key: string | null; tier: YieldTier; hash: string }>(
    `SELECT food_key, tier, hash FROM pow_yield
      WHERE hashimon_id = $1 AND consumed_at IS NULL`,
    [hashimonId]
  );
  const counts = new Map<string, number>();
  for (const r of res.rows) {
    // Re-derive the food for legacy rows written before food_key existed.
    const key = r.food_key ?? foodFor(hashToMaterialKey(r.hash), r.tier).key;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const out: FoodStack[] = [];
  for (const [key, count] of counts) {
    const f = foodByKey(key);
    if (f) out.push({ key: f.key, name: f.name, tier: f.tier, count });
  }
  // Rarest (lowest weight) first, then by name — the treats sit at the top of the list.
  out.sort((a, b) => (foodByKey(a.key)!.weight - foodByKey(b.key)!.weight) || a.name.localeCompare(b.name));
  return out;
}

/** The material window of a stored hash — same slice evaluateYield used to write it. */
function hashToMaterialKey(hash: string): string {
  return hash.toLowerCase().replace(/^0x/, "").slice(MATERIAL_WINDOW.start, MATERIAL_WINDOW.end);
}
