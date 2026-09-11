// La capa Risk (docs/ARMIES_V1.md). Lo que se prueba aquí, sobre todo, es que la teoría de
// juego NO está rota: que expandirse sin poblar debilita, y que la batalla es recomputable.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  COHESION_FLOOR,
  UNITS,
  armyOf,
  attack,
  chunkDistance,
  cohesionOf,
  TURN_MS,
  autoTick,
  autoTickAll,
  canAct,
  currentTurn,
  nextTurnAt,
  turnOf,
  frontierBlocks,
  getDoctrine,
  levyTick,
  moveUnit,
  setDoctrine,
  stepToward,
  muster,
  perimeterOf,
  resolveBattle,
} from "@/domain/armies";
import { seedGenesis } from "@/domain/wolkers";
import { pool, query } from "@/db/pool";
import { createHash } from "node:crypto";

describe("armies — the Risk layer", () => {
  const towns: string[] = [];

  after(async () => {
    if (towns.length > 0) {
      await query(`DELETE FROM wolkers WHERE town_name = ANY($1)`, [towns]);
      await query(`DELETE FROM wolker_genesis WHERE town_name = ANY($1)`, [towns]);
      await query(`DELETE FROM battles WHERE attacker = ANY($1) OR defender = ANY($1)`, [towns]);
      await query(`DELETE FROM town_actions WHERE town_name = ANY($1)`, [towns]);
      await query(`DELETE FROM town_claims WHERE town_name = ANY($1)`, [towns]);
    }
    // El pool lo cierra el último describe del fichero: cerrarlo aquí dejaba a la suite de
    // autopiloto hablando con un pool muerto.
  });

  /** Un town con un claim rectangular de `w × h` chunks a partir de (ox, oz). */
  async function seedNation(w: number, h: number, ox = 0, oz = 0) {
    const townName = `Risk-${process.hrtime.bigint()}`;
    towns.push(townName);
    const blocks: number[][] = [];
    for (let x = 0; x < w; x++) for (let z = 0; z < h; z++) blocks.push([ox + x, 0, oz + z]);
    await query(
      `INSERT INTO town_claims (town_name, block_count, blocks, home_x, home_y, home_z)
       VALUES ($1, $2, $3::jsonb, $4, 8, $5)`,
      [townName, blocks.length, JSON.stringify(blocks), ox * 16, oz * 16]
    );
    return { townName, blocks };
  }

  /** Puebla un town con `n` wolkers sintéticos. Hace falta porque el tope de levas es
   *  población ÷ 2: una nación vacía no sólo no recluta, sino que PIERDE la leva que tuviera
   *  guardada — que es exactamente lo que debe pasar cuando se te muere la gente. */
  async function seedPeople(townName: string, n: number) {
    for (let i = 0; i < n; i++) {
      const id = createHash("sha256").update(`${townName}:${i}`).digest("hex");
      await query(
        `INSERT INTO wolkers (id, town_name, parent_a, parent_b, birth_nonce, vigor, oficio, temple, home_x, home_y, home_z)
         VALUES ($1, $2, $3, $3, $4, 100, 100, 100, $5, 8, $6)
         ON CONFLICT (id) DO NOTHING`,
        [id, townName, "0".repeat(64), 1000 + i, 0, 0]
      );
    }
  }

  async function giveLevies(townName: string, stock: number) {
    await query(
      `INSERT INTO army_levies (town_name, stock) VALUES ($1, $2)
       ON CONFLICT (town_name) DO UPDATE SET stock = EXCLUDED.stock`,
      [townName, stock]
    );
  }

  it("cohesion punishes conquering more than you can populate", () => {
    // Compacto y poblado: pelea a pleno rendimiento.
    assert.equal(cohesionOf(20, 20), 1);
    // El mismo pueblo estirado sobre diez veces más mapa: al suelo.
    assert.equal(cohesionOf(20, 200), COHESION_FLOOR);
    // Y la caída es continua, no un escalón: 20 hab en 40 chunks → densidad 0.5 → 1.0
    assert.equal(cohesionOf(20, 40), 1);
    assert.equal(cohesionOf(20, 80), 0.5);
  });

  it("a long thin empire is almost all border; a compact one is not", () => {
    const line: { x: number; y: number; z: number }[] = [];
    for (let x = 0; x < 16; x++) line.push({ x, y: 0, z: 0 });
    assert.equal(perimeterOf(line), 16); // cada chunk de la tira es frontera

    const square: { x: number; y: number; z: number }[] = [];
    for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) square.push({ x, y: 0, z });
    assert.equal(perimeterOf(square), 12); // los 4 del centro están a cubierto

    // Mismo número de chunks, distinta forma: la geografía es una decisión de defensa.
    assert.equal(line.length, square.length);
  });

  it("a battle can be recomputed by anyone from its inputs", () => {
    const input = {
      block: { x: 3, y: 0, z: 7 },
      attacker: "Alfa",
      defender: "Beta",
      attackForce: { kinds: { milicia: 0, linea: 4, incursores: 2 } },
      defenseForce: { kinds: { milicia: 6, linea: 1, incursores: 0 } },
      attackerCohesion: 1,
      defenderCohesion: 1,
      onDefenderClaim: true,
      nonce: "2026-09-09T00:00:00.000Z",
    };
    const a = resolveBattle(input);
    const b = resolveBattle(input);
    assert.deepEqual(a, b);
    assert.match(a.seed, /^[0-9a-f]{64}$/);
    assert.ok(a.roll >= 0 && a.roll < 1);

    // Cambiar un solo dato cambia la tirada: la semilla ata el resultado a las entradas.
    const moved = resolveBattle({ ...input, block: { x: 4, y: 0, z: 7 } });
    assert.notEqual(moved.seed, a.seed);
  });

  it("a diluted empire loses its edge against a compact defender", () => {
    const base = {
      block: { x: 0, y: 0, z: 0 },
      attacker: "Imperio",
      defender: "Aldea",
      attackForce: { kinds: { milicia: 0, linea: 10, incursores: 0 } },
      defenseForce: { kinds: { milicia: 6, linea: 0, incursores: 0 } },
      defenderCohesion: 1,
      onDefenderClaim: true,
      nonce: "x",
    };
    const compact = resolveBattle({ ...base, attackerCohesion: 1 });
    const sprawling = resolveBattle({ ...base, attackerCohesion: COHESION_FLOOR });

    // Diez compañías de línea contra seis de milicia: favorito si estás cohesionado...
    assert.ok(compact.odds > 0.5, `odds compacto ${compact.odds}`);
    // ...y perdedor claro si has conquistado más de lo que puedes poblar.
    assert.ok(sprawling.odds < 0.3, `odds diluido ${sprawling.odds}`);
  });

  it("an empty chunk is occupied, not fought over", () => {
    const out = resolveBattle({
      block: { x: 9, y: 0, z: 9 },
      attacker: "Alfa",
      defender: null,
      attackForce: { kinds: { milicia: 0, linea: 1, incursores: 0 } },
      defenseForce: { kinds: { milicia: 0, linea: 0, incursores: 0 } },
      attackerCohesion: 1,
      defenderCohesion: 1,
      onDefenderClaim: false,
      nonce: "x",
    });
    assert.equal(out.odds, 1);
    assert.equal(out.winner, "attacker");
  });

  it("losing costs twice what winning does", () => {
    const out = resolveBattle({
      block: { x: 0, y: 0, z: 0 },
      attacker: "A", defender: "B",
      attackForce: { kinds: { milicia: 0, linea: 8, incursores: 0 } },
      defenseForce: { kinds: { milicia: 8, linea: 0, incursores: 0 } },
      attackerCohesion: 1, defenderCohesion: 1, onDefenderClaim: true, nonce: "x",
    });
    const [winner, loser] = out.winner === "attacker"
      ? [out.attackerLosses, out.defenderLosses]
      : [out.defenderLosses, out.attackerLosses];
    assert.equal(winner, 2); // 25 % de 8
    assert.equal(loser, 4);  // 50 % de 8
  });

  it("levies come from people, and cap at half the population", async () => {
    const { townName } = await seedNation(4, 4);
    await seedGenesis(townName, { x: 0, y: 8, z: 0 }); // 4 wolkers
    await levyTick();
    const first = await armyOf(townName);
    assert.ok(first.levies > 0 && first.levies < 1, `un tick da una fracción, dio ${first.levies}`);

    // Muchos ticks: el tope es población ÷ 2 = 2, no infinito.
    for (let i = 0; i < 300; i++) await levyTick();
    const capped = await armyOf(townName);
    assert.equal(capped.levies, 2);
  });

  it("a town with no people raises no army", async () => {
    const { townName } = await seedNation(20, 20);
    await levyTick();
    const view = await armyOf(townName);
    assert.equal(view.levies, 0);
    assert.equal(view.cohesion, COHESION_FLOOR);
  });

  it("units are placed inside your own claim, and cost levies", async () => {
    const { townName } = await seedNation(3, 3);
    await seedPeople(townName, 20);
    await giveLevies(townName, 5);

    const ok = await muster(townName, "linea", { x: 1, y: 0, z: 1 });
    assert.equal(ok.ok, true);

    // Fuera del claim, no. El despliegue inicial es libre dentro de tu casa, no del mapa.
    const outside = await muster(townName, "linea", { x: 99, y: 0, z: 99 });
    assert.deepEqual(outside, { ok: false, error: "not_your_claim" });

    // Y la leva se cobra: 5 menos el coste 2 de una línea. Se comprueba con holgura porque
    // el tick de censo puede haber acumulado una fracción de leva entre medias — el gasto
    // es exacto, el saldo es un número vivo.
    const view = await armyOf(townName);
    assert.ok(view.levies >= 3 && view.levies < 3.5, `saldo ${view.levies}`);
    assert.equal(view.units.linea, 1);
    assert.equal(view.total, 1);

    const broke = await seedNation(2, 2, 200, 200);
    const noLevies = await muster(broke.townName, "linea", { x: 200, y: 0, z: 200 });
    assert.deepEqual(noLevies, { ok: false, error: "no_levies" });
  });

  it("mobility is a real limit, per unit type", async () => {
    const { townName } = await seedNation(9, 9, 300, 300);
    await seedPeople(townName, 40);
    await giveLevies(townName, 10);
    const m = await muster(townName, "milicia", { x: 300, y: 0, z: 300 });
    assert.equal(m.ok, true);
    const unitId = (m as { ok: true; unitId: number }).unitId;

    // La milicia se mueve 1 chunk: dos es demasiado.
    const tooFar = await moveUnit(townName, unitId, { x: 302, y: 0, z: 300 });
    assert.deepEqual(tooFar, { ok: false, error: "too_far" });
    const fine = await moveUnit(townName, unitId, { x: 301, y: 0, z: 300 });
    assert.equal(fine.ok, true);

    assert.equal(UNITS.incursores.move, 4);
    assert.equal(chunkDistance({ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 3 }), 3); // diagonal barata
  });

  it("taking a chunk kills the people who lived in it and queues the claim", async () => {
    const defender = await seedNation(2, 2, 500, 500);
    const attacker = await seedNation(2, 2, 502, 500);
    await seedGenesis(defender.townName, { x: 500 * 16 + 2, y: 8, z: 500 * 16 + 2 });
    await seedPeople(attacker.townName, 80);
    await giveLevies(attacker.townName, 30);

    // Un ejército aplastante contra un chunk sin guarnición: la toma es segura.
    for (let i = 0; i < 8; i++) {
      await muster(attacker.townName, "linea", { x: 502, y: 0, z: 500 });
    }
    await query(`UPDATE army_units SET bx = 500, bz = 500 WHERE town_name = $1`, [attacker.townName]);

    const raw = await attack(attacker.townName, { x: 500, y: 0, z: 500 }, "test-nonce");
    assert.ok(!("error" in raw), "el ataque no debería rebotar por turno");
    const res = raw as Extract<typeof raw, { winner: string }>;
    assert.equal(res.winner, "attacker");
    assert.equal(res.defender, defender.townName);
    assert.ok(res.civiliansKilled > 0, "la guerra se cobra en gente");
    assert.equal(res.captured, true);

    // La toma del claim se PROPONE al mundo; el servidor no reescribe el mapa por su cuenta.
    const queued = await query<{ op: string; target: string }>(
      `SELECT op, target FROM town_actions WHERE town_name = $1 AND op = 'war_claim'`,
      [attacker.townName]
    );
    assert.equal(queued.rows.length, 1);
    assert.equal(queued.rows[0]!.target, "500,0,500");

    // Y queda el registro auditable, con su semilla.
    const battle = await query<{ seed: string; winner: string }>(
      `SELECT seed, winner FROM battles WHERE id = $1`, [res.battleId]
    );
    assert.equal(battle.rows[0]!.winner, "attacker");
    assert.equal(battle.rows[0]!.seed, res.seed);
  });

  it("the public view shows any nation's size, types and thin borders", async () => {
    const { townName } = await seedNation(10, 1, 700, 700); // tira: todo frontera
    await seedPeople(townName, 60);
    await giveLevies(townName, 20);
    await muster(townName, "milicia", { x: 700, y: 0, z: 700 });
    await muster(townName, "incursores", { x: 701, y: 0, z: 700 });

    const view = await armyOf(townName);
    assert.equal(view.units.milicia, 1);
    assert.equal(view.units.incursores, 1);
    assert.equal(view.perimeter, 10);
    // Una sola ficha defensiva para diez chunks de frontera: un colador, y se ve.
    assert.ok(view.garrisonPerFrontier < 1, `guarnición ${view.garrisonPerFrontier}`);
    assert.equal(view.positions.length, 2);
  });
});

