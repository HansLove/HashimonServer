// Censo de wolkers (Fase 0, docs/WOLKERS_V1.md): genesis irrepetible, hambre, muerte, y la
// decisión que más cuesta verificar a ojo — que la comida es LA MISMA que la de los Hashimons.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CHILD_DAYS,
  GENESIS_LITTER,
  appearanceOf,
  applyWorldDeltas,
  censusTick,
  rosterForTown,
  signOf,
  townSituation,
  consumeTownCroquetas,
  population,
  seedGenesis,
  townLarder,
  traitsOf,
  wolkerId,
} from "@/domain/wolkers";
import { croquetaBalance, consumeCroqueta } from "@/domain/mining";
import { pool, query, withTransaction } from "@/db/pool";

describe("wolkers census (against the local DB)", () => {
  const playerIds: string[] = [];
  const townNames: string[] = [];

  after(async () => {
    if (townNames.length > 0) {
      await query(`DELETE FROM wolkers WHERE town_name = ANY($1)`, [townNames]);
      await query(`DELETE FROM wolker_genesis WHERE town_name = ANY($1)`, [townNames]);
      await query(`DELETE FROM town_claims WHERE town_name = ANY($1)`, [townNames]);
    }
    if (playerIds.length > 0) {
      await query(`DELETE FROM players WHERE id = ANY($1)`, [playerIds]);
    }
    await pool.end();
  });

  const home = { x: 0, y: 8, z: 0 };

  /** A town with one resident who owns one creature — the shape every case needs. */
  async function seedTown(): Promise<{ townName: string; playerId: string; hashimonId: string }> {
    const townName = `WolkerTest-${process.hrtime.bigint()}`;
    townNames.push(townName);
    await query(
      `INSERT INTO town_claims (town_name, block_count, member_count, mayor, home_x, home_y, home_z)
       VALUES ($1, 4, 1, 'tester', $2, $3, $4)`,
      [townName, home.x, home.y, home.z]
    );
    const player = await query<{ id: string }>(
      `INSERT INTO players (display_name) VALUES ('WolkerTest') RETURNING id`
    );
    const playerId = player.rows[0]!.id;
    playerIds.push(playerId);
    await query(
      `INSERT INTO player_territory (player_id, town_name, town_block_count) VALUES ($1, $2, 4)`,
      [playerId, townName]
    );
    const dna = Buffer.from(`wolker-test-${process.hrtime.bigint()}`).toString("hex").padEnd(64, "0").slice(0, 64);
    const creature = await query<{ id: string }>(
      `INSERT INTO hashimons (owner_id, dna, species_key, template_id, birth_nonce, algo_version)
       VALUES ($1, $2, 'fuego_guardian', 't', 'n', 'test')
       RETURNING id`,
      [playerId, dna]
    );
    return { townName, playerId, hashimonId: creature.rows[0]!.id };
  }

  async function plantCroquetas(hashimonId: string, ownerId: string, n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await query(
        `INSERT INTO pow_yield
           (hash, hashimon_id, owner_id, yield_bits, tier, material_key, extranonce2, nonce, place)
         VALUES ($1, $2, $3, 26, 'consumable', 'aabb', 1, 1, $4)`,
        [`w-${hashimonId}-${i}`, hashimonId, ownerId, `vault:${ownerId}`]
      );
    }
  }

  /** Never let the dice into a test, and never let a neighbouring town into the counters:
   *  the elder roll is injected and every tick is scoped to the town under test. */
  const tick = (townName: string) => censusTick({ random: () => 1, townName });

  it("genesis hands out one litter per homeblock, ever", async () => {
    const { townName } = await seedTown();

    const first = await seedGenesis(townName, home);
    assert.equal(first.length, GENESIS_LITTER);
    assert.equal(await population(townName), GENESIS_LITTER);

    // Refounding the same homeblock must not mint a second litter.
    const second = await seedGenesis(townName, home);
    assert.deepEqual(second, []);
    assert.equal(await population(townName), GENESIS_LITTER);
  });

  it("wolker ids and traits are derived, not stored decisions", async () => {
    const { townName } = await seedTown();
    const ids = await seedGenesis(townName, home);

    const row = await query<{ id: string; parent_a: string; parent_b: string; birth_nonce: number; vigor: number }>(
      `SELECT id, parent_a, parent_b, birth_nonce, vigor FROM wolkers WHERE id = $1`,
      [ids[0]!]
    );
    const w = row.rows[0]!;
    assert.equal(w.id, wolkerId(w.parent_a, w.parent_b, w.birth_nonce));
    assert.equal(w.vigor, traitsOf(w.id).vigor);
  });

  it("with no larder, hunger climbs and eventually kills", async () => {
    const { townName } = await seedTown();
    await seedGenesis(townName, home);

    await tick(townName);
    const after1 = await query<{ hunger: number }>(
      `SELECT hunger FROM wolkers WHERE town_name = $1 ORDER BY id LIMIT 1`,
      [townName]
    );
    assert.equal(after1.rows[0]!.hunger, 4);

    // 100 hunger at +4/tick: the 25th tick is the one that kills.
    for (let i = 0; i < 24; i++) await tick(townName);
    assert.equal(await population(townName), 0);

    const dead = await query<{ death_cause: string; state: string }>(
      `SELECT state, death_cause FROM wolkers WHERE town_name = $1 ORDER BY id LIMIT 1`,
      [townName]
    );
    assert.equal(dead.rows[0]!.state, "dead");
    assert.equal(dead.rows[0]!.death_cause, "hunger");

    const deaths = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM wolker_events e
         JOIN wolkers w ON w.id = e.wolker_id
        WHERE w.town_name = $1 AND e.kind = 'death'`,
      [townName]
    );
    assert.equal(Number(deaths.rows[0]!.n), GENESIS_LITTER);
  });

  it("the larder is the creatures' croquetas — one stock, spent once", async () => {
    const { townName, playerId, hashimonId } = await seedTown();
    await plantCroquetas(hashimonId, playerId, 6);
    await seedGenesis(townName, home);

    // Same rows, counted from both ends.
    assert.equal(await townLarder(townName), 6);
    assert.equal(await croquetaBalance(hashimonId), 6);

    // Feeding the creature takes food out of the town's mouth.
    await withTransaction(async (client) => {
      assert.equal(await consumeCroqueta(hashimonId, client), true);
    });
    assert.equal(await townLarder(townName), 5);

    // ...and feeding the town takes it out of the creature's bowl.
    await withTransaction(async (client) => {
      assert.equal(await consumeTownCroquetas(townName, 2, client), 2);
    });
    assert.equal(await croquetaBalance(hashimonId), 3);
  });

  it("a fed town stops starving, and only the hungry eat", async () => {
    const { townName, playerId, hashimonId } = await seedTown();
    await plantCroquetas(hashimonId, playerId, 8);
    await seedGenesis(townName, home);

    // Tick 1: everyone is at hunger 0, so nobody eats and nothing is burned.
    const first = await tick(townName);
    assert.equal(first.fed, 0);
    assert.equal(await townLarder(townName), 8);

    // Tick 2: all four are hungry now; four croquetas leave the larder and hunger drops to 0.
    const second = await tick(townName);
    assert.equal(second.fed, GENESIS_LITTER);
    assert.equal(await townLarder(townName), 8 - GENESIS_LITTER);

    const hungers = await query<{ hunger: number }>(`SELECT hunger FROM wolkers WHERE town_name = $1`, [townName]);
    for (const r of hungers.rows) assert.equal(r.hunger, 0);
    assert.equal(await population(townName), GENESIS_LITTER);
  });

  it("a short larder feeds the hungriest first instead of everyone a crumb", async () => {
    const { townName, playerId, hashimonId } = await seedTown();
    await plantCroquetas(hashimonId, playerId, 1);
    await seedGenesis(townName, home);

    // Spread hunger apart so "hungriest first" is observable.
    const ids = await query<{ id: string }>(`SELECT id FROM wolkers WHERE town_name = $1 ORDER BY id`, [townName]);
    await query(`UPDATE wolkers SET hunger = 60 WHERE id = $1`, [ids.rows[0]!.id]);

    const res = await tick(townName);
    assert.equal(res.fed, 1);

    const fed = await query<{ hunger: number }>(`SELECT hunger FROM wolkers WHERE id = $1`, [ids.rows[0]!.id]);
    assert.equal(fed.rows[0]!.hunger, 35); // 60 - FEED_RELIEF
    const others = await query<{ hunger: number }>(
      `SELECT hunger FROM wolkers WHERE town_name = $1 AND id <> $2`,
      [townName, ids.rows[0]!.id]
    );
    for (const r of others.rows) assert.equal(r.hunger, 4); // went hungry, as intended
  });

  it("appearance is three lego pieces, decided by the hash and the calendar", async () => {
    const now = new Date("2026-09-07T00:00:00Z");
    const newborn = new Date(now.getTime() - 1 * 86_400_000);
    const grown = new Date(now.getTime() - (CHILD_DAYS + 1) * 86_400_000);

    // Two ids with opposite signs, found by construction rather than hand-picked.
    const male = ["a", "b", "c", "d", "e", "f"].map((c) => c.repeat(64)).find((id) => signOf(id) === 1)!;
    const female = ["a", "b", "c", "d", "e", "f"].map((c) => c.repeat(64)).find((id) => signOf(id) === -1)!;

    assert.deepEqual(appearanceOf(male, grown, now), { sign: 1, stage: "adult", model: "wolker_pos" });
    assert.deepEqual(appearanceOf(female, grown, now), { sign: -1, stage: "adult", model: "wolker_neg" });
    // A child keeps its sign but wears the small body — one asset covers both.
    assert.deepEqual(appearanceOf(male, newborn, now), { sign: 1, stage: "child", model: "wolker_small" });
    assert.deepEqual(appearanceOf(female, newborn, now), { sign: -1, stage: "child", model: "wolker_small" });
  });

  it("the roster hands the world a body, not a decision", async () => {
    const { townName } = await seedTown();
    const ids = await seedGenesis(townName, home);

    const roster = await rosterForTown(townName);
    assert.equal(roster.length, GENESIS_LITTER);
    const entry = roster.find((w) => w.id === ids[0]!)!;
    assert.equal(entry.model, appearanceOf(entry.id, new Date(), new Date()).model);
    assert.equal(entry.sign, signOf(entry.id));
    assert.deepEqual(entry.home, home);

    // A dead wolker has no body to spawn.
    await query(`UPDATE wolkers SET state = 'dead', died_at = now(), death_cause = 'raid' WHERE id = $1`, [ids[0]!]);
    const after = await rosterForTown(townName);
    assert.equal(after.length, GENESIS_LITTER - 1);
  });

  it("the world may move and kill, but never create or starve", async () => {
    const { townName } = await seedTown();
    const ids = await seedGenesis(townName, home);

    const moved = await applyWorldDeltas([{ id: ids[0]!, pos: { x: 12.7, y: 9.2, z: -4.4 } }]);
    assert.deepEqual(moved, { moved: 1, deaths: 0, ignored: 0 });
    const row = await query<{ home_x: number; home_z: number }>(
      `SELECT home_x, home_z FROM wolkers WHERE id = $1`, [ids[0]!]
    );
    assert.equal(row.rows[0]!.home_x, 13);
    assert.equal(row.rows[0]!.home_z, -4);

    const killed = await applyWorldDeltas([{ id: ids[1]!, died: "raid" }]);
    assert.equal(killed.deaths, 1);
    assert.equal(await population(townName), GENESIS_LITTER - 1);

    // An id the census never issued cannot become population by being reported.
    const ghost = await applyWorldDeltas([{ id: "f".repeat(64), pos: { x: 0, y: 0, z: 0 } }]);
    assert.deepEqual(ghost, { moved: 0, deaths: 0, ignored: 1 });
    // ...and neither can a corpse be moved back into the roster.
    const again = await applyWorldDeltas([{ id: ids[1]!, pos: { x: 1, y: 1, z: 1 } }]);
    assert.equal(again.ignored, 1);
  });

  it("the situation summary is what the council reads", async () => {
    const { townName, playerId, hashimonId } = await seedTown();
    await plantCroquetas(hashimonId, playerId, 5);
    await seedGenesis(townName, home);
    await query(`UPDATE wolkers SET hunger = 90 WHERE town_name = $1`, [townName]);

    const s = await townSituation(townName);
    assert.equal(s.population, GENESIS_LITTER);
    assert.equal(s.larder, 5);
    assert.equal(s.avgHunger, 90);
    assert.equal(s.starving, GENESIS_LITTER);
    assert.equal(s.deaths7d, 0);
  });

  it("crossing into starvation is announced once, not every tick", async () => {
    const { townName } = await seedTown();
    await seedGenesis(townName, home);
    const ids = await query<{ id: string }>(`SELECT id FROM wolkers WHERE town_name = $1 ORDER BY id`, [townName]);
    const id = ids.rows[0]!.id;
    await query(`UPDATE wolkers SET hunger = 74 WHERE id = $1`, [id]);

    await tick(townName); // 74 -> 78, crosses STARVING_AT
    await tick(townName); // 78 -> 82, still starving, no second shout

    const events = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM wolker_events WHERE wolker_id = $1 AND kind = 'starving'`,
      [id]
    );
    assert.equal(Number(events.rows[0]!.n), 1);
  });
});
