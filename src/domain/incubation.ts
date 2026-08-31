import { randomBytes } from "node:crypto";
import { isUniqueViolation, query, withTransaction, type DbClient } from "@/db/pool";
import { AppError } from "@/http/errors";
import { enrich } from "@/http/wide-event";
import { audit } from "@/domain/audit";
import { config } from "@/config";
import {
  BITS_PER_STAR,
  hashBitcoinJob,
  leadingZeroBits,
  progressionFromBits,
  stratumPrevHashToBE,
  type BitcoinShareSnapshot,
} from "@/core/index";

//Assisted incubation: the player buys marks of high entropy that CaosEngine's pool mines
//on their creature's behalf. This is the second and last path by which players.credits
//moves — the first is domain/payments.ts, and this module borrows its whole discipline:
//
//  - one live lot per player          → caos_lots_active_per_player_idx (23505 → 409)
//  - a mark counted exactly once      → submitted_shares PK + (lot, index) unique index
//  - every transition decided here    → UPDATE ... WHERE status IN (...) RETURNING *
//
//The referee rule holds without exception: nothing here trusts what the pool reports. Every
//mark is re-hashed from the template the pool shipped with it, and is only counted if the
//recomputed header matches the hash claimed AND its coinbase commits to this creature's DNA.
//A pool that lied, or that mined for somebody else, is rejected and the mark is not paid for.

export type LotStatus =
  | "queued"
  | "assigned"
  | "mining"
  | "complete"
  | "partial"
  | "failed"
  | "expired";

/** The states in which a lot holds the per-player unique index. */
export const LIVE_STATUSES: LotStatus[] = ["queued", "assigned", "mining"];

export const MIN_SHARES = 1;
export const MAX_SHARES = 50;

//The star floor CaosEngine is asked for. Product decision P1: a mark is 12 stars or better.
export const REQUESTED_STARS = 12;

//A lot stuck in `queued` never reached CaosEngine — the process died between the INSERT and
//the outbound POST. Nothing will ever arrive for it, and it holds the per-player index, so it
//is written off (in full) rather than left to block the player forever. This is NOT P9's clock:
//once CaosEngine has accepted the batch the lot is `assigned`, and waiting in *its* queue is
//free (§6.1 — a healthy lot must never refund itself for being queued).
const QUEUED_GRACE_MS = 10 * 60 * 1000;

//How long a closed lot keeps answering GET /hashimons/:id/incubation. P15 says a player who
//closed the tab sees the result applied when they come back; a terminal lot that vanished the
//instant it closed would make the "complete" and "refunded" screens unreachable in practice.
export const CLOSED_LOT_VISIBLE_MS = 24 * 60 * 60 * 1000;

export interface LotRow {
  id: string;
  hashimon_id: string;
  owner_id: string;
  shares_requested: number;
  shares_delivered: number;
  credits_charged: number;
  credits_refunded: number;
  stars_before: number;
  stars_requested: number;
  best_bits: number | null;
  best_share_index: number | null;
  status: LotStatus;
  caos_request_id: string | null;
  webhook_secret: string;
  btc_address: string;
  created_at: Date;
  assigned_at: Date | null;
  closed_at: Date | null;
}

