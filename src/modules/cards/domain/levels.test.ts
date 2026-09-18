import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { pool, query, withTransaction } from "@/modules/core/db/pool";
import { essenceOf } from "@/modules/cards/domain/cards";
import { foodByKey } from "@/modules/mining/domain/foods";
import {
  MAX_LEVEL,
  burnForLevel,
  levelCost,
  levelStateOf,
  mutationGrantsOf,
  mutationLevelsCrossed,
} from "@/modules/cards/domain/levels";
import { AppError } from "@/modules/core/http/errors";

//La escalera de 99. Lo que se protege: que una carta no pueda pagarse dos veces
//(sería esencia de la nada) y que la barra se vacíe de verdad en cada salto.

describe("escalera de niveles (against the local DB)", () => {
  const playerIds: string[] = [];

  after(async () => {
    if (playerIds.length > 0) {
      await query(`DELETE FROM players WHERE id = ANY($1)`, [playerIds]);
    }
    await pool.end();
  });

  let seq = 0;
  function uniqueHash(): string {
    seq += 1;
    return `${process.hrtime.bigint().toString(16)}${seq.toString(16)}${"0".repeat(64)}`.slice(0, 64);
  }

  async function newPlayer(): Promise<string> {
    const res = await query<{ id: string }>(
      `INSERT INTO players (display_name) VALUES ('LevelsTest') RETURNING id`
    );
    const id = res.rows[0]!.id;
    playerIds.push(id);
    return id;
  }

  /** n cartas de `itemKey` para ese jugador, en un solo INSERT.
   *
   *  Directo y no por `mintFromYield`: aquí se prueba la QUEMA, y llegar al nivel
   *  20 pide 162 cartas — una transacción por carta haría el test inútilmente
   *  lento. La acuñación ya tiene sus propios tests en cards.test.ts. */
  async function giveCards(ownerId: string, itemKey: string, n: number): Promise<string[]> {
    const essence = essenceOf(foodByKey(itemKey)?.weight ?? 100);
    const hashes = Array.from({ length: n }, () => uniqueHash());
    const res = await query<{ card_id: string }>(
      `INSERT INTO cards (hash, owner_id, kind, item_key, stars, essence)
       SELECT h, $2, 'food', $3, 0, $4 FROM unnest($1::text[]) AS h
       RETURNING card_id`,
      [hashes, ownerId, itemKey, essence]
    );
    return res.rows.map((r) => r.card_id);
  }

  // ── La curva ───────────────────────────────────────────────────────────────

  it("la curva es la del documento", () => {
    assert.equal(levelCost(1), 12);
    assert.equal(levelCost(5), 134);
    assert.equal(levelCost(20), 1073);
    assert.equal(levelCost(50), 4243);
    assert.equal(levelCost(98), 11642);
  });

  it("subir siempre cuesta más que el nivel anterior", () => {
    for (let n = 1; n < MAX_LEVEL; n++) {
      assert.ok(levelCost(n + 1) > levelCost(n), `nivel ${n} debe costar menos que ${n + 1}`);
    }
  });

  // ── Los hitos de mutación ──────────────────────────────────────────────────

  it("cruza un hito por cada decena, y ninguno pasado el 90", () => {
    assert.deepEqual(mutationLevelsCrossed(1, 9), []);
    assert.deepEqual(mutationLevelsCrossed(1, 10), [10]);
    assert.deepEqual(mutationLevelsCrossed(9, 11), [10]);
    //Un salto grande otorga TODOS los hitos que cruzó, no sólo el último.
    assert.deepEqual(mutationLevelsCrossed(1, 35), [10, 20, 30]);
    //Del 90 al 99 no hay más: el tope se gana por terco, no por recompensa.
    assert.deepEqual(mutationLevelsCrossed(85, 99), [90]);
    assert.deepEqual(mutationLevelsCrossed(90, 99), []);
  });

  // ── La quema ───────────────────────────────────────────────────────────────

  it("quemar cartas sube de nivel y la barra se vacía", async () => {
    const ownerId = await newPlayer();
    //Fruta prisma = 50 esencia. El nivel 1 cuesta 12.
    const ids = await giveCards(ownerId, "fruta_prisma", 1);

    const out = await burnForLevel(ownerId, ids);

    assert.equal(out.burned, 1);
    assert.equal(out.essenceGained, 50);
    //50 de esencia: paga el nivel 1 (12), el 2 (34) y sobran 4 — el 3 cuesta 62.
    assert.equal(out.level, 3);
    assert.equal(out.essence, 50 - 12 - 34);
    assert.equal(out.levelsGained, 2);
    assert.equal(out.nextCost, levelCost(3));
  });

  //LA GARANTÍA. Si una carta pudiera pagarse dos veces, la esencia saldría de la nada.
  it("la misma carta no se puede quemar dos veces", async () => {
    const ownerId = await newPlayer();
    const ids = await giveCards(ownerId, "fruta_prisma", 1);

    const first = await burnForLevel(ownerId, ids);
    assert.equal(first.essenceGained, 50);

    await assert.rejects(
      () => burnForLevel(ownerId, ids),
      (err: AppError) => err.code === "nothing_to_burn"
    );

    const state = await levelStateOf(ownerId);
    assert.equal(state.level, first.level, "el nivel no se movió con el segundo intento");
  });

  it("no se pueden quemar cartas de otro jugador", async () => {
    const mine = await newPlayer();
    const theirs = await newPlayer();
    const theirCards = await giveCards(theirs, "fruta_prisma", 1);

    await assert.rejects(
      () => burnForLevel(mine, theirCards),
      (err: AppError) => err.code === "nothing_to_burn"
    );

    //Y siguen vivas para su dueño.
    const stillAlive = await query(
      `SELECT 1 FROM cards WHERE card_id = ANY($1::uuid[]) AND burned_at IS NULL`,
      [theirCards]
    );
    assert.equal(stillAlive.rowCount, 1);
  });

  it("quemar sin cartas se rechaza en vez de no hacer nada", async () => {
    const ownerId = await newPlayer();
    await assert.rejects(() => burnForLevel(ownerId, []), (e: AppError) => e.code === "no_cards");
  });

  // ── Los derechos de mutación ───────────────────────────────────────────────

  it("cruzar el nivel 10 otorga una mutación, y un salto grande las otorga todas", async () => {
    const ownerId = await newPlayer();
    //Llegar al nivel 20 pide 8.055 de esencia: 170 frutas prisma (50 c/u) cruzan
    //el 10 y el 20 de una sola quema.
    const ids = await giveCards(ownerId, "fruta_prisma", 170);
    const out = await burnForLevel(ownerId, ids);

    assert.ok(out.level >= 20, `esperaba pasar del 20, quedó en ${out.level}`);
    const grants = await mutationGrantsOf(ownerId);
    assert.deepEqual(
      grants.map((g) => g.level),
      out.mutationsUnlocked,
      "los derechos guardados son los hitos cruzados"
    );
    assert.ok(grants.length >= 2, "cruzó al menos el 10 y el 20");
    assert.equal(grants[0]!.claimed_at, null, "nace sin reclamar");
  });

  it("un derecho no se otorga dos veces por el mismo nivel", async () => {
    const ownerId = await newPlayer();
    const first = await giveCards(ownerId, "fruta_prisma", 30);
    await burnForLevel(ownerId, first);
    const before = (await mutationGrantsOf(ownerId)).length;

    const second = await giveCards(ownerId, "croqueta_basica", 5);
    await burnForLevel(ownerId, second);
    const grants = await mutationGrantsOf(ownerId);

    const levels = grants.map((g) => g.level);
    assert.equal(new Set(levels).size, levels.length, "sin duplicados");
    assert.ok(grants.length >= before);
  });

  // ── El tope ────────────────────────────────────────────────────────────────

  it("en el tope la esencia sobrante se queda en la barra, no se tira", async () => {
    const ownerId = await newPlayer();
    await query(`UPDATE players SET level = $2, essence = 0 WHERE id = $1`, [ownerId, MAX_LEVEL]);
    const ids = await giveCards(ownerId, "fruta_prisma", 2);

    const out = await burnForLevel(ownerId, ids);

    assert.equal(out.level, MAX_LEVEL, "no pasa del 99");
    assert.equal(out.essence, 100, "la esencia sigue ahí: quemar nunca cuesta nada");
    assert.equal(out.nextCost, null);
    assert.deepEqual(out.mutationsUnlocked, []);
  });
});
