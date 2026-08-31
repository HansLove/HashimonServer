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
  snapshotOf,
  statusForTermination,
  verifyShare,
  type CaosSharePayload,
  type LotRow,
} from "@/domain/incubation";
import { hashBitcoinJob, leadingZeroBits } from "@/core/index";
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

//A creature the golden coinbase also commits to. The DNA check is a substring test over
//prefix+extranonces+suffix, so any 64-hex window of that coinbase is a DNA this one mark
//legitimately proves work for — which is what lets more than one test own a *verifiable*
//mark despite hashimons.dna being UNIQUE.
function committedDna(offset: number): string {
  return goldenShare().coinbaseSuffix.slice(offset, offset + 64);
}

//The golden template with a different nonce, and the hash recomputed the way spoon would
//have. submitted_shares.hash is a GLOBAL primary key, so two tests replaying the vector
//verbatim would make the second one a redelivery before reaching what it means to test.
function minedShare(nonce: number, overrides: Partial<CaosSharePayload> = {}): CaosSharePayload {
  const base = goldenShare({ nonce, ...overrides });
  const { hashBE } = hashBitcoinJob({
    ...snapshotOf(base),
    extranonce1: base.extranonce1,
    extranonce2: base.extranonce2,
    nonceHex: nonce.toString(16).padStart(8, "0"),
  });
  return { ...base, hash: hashBE };
}

//The synthetic vector lands on 3 bits and a star costs 4, so a mark that moves the star
//count has to be ground for — which is what the pool does for real. A single star is ~16
//tries here, and grinding it beats asserting against a hand-written hash.
function markWorthStars(stars: number, from = 1): CaosSharePayload {
  for (let nonce = from; nonce < from + 100_000; nonce += 1) {
    const share = minedShare(nonce);
    if (leadingZeroBits(share.hash) >= stars * 4) {
      return share;
    }
  }
  throw new Error(`markWorthStars: no nonce from ${from} reached ${stars} stars`);
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
    //And the label cannot promote a lot either. A batch CaosEngine calls completed whose
    //marks did not all arrive owes a refund, and a complete lot that owes money is a
    //contradiction the client would render as a success screen.
    assert.equal(statusForTermination("completed", 3, 10), "partial");
    assert.equal(statusForTermination("completed", 0, 10), "failed");
  });
});