/** The client's UI phase *is* `status`; it runs no state machine of its own. */
export function presentLot(row: LotRow) {
  const bestStars = row.best_bits == null ? 0 : progressionFromBits(row.best_bits).stars;
  return {
    id: row.id,
    status: row.status,
    sharesRequested: row.shares_requested,
    sharesDelivered: row.shares_delivered,
    creditsCharged: row.credits_charged,
    creditsRefunded: row.credits_refunded,
    starsBefore: row.stars_before,
    bestStars,
    //Which mark got there, so the client can point at it rather than only name the result.
    bestShareIndex: row.best_share_index,
    //Stars, not bits: a mark can raise the record without raising the star count, and to the
    //player that is not a mutation. Announcing one that isn't visible would read as a lie.
    mutated: bestStars > row.stars_before,
    createdAt: row.created_at.toISOString(),
    assignedAt: row.assigned_at ? row.assigned_at.toISOString() : null,
    closedAt: row.closed_at ? row.closed_at.toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// Pricing

interface PricingRow {
  min_shares: number;
  max_shares: number;
  credits_per_share: string; //numeric — pg hands it back as a string
  discount_pct: string;
}

export interface PricingTier {
  minShares: number;
  maxShares: number;
  /** ALREADY net of the tier's discount — the client multiplies by the count, nothing else. */
  creditsPerShare: number;
  /** A label for the UI ("2% off"), never a second multiplication. */
  discountPct: number;
}

function toTier(row: PricingRow): PricingTier {
  const list = Number(row.credits_per_share);
  const discount = Number(row.discount_pct);
  return {
    minShares: row.min_shares,
    maxShares: row.max_shares,
    creditsPerShare: list * (1 - discount / 100),
    discountPct: discount,
  };
}

//The ladder is stored as list price + discount because that is the readable form to edit with
//an UPDATE. It is PUBLISHED already multiplied out, so a client cannot apply the discount a
//second time — the same reason a purchase carries a count and never an amount.
export async function pricingTiers(): Promise<PricingTier[]> {
  const res = await query<PricingRow>(
    `SELECT min_shares, max_shares, credits_per_share, discount_pct
       FROM caos_pricing ORDER BY min_shares`
  );
  return res.rows.map(toTier);
}

export interface Quote {
  shares: number;
  creditsPerShare: number;
  discountPct: number;
  credits: number;
}

/** What a lot of `shares` marks costs. The only place a price is ever computed. */
export async function quoteFor(shares: number): Promise<Quote> {
  if (!Number.isInteger(shares) || shares < MIN_SHARES || shares > MAX_SHARES) {
    throw new AppError(
      400,
      `quoteFor: a lot is between ${MIN_SHARES} and ${MAX_SHARES} marks`,
      "invalid_lot_size"
    );
  }
  const res = await query<PricingRow>(
    `SELECT min_shares, max_shares, credits_per_share, discount_pct
       FROM caos_pricing WHERE $1 BETWEEN min_shares AND max_shares
       ORDER BY min_shares DESC LIMIT 1`,
    [shares]
  );
  const row = res.rows[0];
  if (!row) {
    //A hole in the ladder is an operator error, not a client error: refuse to invent a price.
    throw new AppError(503, `quoteFor: no price tier covers ${shares} marks`, "pricing_unavailable");
  }
  const tier = toTier(row);
  //Rounded on the TOTAL, not on the unit price: 25 x 9.65 = 241.25 → 241, which is the
  //number the product ladder documents. Rounding per unit first would drift.
  return { ...tier, shares, credits: Math.round(shares * tier.creditsPerShare) };
}

// ---------------------------------------------------------------------------
// Reads

/** The lot the player is currently waiting on, if any. */
export async function activeLotFor(playerId: string): Promise<LotRow | null> {
  await expireStaleLots();
  const res = await query<LotRow>(
    `SELECT * FROM caos_lots
      WHERE owner_id = $1 AND status = ANY($2::text[])
      ORDER BY created_at DESC LIMIT 1`,
    [playerId, LIVE_STATUSES]
  );
  return res.rows[0] ?? null;
}

/**
 * What GET /hashimons/:id/incubation answers with: the live lot, or the one that just
 * closed. Scoped by owner — a lot id must not be readable by whoever guesses a creature id.
 */
export async function lotForHashimon(hashimonId: string, playerId: string): Promise<LotRow | null> {
  await expireStaleLots();
  const res = await query<LotRow>(
    `SELECT * FROM caos_lots
      WHERE hashimon_id = $1 AND owner_id = $2
        AND (status = ANY($3::text[]) OR closed_at > now() - ($4 || ' milliseconds')::interval)
      ORDER BY (status = ANY($3::text[])) DESC, created_at DESC
      LIMIT 1`,
    [hashimonId, playerId, LIVE_STATUSES, String(CLOSED_LOT_VISIBLE_MS)]
  );
  return res.rows[0] ?? null;
}

export async function lotBySecret(secret: string): Promise<LotRow | null> {
  const res = await query<LotRow>(`SELECT * FROM caos_lots WHERE webhook_secret = $1`, [secret]);
  return res.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Opening a lot

/**
 * Charge the player and open the lot — both in one transaction, so a lot can never exist
 * unpaid and credits can never leave without a lot to show for it.
 *
 * The row is written BEFORE anything reaches CaosEngine (the caller does that next, then
 * calls markAssigned). Same order as createPayment, for the same reason: the partial unique
 * index must reject a duplicate lot before an external batch exists that nobody will collect.
 */
export async function createLot(input: {
  playerId: string;
  hashimonId: string;
  shares: number;
  starsBefore: number;
  btcAddress: string;
  /** The floor this lot buys. Only the product rule ever sets it; there is no route that
   *  lets a client choose, because the price ladder is priced for this floor and no other. */
  starsRequested?: number;
}): Promise<LotRow> {
  const quote = await quoteFor(input.shares);
  await expireStaleLots();

  try {
    return await withTransaction(async (client) => {
      //Conditional debit: `credits >= $2` in the WHERE is what makes two simultaneous
      //purchases unable to overdraw, without a SELECT ... FOR UPDATE.
      const debited = await query<{ credits: number }>(
        `UPDATE players SET credits = credits - $2
          WHERE id = $1 AND credits >= $2
          RETURNING credits`,
        [input.playerId, quote.credits],
        client
      );
      if (!debited.rows[0]) {
        throw new AppError(
          402,
          "createLot: not enough credits for this lot",
          "insufficient_credits"
        );
      }

      const res = await query<LotRow>(
        `INSERT INTO caos_lots
           (hashimon_id, owner_id, shares_requested, credits_charged, stars_before,
            stars_requested, webhook_secret, btc_address)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          input.hashimonId,
          input.playerId,
          input.shares,
          quote.credits,
          input.starsBefore,
          input.starsRequested ?? REQUESTED_STARS,
          randomBytes(32).toString("hex"),
          input.btcAddress,
        ],
        client
      );
      const lot = res.rows[0]!;

      await audit(client, {
        playerId: input.playerId,
        hashimonId: input.hashimonId,
        action: "incubation.lot_opened",
        detail: {
          lotId: lot.id,
          shares: input.shares,
          credits: quote.credits,
          creditsPerShare: quote.creditsPerShare,
          discountPct: quote.discountPct,
          starsBefore: input.starsBefore,
        },
      });
      enrich({
        lot_id: lot.id,
        lot_shares: input.shares,
        credits_charged: quote.credits,
        credits_after: debited.rows[0].credits,
      });
      return lot;
    });
  } catch (err: unknown) {
    //No pre-SELECT: the partial unique index is what makes this race-free between two tabs.
    //The route turns this into 409 + the live lot in the body.
    if (isUniqueViolation(err, "caos_lots_active_per_player_idx")) {
      throw new AppError(
        409,
        "createLot: this player already has a lot in the incubator",
        "incubation_pending"
      );
    }
    throw err;
  }
}

/**
 * CaosEngine accepted the batch. This is where P9's one-hour clock starts.
 *
 * It is an approximation and worth naming: CaosEngine has no "a miner picked this up" event,
 * so a batch of ours that sits in *its* queue is already counted as assigned here. The
 * timeout is 10x the longest lot's real duration, so the slack absorbs it — but if that queue
 * ever gets genuinely deep, the honest fix is to ask CaosEngine for the event, not to raise
 * the timeout.
 */
export async function markAssigned(lotId: string, caosRequestId: string): Promise<LotRow | null> {
  const res = await query<LotRow>(
    `UPDATE caos_lots
        SET status = 'assigned', caos_request_id = $2, assigned_at = now()
      WHERE id = $1 AND status = 'queued'
      RETURNING *`,
    [lotId, caosRequestId]
  );
  return res.rows[0] ?? null;
}

/**
 * CaosEngine refused the batch, or was unreachable. Safe to write off in full precisely
 * because no batch exists on their side: nothing can ever arrive against this lot.
 */
export async function markFailed(lotId: string, reason: string): Promise<LotRow | null> {
  return closeLotById(lotId, "failed", reason);
}

// ---------------------------------------------------------------------------
// Marks arriving

/** One mark, exactly as CaosEngine delivers it (spoon's SharePayload with provenance). */
export interface CaosSharePayload {
  requestId: string;
  version: string;
  nonce: number;
  hash: string;
  prevHash: string;
  bits: string;
  timestamp: number;
  merkleBranch: string[];
  coinbasePrefix: string;
  coinbaseSuffix: string;
  extranonce1: string;
  extranonce2: string;
  extranonce2Size: number;
  opReturn?: string;
  shareIndex: number;
  sharesTotal?: number;
  stars?: number;
  leadingZeros?: number;
  isBlock?: boolean;
}

/**
 * Adapt the pool's wire format to the Caos Core's. Two conversions and nothing else:
 * prevhash comes word-swabbed in Stratum order, and nTime is a number, not hex. `versionBits`
 * is null on purpose — spoon has already rolled the version (BIP310), so re-applying the
 * mask would corrupt a header that is otherwise correct.
 */
export function snapshotOf(payload: CaosSharePayload): BitcoinShareSnapshot {
  return {
    prevhashBE: stratumPrevHashToBE(payload.prevHash),
    versionHex: payload.version,
    versionBits: null,
    bits: payload.bits,
    merkleBranch: payload.merkleBranch,
    coinbasePrefix: payload.coinbasePrefix,
    coinbaseSuffix: payload.coinbaseSuffix,
    extranonce2Size: payload.extranonce2Size,
    extranonce1: payload.extranonce1,
    extranonce2: payload.extranonce2,
    nTimeHex: payload.timestamp.toString(16).padStart(8, "0"),
  };
}

export type ShareVerdict =
  | { ok: true; bits: number; snapshot: BitcoinShareSnapshot }
  | { ok: false; error: string };

/**
 * Recompute the mark and prove it belongs to this creature. Three independent checks, and all
 * of them have to hold:
 *
 *  1. The header rebuilt from the template the pool shipped hashes to the hash it claimed.
 *     A pool that inflates `leadingZeros`, or invents a hash outright, fails here.
 *  2. The coinbase — which is what the merkle root commits to — carries this creature's DNA.
 *     Without this a pool could bill one player for another's work, or replay one mark
 *     across every creature it has ever mined for.
 *  3. The recomputed hash actually clears the star floor the lot paid for. Checks 1 and 2
 *     only prove the mark is *ours*; they say nothing about it being worth anything. A
 *     header with `nonce: 0` and this creature's DNA passes both and costs nothing to
 *     produce — without this check a pool could deliver fifty of them, close the lot
 *     `complete`, owe no refund, and leave the creature exactly as it was.
 *
 * The DNA commitment is accepted in either encoding CaosEngine may have used for the
 * `op_return` parameter: the raw 32 bytes of the DNA, or the ASCII of its hex string. Being
 * strict about *which* one buys nothing — both prove the same binding — while guessing wrong
 * would reject every honest mark.
 */
export function verifyShare(
  payload: CaosSharePayload,
  dna: string,
  minBits: number = REQUESTED_STARS * BITS_PER_STAR
): ShareVerdict {
  let snapshot: BitcoinShareSnapshot;
  let hashBE: string;
  try {
    //Inside the try because the adaptation itself can refuse: a prevhash that is not a whole
    //number of 4-byte words is a wire-format change, and saying so beats reporting the pool
    //for a mismatch it did not cause.
    snapshot = snapshotOf(payload);
    hashBE = hashBitcoinJob({
      ...snapshot,
      extranonce1: payload.extranonce1,
      extranonce2: payload.extranonce2,
      nonceHex: payload.nonce.toString(16).padStart(8, "0"),
    }).hashBE;
  } catch {
    //A template that cannot be rebuilt at all. Reachable from the route only for lengths the
    //schema does not pin, since it rejects non-hex before this is ever called — but domain
    //code must not assume its only caller is that route.
    return { ok: false, error: "malformed_template" };
  }

  if (hashBE.toLowerCase() !== payload.hash.toLowerCase()) {
    return { ok: false, error: "hash_mismatch" };
  }

  const coinbase = (
    payload.coinbasePrefix + payload.extranonce1 + payload.extranonce2 + payload.coinbaseSuffix
  ).toLowerCase();
  const dnaHex = dna.toLowerCase();
  const dnaAsAscii = Buffer.from(dnaHex, "utf8").toString("hex");
  if (!coinbase.includes(dnaHex) && !coinbase.includes(dnaAsAscii)) {
    return { ok: false, error: "dna_not_committed" };
  }

  //The floor is the one the lot bought, not the one the pool claims to have hit: `stars` and
  //`leadingZeros` travel in the payload and are worth exactly as much as any other number a
  //pool reports. Only the recomputed hash counts.
  const bits = leadingZeroBits(hashBE);
  if (bits < minBits) {
    return { ok: false, error: "below_floor" };
  }

  return { ok: true, bits, snapshot };
}

export type ApplyShareResult =
  | { ok: true; duplicate: false; bits: number; isNewBest: boolean; lot: LotRow }
  | { ok: true; duplicate: true; lot: LotRow }
  | { ok: false; error: string };

/**
 * Record one delivered mark against a live lot, and mutate the creature if the mark beats
 * its record. Redelivery is the normal case, not an error: CaosEngine resends, and the two
 * unique indexes (the share hash, and this lot's position) are what make a repeat a no-op
 * instead of a double count.
 */
export async function applyShare(lot: LotRow, payload: CaosSharePayload): Promise<ApplyShareResult> {
  if (!LIVE_STATUSES.includes(lot.status)) {
    return { ok: false, error: "lot_closed" };
  }
  if (lot.caos_request_id && payload.requestId !== lot.caos_request_id) {
    return { ok: false, error: "request_mismatch" };
  }

  const creature = await query<{ id: string; dna: string; best_share_bits: number }>(
    `SELECT id, dna, best_share_bits FROM hashimons WHERE id = $1`,
    [lot.hashimon_id]
  );
  const row = creature.rows[0];
  if (!row) {
    return { ok: false, error: "hashimon_gone" };
  }

  const verdict = verifyShare(payload, row.dna, lot.stars_requested * BITS_PER_STAR);
  if (!verdict.ok) {
    enrich({ share_reject_reason: verdict.error, lot_id: lot.id });
    return { ok: false, error: verdict.error };
  }

  try {
    return await applyVerifiedShare(lot, payload, row, verdict);
  } catch (err: unknown) {
    if (err instanceof LotClosedDuringApply) {
      enrich({ share_reject_reason: "lot_closed", lot_id: lot.id });
      return { ok: false, error: "lot_closed" };
    }
    throw err;
  }
}

/** Thrown from inside the transaction to roll it back when the lot turned out to be settled
 *  after all. Not an AppError: a mark the ledger declines is answered 200, like every other
 *  refusal on that webhook — it is a decision, not a delivery failure. */
class LotClosedDuringApply extends Error {}

async function applyVerifiedShare(
  lot: LotRow,
  payload: CaosSharePayload,
  row: { id: string; dna: string; best_share_bits: number },
  verdict: Extract<ShareVerdict, { ok: true }>
): Promise<ApplyShareResult> {
  return withTransaction(async (client: DbClient) => {
    //ON CONFLICT DO NOTHING over BOTH doors: the global hash PK, and this lot's position.
    //An empty result means we have already counted this mark — say so and change nothing.
    const inserted = await query(
      `INSERT INTO submitted_shares
         (hash, hashimon_id, job_id, bits, extranonce2, nonce, origin, caos_lot_id, share_index)
       VALUES ($1, $2, NULL, $3, NULL, $4, 'caos', $5, $6)
       ON CONFLICT DO NOTHING
       RETURNING hash`,
      [payload.hash, row.id, verdict.bits, payload.nonce, lot.id, payload.shareIndex],
      client
    );
    if (inserted.rows.length === 0) {
      enrich({ share_redelivery: true, lot_id: lot.id });
      return { ok: true as const, duplicate: true as const, lot };
    }

    //The record is decided against the COLUMN, never against the value read before the
    //transaction opened. A player browser-mining while their lot runs is two writers on one
    //creature, and comparing against a stale read lets the slower one overwrite a better
    //mark with a worse one. Every branch below reads the same pre-UPDATE best_share_bits, so
    //the whole row moves together or not at all.
    const bested = await query<{ is_new_best: boolean }>(
      `UPDATE hashimons SET
         valid_shares = valid_shares + 1,
         best_share_hash = CASE WHEN $2 > best_share_bits THEN $3 ELSE best_share_hash END,
         best_share_nonce = CASE WHEN $2 > best_share_bits THEN $4 ELSE best_share_nonce END,
         best_share_extranonce2 = CASE WHEN $2 > best_share_bits THEN NULL ELSE best_share_extranonce2 END,
         best_share_bitcoin = CASE WHEN $2 > best_share_bits THEN $5 ELSE best_share_bitcoin END,
         best_share_bits = GREATEST(best_share_bits, $2)
       WHERE id = $1
       RETURNING (best_share_hash = $3) AS is_new_best`,
      [row.id, verdict.bits, payload.hash, payload.nonce, JSON.stringify(verdict.snapshot)],
      client
    );
    //Safe as an identity test: the hash was just inserted into submitted_shares, whose PK is
    //global, so no earlier mark on any creature can be carrying it.
    const isNewBest = bested.rows[0]?.is_new_best === true;

    //The lot closes itself the moment the last mark lands. Waiting for CaosEngine's closing
    //event would leave a finished lot sitting in `mining`, blocking the player's next one.
    const updated = await query<LotRow>(
      `UPDATE caos_lots SET
         shares_delivered = shares_delivered + 1,
         best_bits = GREATEST(COALESCE(best_bits, 0), $2),
         -- Strictly greater, and against -1 so the very first mark always claims the slot:
         -- on a tie the earlier mark keeps it, because it is the one that got there first.
         best_share_index = CASE WHEN $2 > COALESCE(best_bits, -1) THEN $3 ELSE best_share_index END,
         assigned_at = COALESCE(assigned_at, now()),
         status = CASE WHEN shares_delivered + 1 >= shares_requested THEN 'complete' ELSE 'mining' END,
         closed_at = CASE WHEN shares_delivered + 1 >= shares_requested THEN now() ELSE closed_at END
       WHERE id = $1 AND status = ANY($4::text[])
       RETURNING *`,
      [lot.id, verdict.bits, payload.shareIndex, LIVE_STATUSES],
      client
    );
    //The live check at the top of this function read a row that a stale sweep or a closing
    //event may have terminated since. Without the guard in the WHERE, this UPDATE would put
    //a closed lot back into `mining` — and a resurrected lot passes closeLotById's own live
    //check a second time, paying its refund twice. Roll back: a mark that arrives after the
    //lot is settled is not delivery, and must leave no trace of having been counted.
    const lotAfter = updated.rows[0];
    if (!lotAfter) {
      throw new LotClosedDuringApply();
    }

    await audit(client, {
      playerId: lot.owner_id,
      hashimonId: row.id,
      action: "incubation.mark_applied",
      detail: {
        lotId: lot.id,
        shareIndex: payload.shareIndex,
        bits: verdict.bits,
        hash: payload.hash,
        isNewBest,
      },
    });
    enrich({
      lot_id: lot.id,
      lot_status: lotAfter.status,
      share_index: payload.shareIndex,
      share_bits: verdict.bits,
      share_is_new_best: isNewBest,
      shares_delivered: lotAfter.shares_delivered,
    });

    return { ok: true as const, duplicate: false as const, bits: verdict.bits, isNewBest, lot: lotAfter };
  });
}

// ---------------------------------------------------------------------------
// Closing and refunding

/** Undelivered marks come back at exactly the price paid — the charge, prorated (P8/§6.2). */
export function refundFor(lot: Pick<LotRow, "credits_charged" | "shares_requested" | "shares_delivered">): number {
  const undelivered = Math.max(0, lot.shares_requested - lot.shares_delivered);
  if (undelivered === 0) {
    return 0;
  }
  return Math.round((lot.credits_charged * undelivered) / lot.shares_requested);
}

/**
 * The only exit from a live lot, and the only place credits come back.
 *
 * `WHERE status = ANY(live) RETURNING *` is what makes a refund once-only: CaosEngine
 * redelivers its closing event just as it redelivers marks, so a repeat is expected and
 * lands on zero rows. Refund and status move in one transaction — a lot marked `partial`
 * whose credits never came back is the one failure a player would be right to be angry about.
 *
 * CaosEngine does not refund us. Hashimon eats the cost of the marks already mined; at the
 * margin this product runs on, being the one who makes the player whole is cheap.
 */
export async function closeLotById(
  lotId: string,
  status: Extract<LotStatus, "complete" | "partial" | "failed" | "expired">,
  reason?: string
): Promise<LotRow | null> {
  return withTransaction(async (client) => {
    const res = await query<LotRow>(
      `UPDATE caos_lots
          SET status = $2, closed_at = now()
        WHERE id = $1 AND status = ANY($3::text[])
        RETURNING *`,
      [lotId, status, LIVE_STATUSES],
      client
    );
    const lot = res.rows[0];
    if (!lot) {
      return null;
    }

    const refund = refundFor(lot);
    if (refund > 0) {
      await query(`UPDATE players SET credits = credits + $2 WHERE id = $1`, [lot.owner_id, refund], client);
      await query(`UPDATE caos_lots SET credits_refunded = $2 WHERE id = $1`, [lot.id, refund], client);
      lot.credits_refunded = refund;
    }

    await audit(client, {
      playerId: lot.owner_id,
      hashimonId: lot.hashimon_id,
      action: "incubation.lot_closed",
      detail: {
        lotId: lot.id,
        status,
        reason: reason ?? null,
        sharesRequested: lot.shares_requested,
        sharesDelivered: lot.shares_delivered,
        creditsCharged: lot.credits_charged,
        creditsRefunded: refund,
      },
    });
    enrich({
      lot_id: lot.id,
      lot_status: status,
      lot_close_reason: reason ?? null,
      shares_delivered: lot.shares_delivered,
      credits_refunded: refund,
    });
    return lot;
  });
}

/** CaosEngine's closing event vocabulary → ours. Anything unknown is a failure, not a silent drop. */
export function statusForTermination(caosStatus: string, delivered: number, requested: number): Extract<LotStatus, "complete" | "partial" | "failed"> {
  if (caosStatus === "completed" || delivered >= requested) {
    return "complete";
  }
  return delivered > 0 ? "partial" : "failed";
}

/**
 * Two ways a lot can rot, both of which would otherwise hold the per-player index forever:
 * a `queued` lot whose outbound POST never happened, and an `assigned`/`mining` lot whose
 * miner hung. One pass, no cron — called from the read paths, exactly like expireStaleCharges.
 *
 * Note what is NOT expired by elapsed time alone: a lot legitimately waiting in CaosEngine's
 * queue. Its clock starts at assignment (P9/§6.1), which is why `assigned_at` and not
 * `created_at` is the column in the second WHERE.
 */
export async function expireStaleLots(): Promise<void> {
  const res = await query<{ id: string; status: LotStatus }>(
    `SELECT id, status FROM caos_lots
      WHERE (status = 'queued' AND created_at < now() - ($1 || ' milliseconds')::interval)
         OR (status IN ('assigned', 'mining') AND assigned_at < now() - ($2 || ' milliseconds')::interval)`,
    [String(QUEUED_GRACE_MS), String(config.incubationLotTimeoutMs)]
  );
  for (const row of res.rows) {
    //A queued lot never reached the pool at all, so it is a failure to launch, not a timeout.
    await closeLotById(row.id, row.status === "queued" ? "failed" : "expired", "stale_sweep");
  }
}
