// Mining jobs, shares and PoW YIELD (docs/POW_YIELD_V1.md, VIBING_V1.md §2). buildJobHeader
// and jobResponse are pure and tested standalone; issueJob/submitShare/submitYield hit the
// local DB. WORK-gate hits for submitYield are pre-ground offline (SHA-256 is not something a
// unit test should brute-force at 20 bits — see the comment above YIELD_DNA) so the test itself
// stays fast and deterministic.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { HashimonRow } from "@/modules/hashimon/domain/hashimons";
import type { MiningJobRow, ShareSubmitBody } from "@/modules/mining/domain/mining";
import type { PreparedTemplate } from "@/modules/mining/domain/block-template";

// config.miningMode is read once at module load — HASHIMON_MINING_MODE is already "bitcoin"
// by the time this file starts (node's --env-file loads .env before any JS runs), so it must
// be overridden here, not just defaulted, before the dynamic import below pulls config in.
// Bound mode keeps issueJob's own prepared-template branch a no-op (no network call); the
// bitcoin branch is covered directly by buildJobHeader's pure test, which needs neither the
// cache nor a live node (see block-template.ts's own seam comment).
process.env.HASHIMON_MINING_MODE = "bound";

const { buildJobHeader, jobResponse, issueJob, getJobForOwner, submitShare, submitYield, foodInventory } = await import(
  "@/modules/mining/domain/mining"
);
const { foodFor } = await import("@/modules/mining/domain/foods");
const { replaceVibingTowers } = await import("@/modules/mining/domain/vibing");
const { deriveExtranonce1, hashShareBound, leadingZeroBits } = await import("@/modules/core/core/pow");
const { zoneAtWorld } = await import("@/modules/core/core/yield-map");
const { pool, query } = await import("@/modules/core/db/pool");
const { uniqueId } = await import("@/test/support/db");
const { seedPlayer, seedHashimon, deletePlayers } = await import("@/test/support/fixtures");

describe("buildJobHeader (pure)", () => {
  const row = { dna: "ab".repeat(32) } as HashimonRow;

  it("bound mode header when no template is available", () => {
    const now = 1_700_000_000_000;
    const { mode, header } = buildJobHeader(row, null, "deadbeef", now);
    assert.equal(mode, "bound");
    assert.deepEqual(header, {
      version: 0x20000000,
      prevHash: "0000000000000000000000000000000000000000000000000000000000000000",
      merkleRoot: row.dna,
      timestamp: Math.floor(now / 1000),
      bits: "1d00ffff",
    });
  });

  it("bitcoin mode header when a template is available", () => {
    const now = 1_700_000_000_000;
    const prepared: PreparedTemplate = {
      templateId: "900000-aa",
      height: 900_000,
      prevhashBE: "bb".repeat(32),
      versionHex: "20000000",
      bits: "170345c9",
      curtime: 1_700_000_100,
      merkleBranch: ["cc".repeat(32)],
      coinbasePrefix: "prefix",
      coinbaseSuffix: "suffix",
      extranonce2Size: 4,
      fetchedAt: now - 1_000,
    };
    const { mode, header } = buildJobHeader(row, prepared, "deadbeef", now);
    assert.equal(mode, "bitcoin");
    assert.equal(header.version, parseInt(prepared.versionHex, 16));
    assert.equal(header.prevHash, prepared.prevhashBE);
    assert.equal(header.merkleRoot, row.dna);
    assert.equal(header.timestamp, prepared.curtime);
    assert.equal(header.bits, prepared.bits);
    assert.equal(header.templateId, prepared.templateId);
    assert.deepEqual(header.bitcoin, { ...prepared, extranonce1: "deadbeef" });
  });
});

