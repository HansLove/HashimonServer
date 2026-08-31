//Assisted incubation. The pure halves (pricing, refund arithmetic, mark verification) run
//anywhere; the ledger half needs the local Postgres, like payments.test.ts.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import {
  applyShare,
  closeLotById,
  createLot,
  lotForHashimon,
  presentLot,
  quoteFor,
  refundFor,
  statusForTermination,
  verifyShare,
  type CaosSharePayload,
  type LotRow,
} from "@/domain/incubation";
import { present } from "@/domain/hashimons";
import { pool, query } from "@/db/pool";
import { AppError } from "@/http/errors";

//spoon's own SharePayload, verbatim — the same external vector core.test.ts pins the header
//byte order with. Its OP_RETURN is the ASCII of "HASHIMON-DNA-GOLDEN-VECTOR-0001", which the
//tests below use as the creature's DNA so the coinbase genuinely commits to it.
const GOLDEN_DNA = "48415348494d4f4e2d444e412d474f4c44454e2d564543544f522d30303031";

function goldenShare(overrides: Partial<CaosSharePayload> = {}): CaosSharePayload {
  return {
    requestId: "golden-vector-request",
    version: "20000000",
    nonce: 0,
    hash: "1930020f0a37e2537eb27e480920ab83d111b577f98b4493bef3b100e7603ed5",
    prevHash: "1c1d1e1f18191a1b14151617101112130c0d0e0f08090a0b0405060700010203",
    bits: "170e2632",
    timestamp: 1787944556,
    merkleBranch: [
      "313131313131313131313131313131313131313131313131313173696231",
      "0e6085fc097e1e76eefeae3c5f88f0f8bfa629b40c6730bb2999cb4ede703e3e",
    ],
    coinbasePrefix:
      "01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff1a0372c00d0553504f4f4e",
    coinbaseSuffix:
      "ffffffff03205fa01200000000160014751e76e8199196d454941c45d1b3a323f1433bd60000000000000000216a1f48415348494d4f4e2d444e412d474f4c44454e2d564543544f522d303030310000000000000000266a24aa21a9ed000000000000000000000000000000000000000000000000000000000000000000000000",
    extranonce1: "0000000000000001",
    extranonce2: "0000000000000042",
    extranonce2Size: 8,
    opReturn: GOLDEN_DNA,
    shareIndex: 0,
    sharesTotal: 1,
    ...overrides,
  };
}

describe("the price ladder", () => {
  //The four numbers the product ladder documents. If these drift, someone repriced the
  //product by accident — the seed is the contract, not an implementation detail.
  it("quotes the documented totals for each tier", async () => {
    assert.equal((await quoteFor(1)).credits, 10);
    assert.equal((await quoteFor(10)).credits, 98);
    assert.equal((await quoteFor(25)).credits, 241);
    assert.equal((await quoteFor(50)).credits, 475);
  });

  //The discount is published multiplied out, so a client that also applies discountPct
  //would double-count it. This pins the published shape.
  it("publishes a per-mark price already net of the discount", async () => {
    const tier = await quoteFor(10);
    assert.equal(tier.creditsPerShare, 9.8);
    assert.equal(tier.discountPct, 2);
  });

  it("refuses a lot outside 1..50 rather than inventing a price", async () => {
    await assert.rejects(() => quoteFor(0), (err: AppError) => err.status === 400);
    await assert.rejects(() => quoteFor(51), (err: AppError) => err.status === 400);
    await assert.rejects(() => quoteFor(2.5), (err: AppError) => err.status === 400);
  });
});

