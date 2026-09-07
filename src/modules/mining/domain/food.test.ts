// Hashi-croqueta inventory: unspent consumable pow_yield rows, spent by care(hunger).
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { care } from "@/modules/companion/domain/chat";
import { consumeCroqueta, croquetaBalance, yieldSummary } from "@/modules/mining/domain/mining";
import { pool, query, withTransaction } from "@/modules/core/db/pool";
import { AppError } from "@/modules/core/http/errors";

describe("croqueta inventory (against the local DB)", () => {
  const playerIds: string[] = [];

  after(async () => {
    if (playerIds.length > 0) {
      await query(`DELETE FROM players WHERE id = ANY($1)`, [playerIds]);
    }
    await pool.end();
  });

  async function seedCreature(): Promise<{ playerId: string; hashimonId: string }> {
    const player = await query<{ id: string }>(
      `INSERT INTO players (display_name) VALUES ('FoodTest') RETURNING id`
    );
    const playerId = player.rows[0]!.id;
    playerIds.push(playerId);
    const dna = Buffer.from(`food-test-${process.hrtime.bigint()}`).toString("hex").padEnd(64, "0").slice(0, 64);
    const creature = await query<{ id: string }>(
      `INSERT INTO hashimons
         (owner_id, dna, species_key, template_id, birth_nonce, algo_version)
       VALUES ($1, $2, 'fuego_guardian', 't', 'n', 'test')
       RETURNING id`,
      [playerId, dna]
    );
    return { playerId, hashimonId: creature.rows[0]!.id };
  }

  async function plantCroqueta(hashimonId: string, ownerId: string, hash: string): Promise<void> {
    await query(
      `INSERT INTO pow_yield
         (hash, hashimon_id, owner_id, yield_bits, tier, material_key, extranonce2, nonce, place)
       VALUES ($1, $2, $3, 26, 'consumable', 'aabb', 1, 1, $4)`,
      [hash, hashimonId, ownerId, `vault:${ownerId}`]
    );
  }

  it("balance counts only unspent consumables", async () => {
    const { playerId, hashimonId } = await seedCreature();
    assert.equal(await croquetaBalance(hashimonId), 0);

    await plantCroqueta(hashimonId, playerId, `h1-${hashimonId}`);
    await plantCroqueta(hashimonId, playerId, `h2-${hashimonId}`);
    await query(
      `INSERT INTO pow_yield
         (hash, hashimon_id, owner_id, yield_bits, tier, material_key, extranonce2, nonce)
       VALUES ($1, $2, $3, 30, 'durable', 'ccdd', 2, 2)`,
      [`durable-${hashimonId}`, hashimonId, playerId]
    );

    assert.equal(await croquetaBalance(hashimonId), 2);
    const summary = await yieldSummary(hashimonId);
    assert.equal(summary.croquetas, 2);
    assert.equal(summary.byTier.consumable, 2);
    assert.equal(summary.byTier.durable, 1);
  });

  it("consumeCroqueta decrements FIFO and care(hunger) spends one", async () => {
    const { playerId, hashimonId } = await seedCreature();
    await plantCroqueta(hashimonId, playerId, `a-${hashimonId}`);
    await plantCroqueta(hashimonId, playerId, `b-${hashimonId}`);

    await withTransaction(async (client) => {
      assert.equal(await consumeCroqueta(hashimonId, client), true);
    });
    assert.equal(await croquetaBalance(hashimonId), 1);

    const fed = await care(hashimonId, "hunger");
    assert.equal(fed.croquetas, 0);
    assert.equal(fed.wellbeing.care.hunger, 100);
    assert.equal(await croquetaBalance(hashimonId), 0);
  });

  it("care(hunger) with empty stock returns no_food", async () => {
    const { hashimonId } = await seedCreature();
    await assert.rejects(
      () => care(hashimonId, "hunger"),
      (err: unknown) => err instanceof AppError && err.code === "no_food" && err.status === 409
    );
  });

  it("care(company) does not spend croquetas", async () => {
    const { playerId, hashimonId } = await seedCreature();
    await plantCroqueta(hashimonId, playerId, `c-${hashimonId}`);
    const out = await care(hashimonId, "company");
    assert.equal(out.croquetas, 1);
    assert.equal(await croquetaBalance(hashimonId), 1);
  });
});