describe("jobResponse (pure)", () => {
  function baseJob(overrides: Partial<MiningJobRow> = {}): MiningJobRow {
    return {
      id: "job-1",
      hashimon_id: "hashimon-1",
      owner_id: "owner-1",
      extranonce1: "deadbeef",
      share_target_bits: 20,
      block_target_bits: 64,
      mode: "bound",
      header: { version: 1, prevHash: "0".repeat(64), merkleRoot: "aa".repeat(32), timestamp: 1, bits: "1d00ffff" },
      expires_at: "2100-01-01T00:00:00.000Z",
      created_at: "2020-01-01T00:00:00.000Z",
      ...overrides,
    };
  }

  it("bound mode never carries a bitcoin field", () => {
    const response = jobResponse(baseJob(), 0) as Record<string, unknown>;
    assert.equal("bitcoin" in response, false);
  });

  it("bitcoin mode with a stored snapshot exposes only the client-facing bitcoin fields", () => {
    const bitcoinSnapshot = {
      prevhashBE: "bb".repeat(32),
      versionHex: "20000000",
      bits: "170345c9",
      merkleBranch: ["cc".repeat(32)],
      coinbasePrefix: "prefix",
      coinbaseSuffix: "suffix",
      extranonce2Size: 4,
      extranonce1: "deadbeef", // must NOT leak into the client response
      versionBits: null,
    };
    const header = { ...baseJob().header, bitcoin: bitcoinSnapshot };
    const response = jobResponse(baseJob({ mode: "bitcoin", header }), 1) as Record<string, any>;
    assert.ok(response.bitcoin);
    assert.equal("extranonce1" in response.bitcoin, false);
    assert.equal(response.bitcoin.prevhashBE, bitcoinSnapshot.prevhashBE);
  });

  it("bitcoin mode without a stored snapshot falls back to the base shape", () => {
    const response = jobResponse(baseJob({ mode: "bitcoin" }), 0) as Record<string, unknown>;
    assert.equal("bitcoin" in response, false);
  });
});

/** A coordinate whose zoneAtWorld tier matches the one asked for — cheap (a handful of
 *  sha256 calls), not a brute-force grind: zona() is a flat lookup, not a proof of work. */
function findCoordForTier(tier: "consumable" | "durable" | "capital", maxTries = 2_000): { x: number; z: number } {
  for (let i = 0; i < maxTries; i++) {
    const x = i * 64;
    if (zoneAtWorld(x, 0).tier === tier) return { x, z: 0 };
  }
  throw new Error(`findCoordForTier: no ${tier} region found in ${maxTries} tries`);
}

/** A nonce whose bound-mode hash clears `minBits` leading zero bits, for a specific
 *  (random-per-run) creature dna — ~94% odds per try at minBits=1, so this is a cheap
 *  local search, not a PoW grind. Needed because seedCreature()'s dna is fresh-random
 *  every run, so no single fixed nonce reliably beats a given best-share bar. */
function findNonceWithMinBits(dna: string, extranonce1: string, extranonce2: number, minBits: number, maxTries = 1_000): number {
  for (let nonce = 0; nonce < maxTries; nonce++) {
    if (leadingZeroBits(hashShareBound(dna, extranonce1, extranonce2, nonce)) >= minBits) return nonce;
  }
  throw new Error(`findNonceWithMinBits: no nonce clearing ${minBits} bits found in ${maxTries} tries`);
}

