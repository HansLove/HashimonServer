// Censo de wolkers (Fase 0, docs/WOLKERS_V1.md): genesis irrepetible, hambre, muerte, y la
// decisión que más cuesta verificar a ojo — que la comida es LA MISMA que la de los Hashimons.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CHILD_DAYS,
  GENESIS_LITTER,
  BIRTH_COST,
  appearanceOf,
  applyWorldDeltas,
  attractivenessOf,
  breedTick,
  capacityFor,
  moraleTargetFor,
  recordTownCapacity,
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

  // --- Fase 2: techo y crianza -------------------------------------------------------

  const hearth = { x: 4, y: 8, z: 4 };

  // Cada town de prueba vive en su propio rincón del mapa. Compartir coordenada hacía que
  // los towns de tests anteriores contaran como vecinos a un paso, y la emigración —que es
  // global por diseño— los encontraba. El aislamiento aquí es geográfico, no de esquema.
  let plot = 0;
  function nextSpot() {
    plot++;
    return { x: plot * 20_000, y: 8, z: plot * 20_000 };
  }

  /** Un town donde nacer es posible: Hogar puesto, camas, comida y claim de sobra. */
  async function seedFertileTown(beds = 8, croquetas = 60, spot = nextSpot()) {
    const t = await seedTown();
    await query(`UPDATE town_claims SET block_count = 40 WHERE town_name = $1`, [t.townName]);
    await plantCroquetas(t.hashimonId, t.playerId, croquetas);
    await recordTownCapacity({ townName: t.townName, beds, hearth: spot });
    await seedGenesis(t.townName, spot);
    // Adultos, no ancianos: 100 días está por encima de CHILD_DAYS (30) y por debajo de
    // ELDER_DAYS (180). Envejecerlos más hacía que un `random()` de 0 —el que fuerza los
    // partos— disparase también la tirada de vejez y matase al pueblo entero en el mismo tick.
    await query(
      `UPDATE wolkers SET born_at = now() - interval '100 days' WHERE town_name = $1`,
      [t.townName]
    );
    return { ...t, spot };
  }

  it("the ceiling is the tightest of three terms, and says which one", async () => {
    const { townName, playerId, hashimonId } = await seedTown();
    await query(`UPDATE town_claims SET block_count = 40 WHERE town_name = $1`, [townName]);
    await plantCroquetas(hashimonId, playerId, 30);
    await recordTownCapacity({ townName, beds: 3, hearth });

    const c = await capacityFor(townName);
    assert.equal(c.byBeds, 6);      // 3 camas × 2
    assert.equal(c.byFood, 10);     // 30 croquetas ÷ 3
    assert.equal(c.byBlocks, 160);  // 40 bloques × 4
    assert.equal(c.cap, 6);
    assert.equal(c.bottleneck, "beds");
    assert.deepEqual(c.hearth, hearth);
  });

  it("a town that only claims map is capped by food, not by ambition", async () => {
    const { townName } = await seedTown();
    await query(`UPDATE town_claims SET block_count = 500 WHERE town_name = $1`, [townName]);
    await recordTownCapacity({ townName, beds: 100, hearth });
    const c = await capacityFor(townName);
    assert.equal(c.cap, 0);
    assert.equal(c.bottleneck, "food");
  });

  it("no hearth, no births: settling people is the player's decision", async () => {
    const t = await seedFertileTown();
    await recordTownCapacity({ townName: t.townName, beds: 8, hearth: null });
    const res = await withTransaction((client) => breedTick(t.townName, client, () => 0));
    assert.deepEqual(res, { births: 0, blockedBy: "hearth" });
  });

  it("a birth costs three croquetas out of the same larder", async () => {
    const t = await seedFertileTown();
    const before = await townLarder(t.townName);
    const balanceBefore = await croquetaBalance(t.hashimonId);

    // random() = 0 → siempre por debajo de p: se cría todo lo que las puertas permitan.
    const res = await withTransaction((client) => breedTick(t.townName, client, () => 0));
    assert.ok(res.births > 0, "debería haber nacido alguien");
    assert.equal(await townLarder(t.townName), before - res.births * BIRTH_COST);
    // La misma comida que le habría tocado a la criatura.
    assert.equal(await croquetaBalance(t.hashimonId), balanceBefore - res.births * BIRTH_COST);
    assert.equal(await population(t.townName), GENESIS_LITTER + res.births);
  });

  it("the newborn is a child, born at the hearth, with a verifiable lineage", async () => {
    const t = await seedFertileTown();
    await withTransaction((client) => breedTick(t.townName, client, () => 0));

    const baby = await query<{ id: string; parent_a: string; parent_b: string; birth_nonce: number;
                              home_x: number; home_z: number; born_at: Date }>(
      `SELECT id, parent_a, parent_b, birth_nonce, home_x, home_z, born_at
         FROM wolkers WHERE town_name = $1 ORDER BY born_at DESC LIMIT 1`,
      [t.townName]
    );
    const b = baby.rows[0]!;
    assert.equal(b.id, wolkerId(b.parent_a, b.parent_b, b.birth_nonce));
    assert.equal(b.home_x, t.spot.x);
    assert.equal(b.home_z, t.spot.z);
    assert.equal(appearanceOf(b.id, new Date(b.born_at)).model, "wolker_small");
    // Padres de signo opuesto: el signo por fin significa algo mecánico.
    assert.equal(signOf(b.parent_a) + signOf(b.parent_b), 0);
  });

  it("the curve is logistic: at the ceiling, nothing is born", async () => {
    const t = await seedFertileTown(2); // techo 4 = exactamente la camada genesis
    const res = await withTransaction((client) => breedTick(t.townName, client, () => 0));
    assert.deepEqual(res, { births: 0, blockedBy: "beds" });
  });

  it("nobody is born onto an empty plate — and the block says what to fix", async () => {
    // Comida justa para alimentar a los vivos, pero no para sostener a uno más: el término
    // de comida del techo muerde antes que nadie, y se reporta como 'food', no como 'cap'.
    const t = await seedFertileTown(8, GENESIS_LITTER + BIRTH_COST - 1);
    const res = await withTransaction((client) => breedTick(t.townName, client, () => 0));
    assert.deepEqual(res, { births: 0, blockedBy: "food" });
  });

  it("the genesis litter is never dealt infertile", async () => {
    // Cuatro del mismo signo salía una de cada ocho veces; ahora se reparte 2 y 2 por
    // construcción, sin dejar de ser determinista desde el homeblock.
    for (let i = 0; i < 6; i++) {
      const { townName } = await seedTown();
      const ids = await seedGenesis(townName, home);
      const sum = ids.reduce((acc, id) => acc + signOf(id), 0);
      assert.equal(sum, 0, `camada desequilibrada: ${ids.map(signOf).join(",")}`);
    }
  });

  it("children do not breed, and parents rest 48h", async () => {
    const t = await seedFertileTown();
    const first = await withTransaction((client) => breedTick(t.townName, client, () => 0));
    assert.ok(first.births > 0);

    // Los recién nacidos son niños y los padres están en cooldown: sin adultos libres.
    const second = await withTransaction((client) => breedTick(t.townName, client, () => 0));
    assert.equal(second.births, 0);
    assert.equal(second.blockedBy, "pairs");
  });

  it("the census tick feeds before it breeds", async () => {
    const t = await seedFertileTown();
    await query(`UPDATE wolkers SET hunger = 40 WHERE town_name = $1`, [t.townName]);
    const before = await townLarder(t.townName);

    const res = await censusTick({ random: () => 0, townName: t.townName });
    assert.equal(res.fed, GENESIS_LITTER);
    assert.ok(res.births > 0);
    // Se pagaron las dos cosas de la misma despensa, comida primero.
    assert.equal(await townLarder(t.townName), before - GENESIS_LITTER - res.births * BIRTH_COST);
  });

  // --- Fase 3: moral y emigración -----------------------------------------------------

  it("morale is earned with food, beds, a hearth and safety — nothing else", () => {
    const good = moraleTargetFor({ hunger: 0, population: 4, beds: 4, hasHearth: true, deaths7d: 0 });
    assert.equal(good.target, 65); // 50 + 0 + 10 + 5 - 0

    // Sin camas y con muertos, el mismo pueblo se hunde por debajo del umbral de fuga.
    const bad = moraleTargetFor({ hunger: 80, population: 10, beds: 0, hasHearth: false, deaths7d: 4 });
    assert.equal(bad.housing, -15);
    assert.equal(bad.losses, -20);
    assert.ok(bad.target < 25, `esperaba fuga, salió ${bad.target}`);

    // Un pueblo arrasado no baja de cero: el suelo existe.
    const razed = moraleTargetFor({ hunger: 100, population: 50, beds: 0, hasHearth: false, deaths7d: 99 });
    assert.equal(razed.target, 0);
  });

  it("distance and recent deaths make a neighbour unattractive", () => {
    const here = { x: 0, y: 0, z: 0 };
    const rich = { townName: "Rica", home: { x: 50, y: 0, z: 0 }, larder: 100, population: 10, avgMorale: 70, deaths7d: 0 };
    const far = { ...rich, townName: "Lejana", home: { x: 3000, y: 0, z: 0 } };
    const bloody = { ...rich, townName: "Sangrienta", deaths7d: 5 };

    assert.ok(attractivenessOf(rich, here) > attractivenessOf(far, here));
    assert.ok(attractivenessOf(rich, here) > attractivenessOf(bloody, here));
  });

  it("one bad tick does not empty a town; two do", async () => {
    const t = await seedFertileTown();
    // Se le quita todo: sin camas, sin comida, con hambre. La moral cae hacia el suelo.
    await recordTownCapacity({ townName: t.townName, beds: 0, hearth: t.spot });
    await query(`DELETE FROM pow_yield WHERE owner_id = $1`, [t.playerId]);
    await query(`UPDATE wolkers SET hunger = 95, morale = 30 WHERE town_name = $1`, [t.townName]);

    const first = await censusTick({ random: () => 1, townName: t.townName });
    assert.equal(first.emigrated, 0, "nadie se va al primer disgusto");
    const ticks = await query<{ low_morale_ticks: number; morale: number }>(
      `SELECT low_morale_ticks, morale FROM wolkers WHERE town_name = $1 LIMIT 1`, [t.townName]
    );
    assert.equal(ticks.rows[0]!.low_morale_ticks, 1);
    assert.ok(ticks.rows[0]!.morale < 25);
  });

  it("people vote with their feet: a better neighbour drains a bad town", async () => {
    const bad = await seedFertileTown();
    // El buen vecino, a tiro de piedra del malo: 40 nodos, dentro del alcance de una mudanza.
    const nextDoor = { x: bad.spot.x + 40, y: 8, z: bad.spot.z + 40 };
    const good = await seedFertileTown(20, 200, nextDoor);
    await query(`UPDATE wolkers SET morale = 90 WHERE town_name = $1`, [good.townName]);

    // Al malo se le quita todo y se le deja a su gente al borde de la fuga.
    await recordTownCapacity({ townName: bad.townName, beds: 0, hearth: bad.spot });
    await query(`DELETE FROM pow_yield WHERE owner_id = $1`, [bad.playerId]);
    await query(
      `UPDATE wolkers SET hunger = 95, morale = 20, low_morale_ticks = 1 WHERE town_name = $1`,
      [bad.townName]
    );

    const res = await censusTick({ random: () => 1, townName: bad.townName });
    assert.ok(res.emigrated > 0, "la gente debería haberse ido al vecino");
    assert.equal(await population(bad.townName), GENESIS_LITTER - res.emigrated);
    assert.equal(await population(good.townName), GENESIS_LITTER + res.emigrated);

    // Y queda escrito por los dos lados: quién los perdió y quién los ganó.
    const moves = await query<{ from_town: string; to_town: string; kind: string }>(
      `SELECT from_town, to_town, kind FROM wolker_events
        WHERE kind IN ('emigrate','immigrate') AND from_town = $1`,
      [bad.townName]
    );
    assert.equal(moves.rows.length, res.emigrated * 2);
    assert.equal(moves.rows[0]!.to_town, good.townName);
  });

  it("with nowhere better to go, the unhappy stay unhappy", async () => {
    const t = await seedFertileTown();
    await recordTownCapacity({ townName: t.townName, beds: 0, hearth: t.spot });
    await query(`DELETE FROM pow_yield WHERE owner_id = $1`, [t.playerId]);
    await query(
      `UPDATE wolkers SET hunger = 95, morale = 20, low_morale_ticks = 1 WHERE town_name = $1`,
      [t.townName]
    );
    // Los vecinos ricos existen, pero están a 20.000 nodos: fuera del alcance de una mudanza.
    await seedFertileTown(20, 200);

    const res = await censusTick({ random: () => 1, townName: t.townName });
    assert.equal(res.emigrated, 0);
    assert.equal(await population(t.townName), GENESIS_LITTER);
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