describe("verifying a mark", () => {
  it("accepts spoon's own share and reads its work off the recomputed hash", () => {
    const verdict = verifyShare(goldenShare(), GOLDEN_DNA, 0);
    assert.equal(verdict.ok, true);
    assert.ok(verdict.ok && verdict.bits === 3);
  });

  //The referee rule: what the pool claims is never what gets recorded.
  it("rejects a hash the template does not produce", () => {
    const verdict = verifyShare(goldenShare({ hash: "00".repeat(32) }), GOLDEN_DNA, 0);
    assert.deepEqual(verdict, { ok: false, error: "hash_mismatch" });
  });

  it("rejects a tampered template even when the hash is genuine", () => {
    const branch = goldenShare().merkleBranch;
    const verdict = verifyShare(goldenShare({ merkleBranch: [branch[1]!, branch[0]!] }), GOLDEN_DNA, 0);
    assert.deepEqual(verdict, { ok: false, error: "hash_mismatch" });
  });

  //Without this a pool could bill one player for work mined for another, or replay one
  //mark across every creature it has ever mined for.
  it("rejects a genuine mark that does not commit to this creature", () => {
    const verdict = verifyShare(goldenShare(), "ab".repeat(32), 0);
    assert.deepEqual(verdict, { ok: false, error: "dna_not_committed" });
  });

  //A template that cannot be rebuilt is not the same accusation as a hash that does not
  //match: one is a wire-format change, the other is a pool claiming work it did not do.
  it("names a template it cannot rebuild instead of blaming the hash", () => {
    const verdict = verifyShare(goldenShare({ prevHash: "abc" }), GOLDEN_DNA, 0);
    assert.deepEqual(verdict, { ok: false, error: "malformed_template" });
  });

  it("does not throw on hex it cannot parse", () => {
    const verdict = verifyShare(goldenShare({ coinbasePrefix: "nothex" }), GOLDEN_DNA, 0);
    assert.equal(verdict.ok, false);
  });

  //A header this creature's DNA is committed to, hashing to exactly what was claimed, and
  //still worthless: nonce 0 costs nothing. Checks 1 and 2 prove the mark is OURS, not that
  //it is worth anything — without the floor a pool bills a full lot for fifty of these.
  it("rejects a genuine, correctly committed mark that did no work", () => {
    const verdict = verifyShare(goldenShare(), GOLDEN_DNA);
    assert.deepEqual(verdict, { ok: false, error: "below_floor" });
  });

  //The floor is measured on the recomputed hash, never on what the pool says it achieved.
  it("ignores the stars the pool claims and measures the hash itself", () => {
    const verdict = verifyShare(goldenShare({ stars: 40, leadingZeros: 160 }), GOLDEN_DNA);
    assert.deepEqual(verdict, { ok: false, error: "below_floor" });
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
  //
  //`starsRequested` defaults to 0 here because the golden vector carries 3 bits of work —
  //nothing can synthesize a real 12-star mark in a test, that is the entire point of the
  //floor. A lot at the product's real floor is opened explicitly, once, to pin the refusal.
  async function openLot(shares: number, credits: number, dna: string, bestBits = 0, starsRequested = 0) {
    const playerId = await seedPlayer(credits);
    const hashimonId = await seedCreature(playerId, dna, bestBits);
    const lot = await createLot({
      playerId,
      hashimonId,
      shares,
      starsBefore: Math.floor(bestBits / 4),
      btcAddress: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
      starsRequested,
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

  //Two phases on the one creature the golden vector can prove: hashimons.dna is UNIQUE, so
  //GOLDEN_DNA exists exactly once in this suite and both halves of the story share it.
  it("counts a verified mark once, mutates the creature and closes a full lot", async () => {
    //Phase 1: the same mark, against a lot that bought the product's real floor. It
    //recomputes correctly and commits to this very creature — and is still not delivery.
    const { playerId, hashimonId, lot: strictLot } = await openLot(1, 500, GOLDEN_DNA, 0, 12);
    assert.deepEqual(await applyShare(strictLot, goldenShare()), { ok: false, error: "below_floor" });
    const refused = await query<{ shares_delivered: number; status: string }>(
      `SELECT shares_delivered, status FROM caos_lots WHERE id = $1`,
      [strictLot.id]
    );
    //Nothing delivered, and the lot is still open: a refused mark is not a closed lot.
    assert.equal(refused.rows[0]!.shares_delivered, 0);
    assert.equal(refused.rows[0]!.status, "queued");
    await closeLotById(strictLot.id, "failed", "test_teardown");

    //Phase 2: the floor lowered to what a synthetic vector can actually reach. Nothing else
    //about the mark changes — this is the accept path.
    const lot = await createLot({
      playerId,
      hashimonId,
      shares: 1,
      starsBefore: 0,
      btcAddress: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
      starsRequested: 0,
    });
    const applied = await applyShare(lot, goldenShare());
    assert.equal(applied.ok, true);
    assert.ok(applied.ok && !applied.duplicate && applied.isNewBest);
    assert.ok(applied.ok && !applied.duplicate && applied.lot.status === "complete");
    assert.ok(applied.ok && !applied.duplicate && applied.lot.shares_delivered === 1);
    //The first mark always claims the best slot, so the client can point at it.
    assert.ok(applied.ok && !applied.duplicate && applied.lot.best_share_index === 0);

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


  //The race the WHERE clause exists for: the caller holds a row that was live when it was
  //read, and the lot settled underneath it. Without the guard the UPDATE would put the lot
  //back into `mining`, and a resurrected lot pays its refund a second time.
  it("refuses a mark that arrives after the lot settled, and records nothing", async () => {
    const { playerId, lot } = await openLot(10, 500, committedDna(0));
    //Closed behind the caller's back; `lot` is the stale row it is still holding.
    await closeLotById(lot.id, "partial", "test_race");
    const creditsAfterClose = await creditsOf(playerId);

    const result = await applyShare(lot, minedShare(7));
    assert.deepEqual(result, { ok: false, error: "lot_closed" });

    const after = await query<{ status: string; shares_delivered: number; closed_at: Date | null }>(
      `SELECT status, shares_delivered, closed_at FROM caos_lots WHERE id = $1`,
      [lot.id]
    );
    assert.equal(after.rows[0]!.status, "partial");
    assert.equal(after.rows[0]!.shares_delivered, 0);
    assert.notEqual(after.rows[0]!.closed_at, null);
    //And the whole transaction rolled back: no share row survived the refusal.
    const shares = await query(`SELECT 1 FROM submitted_shares WHERE caos_lot_id = $1`, [lot.id]);
    assert.equal(shares.rows.length, 0);
    //Most of all: the refund was not paid twice.
    assert.equal(await creditsOf(playerId), creditsAfterClose);
  });

  //The creature's record moves only upward. The comparison lives in the UPDATE precisely so
  //a second writer — the player browser-mining while the lot runs — cannot lose a better
  //mark to a worse one that read the old value first.
  it("does not let a weaker mark displace the creature's record", async () => {
    const { hashimonId, lot } = await openLot(1, 500, committedDna(2), 20);
    const applied = await applyShare(lot, minedShare(11));
    assert.equal(applied.ok, true);
    assert.ok(applied.ok && !applied.duplicate && applied.isNewBest === false);

    const after = await query<{ best_share_bits: number; best_share_hash: string | null; valid_shares: number }>(
      `SELECT best_share_bits, best_share_hash, valid_shares FROM hashimons WHERE id = $1`,
      [hashimonId]
    );
    //The 3-bit mark counted as delivery and raised valid_shares, but the record is untouched.
    assert.equal(after.rows[0]!.best_share_bits, 20);
    assert.equal(after.rows[0]!.best_share_hash, null);
    assert.equal(after.rows[0]!.valid_shares, 1);
    //The lot still records it as its own best: the lot's ladder and the creature's are
    //different questions, and this mark is the best THIS lot delivered.
    assert.ok(applied.ok && !applied.duplicate && applied.lot.best_bits !== null);
    assert.ok(applied.ok && !applied.duplicate && applied.lot.best_bits! < 20);
  });

  //`mutación` is the one word the player-facing vocabulary does not allow to be approximate.
  //stars_before is frozen when the lot opens, so a player who keeps incubating in the
  //browser meanwhile leaves it behind — and a mark that beats the STALE number while losing
  //to the creature's real record would announce a mutation that never happened.
  it("does not claim a mutation for a mark the creature had already beaten", async () => {
    const { hashimonId, lot } = await openLot(1, 500, committedDna(4));
    assert.equal(lot.stars_before, 0);
    //The player's own incubating, while the lot is in flight: 5 stars, out of the lot's view.
    await query(`UPDATE hashimons SET best_share_bits = 20 WHERE id = $1`, [hashimonId]);

    //Worth a star — more than the lot's frozen snapshot, less than the creature now holds.
    const applied = await applyShare(lot, markWorthStars(1));
    assert.ok(applied.ok && !applied.duplicate && applied.isNewBest === false);
    assert.equal(presentLot(applied.ok && !applied.duplicate ? applied.lot : lot).mutated, false);

    //And the creature really is untouched, which is what makes the answer the honest one.
    const after = await query<{ best_share_bits: number }>(
      `SELECT best_share_bits FROM hashimons WHERE id = $1`,
      [hashimonId]
    );
    assert.equal(after.rows[0]!.best_share_bits, 20);
  });

  it("reports the mutation when a mark actually raises the star count", async () => {
    const { hashimonId, lot } = await openLot(1, 500, committedDna(6));
    const applied = await applyShare(lot, markWorthStars(1, 50_000));
    assert.ok(applied.ok && !applied.duplicate && applied.isNewBest === true);
    assert.equal(presentLot(applied.ok && !applied.duplicate ? applied.lot : lot).mutated, true);

    const after = await query<{ best_share_bits: number }>(
      `SELECT best_share_bits FROM hashimons WHERE id = $1`,
      [hashimonId]
    );
    assert.ok(after.rows[0]!.best_share_bits >= 4);
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