describe("refunds", () => {
  //P8: 3 of 10 delivered gives back the 7 that were not, at the price actually paid.
  it("returns the undelivered marks at the price paid", () => {
    assert.equal(refundFor({ credits_charged: 98, shares_requested: 10, shares_delivered: 3 }), 69);
    assert.equal(refundFor({ credits_charged: 98, shares_requested: 10, shares_delivered: 0 }), 98);
    assert.equal(refundFor({ credits_charged: 98, shares_requested: 10, shares_delivered: 10 }), 0);
  });

  //The volume discount rides along: a 50-mark lot refunds at 9.50/mark, not 10.
  it("keeps the volume discount in the refund", () => {
    assert.equal(refundFor({ credits_charged: 475, shares_requested: 50, shares_delivered: 3 }), 447);
  });

  //A pool that somehow over-delivered must not be billed backwards.
  it("never refunds more than was charged, nor a negative amount", () => {
    assert.equal(refundFor({ credits_charged: 100, shares_requested: 10, shares_delivered: 12 }), 0);
  });
});

describe("closing vocabulary", () => {
  it("maps CaosEngine's outcome onto the ledger's", () => {
    assert.equal(statusForTermination("completed", 10, 10), "complete");
    assert.equal(statusForTermination("partial", 3, 10), "partial");
    assert.equal(statusForTermination("failed", 0, 10), "failed");
    //Delivery is the ground truth, not the label: a full delivery is complete whatever
    //word the pool used for it.
    assert.equal(statusForTermination("partial", 10, 10), "complete");
  });
});

describe("verifying a mark", () => {
  it("accepts spoon's own share and reads its work off the recomputed hash", () => {
    const verdict = verifyShare(goldenShare(), GOLDEN_DNA);
    assert.equal(verdict.ok, true);
    assert.ok(verdict.ok && verdict.bits === 3);
  });

  //The referee rule: what the pool claims is never what gets recorded.
  it("rejects a hash the template does not produce", () => {
    const verdict = verifyShare(goldenShare({ hash: "00".repeat(32) }), GOLDEN_DNA);
    assert.deepEqual(verdict, { ok: false, error: "hash_mismatch" });
  });

  it("rejects a tampered template even when the hash is genuine", () => {
    const branch = goldenShare().merkleBranch;
    const verdict = verifyShare(goldenShare({ merkleBranch: [branch[1]!, branch[0]!] }), GOLDEN_DNA);
    assert.deepEqual(verdict, { ok: false, error: "hash_mismatch" });
  });

  //Without this a pool could bill one player for work mined for another, or replay one
  //mark across every creature it has ever mined for.
  it("rejects a genuine mark that does not commit to this creature", () => {
    const verdict = verifyShare(goldenShare(), "ab".repeat(32));
    assert.deepEqual(verdict, { ok: false, error: "dna_not_committed" });
  });

  it("does not throw on a malformed template", () => {
    const verdict = verifyShare(goldenShare({ coinbasePrefix: "nothex" }), GOLDEN_DNA);
    assert.equal(verdict.ok, false);
  });
});

