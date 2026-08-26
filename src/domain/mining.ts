import { isUniqueViolation, query, withTransaction, type DbClient } from "@/db/pool";
import { audit } from "@/domain/audit";
import { config } from "@/config";
import {
  calibratedShareTargetBits,
  deriveExtranonce1,
  verifyJobShare,
  type MiningJobRecord,
  type ShareSubmitInput,
  type JobHeader,
  type BitcoinShareSnapshot,
} from "@/core/pow";
import { getPreparedTemplate } from "@/domain/block-template";
import type { HashimonRow } from "@/domain/hashimons";
import { enrich } from "@/http/wide-event";

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
  const mode: MiningJobRow["mode"] = prepared ? "bitcoin" : "bound";

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

  const header: StoredHeader = prepared
    ? {
        version: parseInt(prepared.versionHex, 16),
        prevHash: prepared.prevhashBE,
        merkleRoot: row.dna,
        timestamp: prepared.curtime,
        bits: prepared.bits,
        templateId: prepared.templateId,
        bitcoin: { ...prepared, extranonce1 },
      }
    : {
        version: 0x20000000,
        prevHash: "0000000000000000000000000000000000000000000000000000000000000000",
        merkleRoot: row.dna,
        timestamp: Math.floor(now / 1000),
        bits: "1d00ffff",
      };

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