describe("mining jobs, shares and yields (against the local DB)", () => {
  const playerIds: string[] = [];
  const jobIds: string[] = [];
  const towerIds: string[] = [];

  after(async () => {
    if (jobIds.length > 0) {
      await query(`DELETE FROM mining_jobs WHERE id = ANY($1)`, [jobIds]);
    }
    if (towerIds.length > 0) {
      await query(`DELETE FROM vibing_towers WHERE id = ANY($1)`, [towerIds]);
    }
    if (playerIds.length > 0) {
      await deletePlayers(playerIds);
    }
    await pool.end();
  });

  /** A fresh player + hashimon. `dna`, when given, must be pre-ground for a specific test
   *  (see YIELD_DNA/CAPITAL_DNA below) — guard against a stale row from a crashed previous
   *  run tripping the `dna` UNIQUE constraint before seeding it again. */
  async function seedCreature(dna?: string): Promise<{ ownerId: string; row: HashimonRow }> {
    const player = await seedPlayer();
    playerIds.push(player.id);
    if (dna) {
      await query(`DELETE FROM hashimons WHERE dna = $1`, [dna]);
    }
    const seeded = await seedHashimon(player.id, dna ? { dna } : {});
    const res = await query<HashimonRow>(`SELECT * FROM hashimons WHERE id = $1`, [seeded.id]);
    return { ownerId: player.id, row: res.rows[0]! };
  }

  /** Inserts a mining_jobs row directly — bypasses issueJob so a test controls
   *  extranonce1/share_target_bits precisely without grinding a real PoW share. */
  async function insertJob(
    row: HashimonRow,
    overrides: Partial<{ extranonce1: string; shareTargetBits: number; expiresAt: Date }> = {}
  ): Promise<MiningJobRow> {
    const res = await query<MiningJobRow>(
      `INSERT INTO mining_jobs (hashimon_id, owner_id, extranonce1, share_target_bits, block_target_bits, mode, header, expires_at)
       VALUES ($1, $2, $3, $4, 64, 'bound', $5, $6)
       RETURNING *`,
      [
        row.id,
        row.owner_id,
        overrides.extranonce1 ?? deriveExtranonce1(row.dna),
        overrides.shareTargetBits ?? 0,
        JSON.stringify({
          version: 0x20000000,
          prevHash: "0".repeat(64),
          merkleRoot: row.dna,
          timestamp: Math.floor(Date.now() / 1000),
          bits: "1d00ffff",
        }),
        (overrides.expiresAt ?? new Date(Date.now() + 900_000)).toISOString(),
      ]
    );
    const job = res.rows[0]!;
    jobIds.push(job.id);
    return job;
  }

  it("issueJob inserts a bound-mode job (config.miningMode is not bitcoin here)", async () => {
    const { row } = await seedCreature();
    const job = await issueJob(row);
    jobIds.push(job.id);
    assert.equal(job.mode, "bound");
    assert.equal(job.hashimon_id, row.id);
    assert.equal(job.extranonce1, deriveExtranonce1(row.dna));
    assert.equal((job.header as { merkleRoot: string }).merkleRoot, row.dna);
  });

  it("getJobForOwner returns null for the wrong owner or an unknown job id", async () => {
    const { row, ownerId } = await seedCreature();
    const job = await issueJob(row);
    jobIds.push(job.id);
    assert.equal(await getJobForOwner(job.id, "00000000-0000-0000-0000-000000000000"), null);
    assert.equal(await getJobForOwner("00000000-0000-0000-0000-000000000000", ownerId), null);
    assert.equal((await getJobForOwner(job.id, ownerId))?.id, job.id);
  });

  it("getJobForOwner treats an expired job as gone", async () => {
    const { row, ownerId } = await seedCreature();
    const job = await insertJob(row, { expiresAt: new Date(Date.now() - 1_000) });
    assert.equal(await getJobForOwner(job.id, ownerId), null);
  });

  it("submitShare rejects when there is no matching job (stale_job)", async () => {
    const { row } = await seedCreature();
    const result = await submitShare(row, { jobId: "00000000-0000-0000-0000-000000000000", extranonce2: 0, nonce: 0 });
    assert.deepEqual(result, { ok: false, error: "stale_job" });
  });

  it("submitShare rejects a job that belongs to a different creature (stale_job)", async () => {
    const { row: row1 } = await seedCreature();
    const { row: row2 } = await seedCreature();
    const job = await insertJob(row2);
    const result = await submitShare(row1, { jobId: job.id, extranonce2: 0, nonce: 0 });
    assert.deepEqual(result, { ok: false, error: "stale_job" });
  });

  it("submitShare rejects a job whose extranonce1 does not bind to the creature's dna", async () => {
    const { row } = await seedCreature();
    const job = await insertJob(row, { extranonce1: "ffffffff" });
    const result = await submitShare(row, { jobId: job.id, extranonce2: 0, nonce: 0 });
    assert.equal(result.ok, false);
    assert.equal((result as { error: string }).error, "dna_mismatch");
  });

  it("submitShare rejects an invalid extranonce2 before hashing", async () => {
    const { row } = await seedCreature();
    const job = await insertJob(row);
    const result = await submitShare(row, { jobId: job.id, extranonce2: -1, nonce: 0 });
    assert.equal(result.ok, false);
    assert.equal((result as { error: string }).error, "invalid_nonce");
  });

  it("submitShare rejects a hash under the job's share target", async () => {
    const { row } = await seedCreature();
    const job = await insertJob(row, { shareTargetBits: 250 });
    const result = await submitShare(row, { jobId: job.id, extranonce2: 0, nonce: 1 });
    assert.equal(result.ok, false);
    assert.equal((result as { error: string }).error, "under_target");
  });

  it("submitShare accepts a share clearing the target and updates the creature's best", async () => {
    const { row } = await seedCreature();
    const job = await insertJob(row, { shareTargetBits: 0 });
    // best_share_bits starts at 0 (schema default); a hash with 0 leading zero bits would
    // tie rather than beat it (submitShare only updates on strictly-greater bits), so pick
    // a nonce guaranteed to clear at least 1 bit for this run's (random) dna.
    const nonce = findNonceWithMinBits(row.dna, job.extranonce1, 0, 1);
    const expectedHash = hashShareBound(row.dna, job.extranonce1, 0, nonce);

    const result = await submitShare(row, { jobId: job.id, extranonce2: 0, nonce });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.hash, expectedHash);
    assert.equal(result.row.valid_shares, row.valid_shares + 1);
    assert.equal(result.row.best_share_hash, expectedHash);
  });

  it("submitShare rejects a retry of the same hash on the same job (duplicate precheck)", async () => {
    const { row } = await seedCreature();
    const job = await insertJob(row, { shareTargetBits: 0 });
    const body: ShareSubmitBody = { jobId: job.id, extranonce2: 0, nonce: 777 };
    const first = await submitShare(row, body);
    assert.equal(first.ok, true);
    const second = await submitShare(row, body);
    assert.equal(second.ok, false);
    assert.equal((second as { error: string }).error, "duplicate_share");
  });

  it("submitShare de-duplicates a genuine race between two concurrent submits of the same hash", async () => {
    const { row } = await seedCreature();
    const jobA = await insertJob(row, { shareTargetBits: 0 });
    const jobB = await insertJob(row, { shareTargetBits: 0 });
    const outcomes = await Promise.all([
      submitShare(row, { jobId: jobA.id, extranonce2: 0, nonce: 555 }),
      submitShare(row, { jobId: jobB.id, extranonce2: 0, nonce: 555 }),
    ]);
    const accepted = outcomes.filter((o) => o.ok);
    const rejected = outcomes.filter((o) => !o.ok);
    assert.equal(accepted.length, 1, "exactly one of the two racing submits must win");
    assert.equal(rejected.length, 1);
    assert.equal((rejected[0] as { error: string }).error, "duplicate_share");
  });

  // Pre-ground offline for a fixed, dedicated test dna: 20+ leading zero bits in the yield
  // window (hex[16..32]) has ~1-in-a-million odds, too slow to brute-force per test run.
  // (dna=fixedString, extranonce1=deriveExtranonce1(dna), extranonce2=0)
  //   nonce 999     -> yieldBits  2 (below the consumable floor -> no_yield)
  //   nonce 2247562 -> yieldBits 21, rarity 2 (rolls "durable"), materialKey 7ba671f6a6c240b7
  const YIELD_DNA = "yieldtestdna".padEnd(64, "0");
  const YIELD_NONCE = 2_247_562;
  const YIELD_NO_YIELD_NONCE = 999;
  // Same technique, a second dedicated dna so its capital-ceiling test doesn't collide with
  // YIELD_DNA's own pow_yield row (hash is globally unique, keyed off dna+nonce together).
  //   nonce 8132051 -> yieldBits 21, rarity 2 (rolls "durable"), materialKey b59d5a468cee51a8
  const CAPITAL_DNA = "capitaltestdna".padEnd(64, "0");
  const CAPITAL_NONCE = 8_132_051;

  it("submitYield rejects when there is no matching job (stale_job)", async () => {
    const { row } = await seedCreature();
    const result = await submitYield(row, { jobId: "00000000-0000-0000-0000-000000000000", extranonce2: 0, nonce: 0 });
    assert.deepEqual(result, { ok: false, error: "stale_job" });
  });

  it("submitYield rejects a job whose extranonce1 does not bind to the creature's dna", async () => {
    const { row } = await seedCreature();
    const job = await insertJob(row, { extranonce1: "ffffffff" });
    const result = await submitYield(row, { jobId: job.id, extranonce2: 0, nonce: 0 });
    assert.deepEqual(result, { ok: false, error: "dna_mismatch" });
  });

  it("submitYield rejects invalid extranonce2/nonce", async () => {
    const { row } = await seedCreature();
    const job = await insertJob(row);
    const badExtranonce2 = await submitYield(row, { jobId: job.id, extranonce2: -1, nonce: 0 });
    assert.deepEqual(badExtranonce2, { ok: false, error: "invalid_nonce" });
    const badNonce = await submitYield(row, { jobId: job.id, extranonce2: 0, nonce: 0x1_0000_0001 });
    assert.deepEqual(badNonce, { ok: false, error: "invalid_nonce" });
  });

  it("submitYield returns no_yield below the consumable floor (the overwhelming common case)", async () => {
    const { row } = await seedCreature(YIELD_DNA);
    const job = await insertJob(row);
    const result = await submitYield(row, { jobId: job.id, extranonce2: 0, nonce: YIELD_NO_YIELD_NONCE });
    assert.equal(result.ok, false);
    assert.equal((result as { error: string }).error, "no_yield");
  });

  it("submitYield floors to the consumable tier at the player's vault (no town)", async () => {
    const { row } = await seedCreature(YIELD_DNA);
    const job = await insertJob(row);
    const result = await submitYield(row, { jobId: job.id, extranonce2: 0, nonce: YIELD_NONCE });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // LUCK rolled "durable", but the vault ceiling is "consumable" -> the ceiling wins.
    assert.equal(result.tier, "consumable");
    const expectedFood = foodFor(result.materialKey, "consumable");
    assert.equal(result.foodKey, expectedFood.key);
    assert.equal(result.foodName, expectedFood.name);

    // Same job, same body -> the hash PK rejects the retry (no precheck needed here).
    const dup = await submitYield(row, { jobId: job.id, extranonce2: 0, nonce: YIELD_NONCE });
    assert.deepEqual(dup, { ok: false, error: "duplicate_yield" });
  });

  it("submitYield caps at the tower's zone tier when the player's town has planted one", async () => {
    const { row, ownerId } = await seedCreature(CAPITAL_DNA);
    const town = uniqueId("VibingCapitalTown");
    await query(`INSERT INTO player_territory (player_id, town_name) VALUES ($1, $2)`, [ownerId, town]);
    const coord = findCoordForTier("capital");
    const tower = { id: uniqueId("tower-capital"), townName: town, owner: ownerId, x: coord.x, y: 8, z: coord.z };
    towerIds.push(tower.id);
    await replaceVibingTowers([tower]);

    const job = await insertJob(row);
    const result = await submitYield(row, { jobId: job.id, extranonce2: 0, nonce: CAPITAL_NONCE });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // LUCK rolled "durable" under a "capital" ceiling -> the roll wins (min(durable, capital)).
    assert.equal(result.tier, "durable");
  });

  it("foodInventory groups unspent yields by food, re-deriving legacy rows without a stored food_key", async () => {
    const { row, ownerId } = await seedCreature();
    const modernHash = uniqueId("food-modern-hash");
    const legacyHash = uniqueId("food-legacy-hash").padEnd(64, "0").slice(0, 64).toLowerCase();
    const legacyMaterialKey = legacyHash.slice(32, 48);
    const legacyFood = foodFor(legacyMaterialKey, "consumable");
    const consumedHash = uniqueId("food-consumed-hash");

    await query(
      `INSERT INTO pow_yield (hash, hashimon_id, owner_id, yield_bits, tier, material_key, extranonce2, nonce, place, food_key)
       VALUES ($1, $2, $3, 26, 'consumable', 'aabbccdd', 1, 1, $4, 'croqueta_basica')`,
      [modernHash, row.id, ownerId, `vault:${ownerId}`]
    );
    await query(
      `INSERT INTO pow_yield (hash, hashimon_id, owner_id, yield_bits, tier, material_key, extranonce2, nonce, place, food_key)
       VALUES ($1, $2, $3, 26, 'consumable', $4, 1, 2, $5, NULL)`,
      [legacyHash, row.id, ownerId, legacyMaterialKey, `vault:${ownerId}`]
    );
    // An already-consumed yield must not appear in the pantry.
    await query(
      `INSERT INTO pow_yield (hash, hashimon_id, owner_id, yield_bits, tier, material_key, extranonce2, nonce, place, food_key, consumed_at)
       VALUES ($1, $2, $3, 26, 'consumable', 'aabbccdd', 1, 3, $4, 'croqueta_basica', now())`,
      [consumedHash, row.id, ownerId, `vault:${ownerId}`]
    );

    const expectedCounts = new Map<string, number>();
    expectedCounts.set("croqueta_basica", (expectedCounts.get("croqueta_basica") ?? 0) + 1);
    expectedCounts.set(legacyFood.key, (expectedCounts.get(legacyFood.key) ?? 0) + 1);

    const inventory = await foodInventory(row.id);
    const actualCounts = new Map(inventory.map((f) => [f.key, f.count]));
    assert.deepEqual(actualCounts, expectedCounts);
    assert.equal(inventory.every((f) => f.tier === "consumable"), true);
  });
});