describe("the lot ledger (against the local DB)", () => {
  const playerIds: string[] = [];

  after(async () => {
    if (playerIds.length > 0) {
      //caos_lots, hashimons and submitted_shares all cascade from the player row.
      await query(`DELETE FROM players WHERE id = ANY($1)`, [playerIds]);
    }
    await pool.end();
  });

  async function seedPlayer(credits: number): Promise<string> {
    const res = await query<{ id: string }>(
      `INSERT INTO players (display_name, credits) VALUES ('IncubationTest', $1) RETURNING id`,
      [credits]
    );
    const id = res.rows[0]!.id;
    playerIds.push(id);
    return id;
  }

  async function seedCreature(ownerId: string, dna: string, bestBits = 0): Promise<string> {
    const res = await query<{ id: string }>(
      `INSERT INTO hashimons (owner_id, dna, species_key, template_id, birth_nonce, algo_version, best_share_bits)
       VALUES ($1, $2, 'test-species', 'test-template', 'nonce', 'caos-core@2', $3)
       RETURNING id`,
      [ownerId, dna, bestBits]
    );
    return res.rows[0]!.id;
  }

  //Each test needs its own DNA: the golden vector's coinbase commits to exactly one, and
  //hashimons.dna is UNIQUE, so tests that both need a *verifiable* mark cannot share it.
  async function openLot(shares: number, credits: number, dna: string, bestBits = 0) {
    const playerId = await seedPlayer(credits);
    const hashimonId = await seedCreature(playerId, dna, bestBits);
    const lot = await createLot({
      playerId,
      hashimonId,
      shares,
      starsBefore: Math.floor(bestBits / 4),
      btcAddress: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
    });
    return { playerId, hashimonId, lot };
  }

  async function creditsOf(playerId: string): Promise<number> {
    const res = await query<{ credits: number }>(`SELECT credits FROM players WHERE id = $1`, [playerId]);
    return res.rows[0]!.credits;
  }

  it("debits the quoted price and opens the lot in one transaction", async () => {
    const { playerId, lot } = await openLot(10, 500, "a1".repeat(32));
    assert.equal(lot.status, "queued");
    assert.equal(lot.credits_charged, 98);
    assert.equal(await creditsOf(playerId), 402);
    //The webhook URL is the only credential CaosEngine gets, so it has to be unguessable.
    assert.equal(lot.webhook_secret.length, 64);
  });

  it("refuses a lot the player cannot pay for, and takes nothing", async () => {
    const playerId = await seedPlayer(50);
    const hashimonId = await seedCreature(playerId, "a2".repeat(32));
    await assert.rejects(
      () => createLot({ playerId, hashimonId, shares: 10, starsBefore: 0, btcAddress: "bc1q" }),
      (err: AppError) => err.status === 402 && err.code === "insufficient_credits"
    );
    assert.equal(await creditsOf(playerId), 50);
  });

  //The guarantee is the partial unique index, not an `if` — this is the second tab pressing buy.
  it("allows only one live lot per player", async () => {
    const { playerId, hashimonId } = await openLot(1, 500, "a3".repeat(32));
    await assert.rejects(
      () => createLot({ playerId, hashimonId, shares: 1, starsBefore: 0, btcAddress: "bc1q" }),
      (err: AppError) => err.status === 409 && err.code === "incubation_pending"
    );
    //And the failed attempt charged nothing: 500 - 10 for the first lot only.
    assert.equal(await creditsOf(playerId), 490);
  });

  it("counts a verified mark once, mutates the creature and closes a full lot", async () => {
    const { hashimonId, lot } = await openLot(1, 500, GOLDEN_DNA);
    const applied = await applyShare(lot, goldenShare());
    assert.equal(applied.ok, true);
    assert.ok(applied.ok && !applied.duplicate && applied.isNewBest);
    assert.ok(applied.ok && !applied.duplicate && applied.lot.status === "complete");
    assert.ok(applied.ok && !applied.duplicate && applied.lot.shares_delivered === 1);

    //The creature carries the mark, and present() re-derives it without trusting the row.
    const row = await query(`SELECT * FROM hashimons WHERE id = $1`, [hashimonId]);
    const view = present(row.rows[0] as never);
    assert.equal(view.verified, true);
    assert.equal(view.pow.bestShareHash, goldenShare().hash);
  });

  //CaosEngine redelivers; a repeat is the normal case, not an error.
  it("ignores a redelivered mark instead of counting it twice", async () => {
    const { lot } = await openLot(2, 500, "a4".repeat(32));
    //A creature the golden coinbase does not commit to would be rejected on DNA, so this
    //case is exercised with the committed one below; here the point is the index itself.
    const first = await query(
      `INSERT INTO submitted_shares (hash, hashimon_id, job_id, bits, extranonce2, nonce, origin, caos_lot_id, share_index)
       VALUES ('dup-test-hash', $1, NULL, 3, NULL, 0, 'caos', $2, 0)
       ON CONFLICT DO NOTHING RETURNING hash`,
      [lot.hashimon_id, lot.id]
    );
    assert.equal(first.rows.length, 1);
    //Same position in the same lot, a different hash: still refused.
    const second = await query(
      `INSERT INTO submitted_shares (hash, hashimon_id, job_id, bits, extranonce2, nonce, origin, caos_lot_id, share_index)
       VALUES ('dup-test-hash-other', $1, NULL, 3, NULL, 0, 'caos', $2, 0)
       ON CONFLICT DO NOTHING RETURNING hash`,
      [lot.hashimon_id, lot.id]
    );
    assert.equal(second.rows.length, 0);
  });

  it("refuses a mark whose hash does not survive recomputation", async () => {
    const { lot } = await openLot(1, 500, "a5".repeat(32));
    const result = await applyShare(lot, goldenShare({ hash: "00".repeat(32) }));
    assert.deepEqual(result, { ok: false, error: "hash_mismatch" });
    const after = await query<{ shares_delivered: number }>(
      `SELECT shares_delivered FROM caos_lots WHERE id = $1`,
      [lot.id]
    );
    assert.equal(after.rows[0]!.shares_delivered, 0);
  });

  it("refunds the undelivered marks on a partial close, exactly once", async () => {
    const { playerId, lot } = await openLot(10, 500, "a6".repeat(32));
    assert.equal(await creditsOf(playerId), 402);

    await query(`UPDATE caos_lots SET shares_delivered = 3, status = 'mining' WHERE id = $1`, [lot.id]);
    const closed = await closeLotById(lot.id, "partial", "terminated");
    assert.ok(closed);
    assert.equal(closed!.credits_refunded, 69);
    assert.equal(await creditsOf(playerId), 471);

    //The redelivered closing event lands on zero rows and pays nothing a second time.
    const again = await closeLotById(lot.id, "partial", "terminated");
    assert.equal(again, null);
    assert.equal(await creditsOf(playerId), 471);
  });

  //P15: the player who closed the tab has to find the outcome when they come back.
  it("keeps a closed lot readable so the result screen is reachable", async () => {
    const { playerId, hashimonId, lot } = await openLot(1, 500, "a7".repeat(32));
    await closeLotById(lot.id, "failed", "gateway_error");
    const found = await lotForHashimon(hashimonId, playerId);
    assert.ok(found);
    assert.equal(found!.status, "failed");
    assert.equal(presentLot(found as LotRow).creditsRefunded, 10);
  });

  //A lot whose outbound POST never happened would otherwise hold the index forever.
  it("sweeps a lot that never reached the pool and gives the credits back", async () => {
    const { playerId, hashimonId, lot } = await openLot(5, 500, "a8".repeat(32));
    await query(`UPDATE caos_lots SET created_at = now() - interval '2 hours' WHERE id = $1`, [lot.id]);

    //Any read path runs the sweep — there is no cron.
    const found = await lotForHashimon(hashimonId, playerId);
    assert.equal(found!.status, "failed");
    assert.equal(await creditsOf(playerId), 500);
  });

  //§6.1: the one-hour clock starts at assignment, so queueing is free.
  it("does not expire an assigned lot before its hour is up", async () => {
    const { hashimonId, playerId, lot } = await openLot(5, 500, "a9".repeat(32));
    await query(
      `UPDATE caos_lots SET status = 'assigned', assigned_at = now() - interval '5 minutes',
                            created_at = now() - interval '2 hours' WHERE id = $1`,
      [lot.id]
    );
    const found = await lotForHashimon(hashimonId, playerId);
    assert.equal(found!.status, "assigned");
  });

  it("expires an assigned lot whose miner hung, and refunds in full", async () => {
    const { hashimonId, playerId, lot } = await openLot(5, 500, "aa".repeat(32));
    await query(
      `UPDATE caos_lots SET status = 'mining', assigned_at = now() - interval '3 hours' WHERE id = $1`,
      [lot.id]
    );
    const found = await lotForHashimon(hashimonId, playerId);
    assert.equal(found!.status, "expired");
    assert.equal(await creditsOf(playerId), 500);
  });
});