// --- Doctrina: lo que hace tu ejército cuando no estás ----------------------------------

describe("army autopilot", () => {
  const towns: string[] = [];

  after(async () => {
    if (towns.length > 0) {
      await query(`DELETE FROM wolkers WHERE town_name = ANY($1)`, [towns]);
      await query(`DELETE FROM battles WHERE attacker = ANY($1)`, [towns]);
      await query(`DELETE FROM town_actions WHERE town_name = ANY($1)`, [towns]);
      await query(`DELETE FROM town_claims WHERE town_name = ANY($1)`, [towns]);
    }
  });

  async function nation(w: number, h: number, ox: number, oz: number, levies: number) {
    const townName = `Auto-${process.hrtime.bigint()}`;
    towns.push(townName);
    const blocks: number[][] = [];
    for (let x = 0; x < w; x++) for (let z = 0; z < h; z++) blocks.push([ox + x, 0, oz + z]);
    await query(
      `INSERT INTO town_claims (town_name, block_count, blocks, home_x, home_y, home_z)
       VALUES ($1, $2, $3::jsonb, $4, 8, $5)`,
      [townName, blocks.length, JSON.stringify(blocks), ox * 16, oz * 16]
    );
    // Población suficiente para que el tope de leva (pob/2) no se coma el saldo.
    for (let i = 0; i < levies * 3; i++) {
      const id = createHash("sha256").update(`auto:${townName}:${i}`).digest("hex");
      await query(
        `INSERT INTO wolkers (id, town_name, parent_a, parent_b, birth_nonce, vigor, oficio, temple, home_x, home_y, home_z)
         VALUES ($1,$2,$3,$3,$4,100,100,100,0,8,0) ON CONFLICT DO NOTHING`,
        [id, townName, "0".repeat(64), 9000 + i]
      );
    }
    await query(
      `INSERT INTO army_levies (town_name, stock) VALUES ($1, $2)
       ON CONFLICT (town_name) DO UPDATE SET stock = EXCLUDED.stock`,
      [townName, levies]
    );
    return { townName, blocks };
  }

  it("defaults to defending, not to sitting still", async () => {
    const { townName } = await nation(3, 3, 1000, 1000, 6);
    // Nadie ha elegido doctrina: la nación se guarnece igual.
    assert.equal(await getDoctrine(townName), "defensiva");

    const res = await autoTick(townName);
    assert.equal(res.doctrine, "defensiva");
    assert.ok(res.recruited > 0, "una nación sin alcalde presente debería guarnecerse");

    const view = await armyOf(townName);
    assert.equal(view.units.milicia, res.recruited); // defensiva recluta milicia
    assert.equal(view.units.incursores, 0);
  });

  it("manual means manual: nothing moves without you", async () => {
    const { townName } = await nation(3, 3, 1100, 1100, 6);
    await setDoctrine(townName, "manual");
    const res = await autoTick(townName);
    assert.deepEqual(res, { town: townName, doctrine: "manual", recruited: 0, moved: 0, occupied: 0 });
    assert.equal((await armyOf(townName)).total, 0);
  });

  it("reinforcements go where the hole is, not where the army already is", async () => {
    const { townName } = await nation(3, 3, 1200, 1200, 6);
    await autoTick(townName);
    const view = await armyOf(townName);
    // Ocho chunks de frontera y pocas fichas: ninguna debería haberse apilado de tres en tres.
    const stacked = view.positions.filter((p) => p.units > 2);
    assert.equal(stacked.length, 0, `se apilaron fichas: ${JSON.stringify(view.positions)}`);
  });

  it("an army in the middle of the map walks to the border", async () => {
    const { townName } = await nation(5, 5, 1300, 1300, 4);
    await setDoctrine(townName, "manual");
    // Una ficha en el centro exacto del claim: no defiende nada donde está.
    const centre = { x: 1302, y: 0, z: 1302 };
    await muster(townName, "linea", centre);

    await setDoctrine(townName, "equilibrada");
    const res = await autoTick(townName);
    assert.ok(res.moved > 0, "la ficha del centro debería haber caminado");

    const view = await armyOf(townName);
    const stillCentre = view.positions.find((p) => p.x === centre.x && p.z === centre.z);
    assert.equal(stillCentre, undefined);
  });

  it("the autopilot takes empty land but never a neighbour's claim", async () => {
    const victim = await nation(2, 2, 1400, 1400, 0);
    const expansive = await nation(2, 2, 1402, 1400, 30);
    await setDoctrine(expansive.townName, "expansiva");
    await setDoctrine(victim.townName, "manual");

    await autoTick(expansive.townName);
    await autoTick(expansive.townName);

    // Nunca ataca a la nación de al lado: ninguna batalla contra ella, ningún war_claim
    // sobre sus chunks. Declarar una guerra es una decisión humana.
    const wars = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM battles WHERE attacker = $1 AND defender = $2`,
      [expansive.townName, victim.townName]
    );
    assert.equal(Number(wars.rows[0]!.n), 0);

    const claims = await query<{ target: string }>(
      `SELECT target FROM town_actions WHERE town_name = $1 AND op = 'war_claim'`,
      [expansive.townName]
    );
    for (const c of claims.rows) {
      const [x, , z] = c.target.split(",").map(Number);
      const insideVictim = victim.blocks.some((b) => b[0] === x && b[2] === z);
      assert.equal(insideVictim, false, `ocupó un chunk del vecino: ${c.target}`);
    }
  });

  it("one broken nation does not stop the others' turn", async () => {
    const { townName } = await nation(2, 2, 1500, 1500, 4);
    // Un claim con forma imposible: el autopiloto debe seguir con el resto.
    const broken = `Auto-broken-${process.hrtime.bigint()}`;
    towns.push(broken);
    await query(
      `INSERT INTO town_claims (town_name, block_count, blocks) VALUES ($1, 3, $2::jsonb)`,
      [broken, JSON.stringify("no-soy-una-lista")]
    );
    const all = await autoTickAll();
    assert.ok(all.some((r) => r.town === townName && r.recruited > 0));
  });
});

// --- Turnos ----------------------------------------------------------------------------

describe("turns", () => {
  const towns: string[] = [];

  after(async () => {
    if (towns.length > 0) {
      await query(`DELETE FROM battles WHERE attacker = ANY($1)`, [towns]);
      await query(`DELETE FROM town_actions WHERE town_name = ANY($1)`, [towns]);
      await query(`DELETE FROM town_claims WHERE town_name = ANY($1)`, [towns]);
    }
    await pool.end();
  });

  async function nation(ox: number, oz: number) {
    const townName = `Turn-${process.hrtime.bigint()}`;
    towns.push(townName);
    const blocks: number[][] = [];
    for (let x = 0; x < 6; x++) for (let z = 0; z < 6; z++) blocks.push([ox + x, 0, oz + z]);
    await query(
      `INSERT INTO town_claims (town_name, block_count, blocks) VALUES ($1, $2, $3::jsonb)`,
      [townName, blocks.length, JSON.stringify(blocks)]
    );
    await query(
      `INSERT INTO army_levies (town_name, stock) VALUES ($1, 20)
       ON CONFLICT (town_name) DO UPDATE SET stock = 20`, [townName]);
    return townName;
  }

  it("the turn is derived from the clock, not stored anywhere", () => {
    const t0 = Date.UTC(2026, 8, 10, 14, 0, 0);
    assert.equal(turnOf(t0), turnOf(t0 + 59 * 60_000));      // misma hora, mismo turno
    assert.equal(turnOf(t0 + TURN_MS), turnOf(t0) + 1);      // la hora siguiente, el siguiente
    assert.equal(nextTurnAt(t0 + 60_000).getTime(), t0 + TURN_MS);
  });

  it("a fresh unit may act; one that acted this turn may not", () => {
    const now = Date.UTC(2026, 8, 10, 14, 30, 0);
    assert.equal(canAct(null, now), true);
    assert.equal(canAct(new Date(Date.UTC(2026, 8, 10, 14, 5, 0)), now), false); // mismo turno
    assert.equal(canAct(new Date(Date.UTC(2026, 8, 10, 13, 59, 0)), now), true); // turno anterior
  });

  it("mobility is a per-turn budget, not a per-click one", async () => {
    const townName = await nation(2000, 2000);
    const m = await muster(townName, "incursores", { x: 2000, y: 0, z: 2000 });
    assert.equal(m.ok, true);
    const unitId = (m as { ok: true; unitId: number }).unitId;

    const now = Date.UTC(2026, 8, 10, 14, 0, 0);
    const first = await moveUnit(townName, unitId, { x: 2002, y: 0, z: 2000 }, now);
    assert.equal(first.ok, true);

    // Segundo clic en el mismo turno: aquí es donde antes se podía cruzar el mapa entero.
    const again = await moveUnit(townName, unitId, { x: 2004, y: 0, z: 2000 }, now + 60_000);
    assert.deepEqual(again, { ok: false, error: "already_moved" });

    // La hora siguiente vuelve a tener su movimiento.
    const nextTurn = await moveUnit(townName, unitId, { x: 2004, y: 0, z: 2000 }, now + TURN_MS);
    assert.equal(nextTurn.ok, true);
  });

  it("attacking spends the turn: no rerolling the dice until they land right", async () => {
    const townName = await nation(2100, 2100);
    await muster(townName, "linea", { x: 2100, y: 0, z: 2100 });
    const now = Date.UTC(2026, 8, 10, 15, 0, 0);

    // Chunk vacío pegado al claim: la toma es segura, así que lo que se mide es el turno.
    const empty = { x: 2099, y: 0, z: 2100 };
    const moved = await moveUnit(townName, (await query<{ id: number }>(
      `SELECT id FROM army_units WHERE town_name = $1 LIMIT 1`, [townName]
    )).rows[0]!.id, empty, now);
    assert.equal(moved.ok, true);

    // Ya gastó el turno moviéndose: no puede además atacar.
    const tooSoon = await attack(townName, empty, "t1", now + 1000);
    assert.deepEqual(tooSoon, { error: "already_moved" });

    // Al turno siguiente sí, y ese ataque gasta a su vez el turno.
    const hit = await attack(townName, empty, "t2", now + TURN_MS);
    assert.ok(!("error" in hit));
    const second = await attack(townName, empty, "t3", now + TURN_MS + 1000);
    assert.deepEqual(second, { error: "already_moved" });
  });

  it("the public view says which turn it is and how many pieces are still ready", async () => {
    const townName = await nation(2200, 2200);
    await muster(townName, "milicia", { x: 2200, y: 0, z: 2200 });
    await muster(townName, "milicia", { x: 2201, y: 0, z: 2200 });

    const view = await armyOf(townName);
    assert.equal(view.turn, currentTurn());
    assert.equal(view.ready, 2); // recién reclutadas: las dos pueden actuar
    assert.ok(new Date(view.nextTurnAt).getTime() > Date.now());

    const id = (await query<{ id: number }>(
      `SELECT id FROM army_units WHERE town_name = $1 ORDER BY id LIMIT 1`, [townName]
    )).rows[0]!.id;
    await moveUnit(townName, id, { x: 2200, y: 0, z: 2201 });
    assert.equal((await armyOf(townName)).ready, 1);
  });
});
