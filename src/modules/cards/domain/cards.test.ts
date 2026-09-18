import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { pool, query, withTransaction } from "@/modules/core/db/pool";
import { evaluateYield, hashJob, type MiningJobRecord } from "@/modules/core/core/pow";
import { issueJob, submitYield, type MiningJobRow } from "@/modules/mining/domain/mining";
import { emit } from "@/modules/hashimon/domain/hashimons";
import {
  essenceOf,
  kindForTier,
  liveCardsOf,
  liveEssenceOf,
  mintFromYield,
  starsOfHash,
  supply,
} from "@/modules/cards/domain/cards";
import { FOODS } from "@/modules/mining/domain/foods";
import { YIELD_ODDS } from "@/modules/cards/domain/rules-version";

//Lo que se protege aquí es el suministro. Un hash acuña UNA carta y sólo una,
//porque esa unicidad es lo que hace la escasez verificable — si se rompe, el
//argumento entero del proyecto se cae.

describe("cartas (against the local DB)", () => {
  const playerIds: string[] = [];
  const hashes: string[] = [];

  after(async () => {
    if (hashes.length > 0) {
      await query(`DELETE FROM cards WHERE hash = ANY($1)`, [hashes]);
    }
    if (playerIds.length > 0) {
      await query(`DELETE FROM players WHERE id = ANY($1)`, [playerIds]);
    }
    await pool.end();
  });

  function uniqueHash(): string {
    const h = `${process.hrtime.bigint().toString(16)}${"0".repeat(48)}`.slice(0, 64);
    hashes.push(h);
    return h;
  }

  async function newPlayer(): Promise<string> {
    const res = await query<{ id: string }>(
      `INSERT INTO players (display_name) VALUES ('CardsTest') RETURNING id`
    );
    const id = res.rows[0]!.id;
    playerIds.push(id);
    return id;
  }

  // ── Esencia ────────────────────────────────────────────────────────────────

  it("la esencia sale del peso del catálogo, sin tabla aparte", () => {
    assert.equal(essenceOf(100), 1);  // Croqueta básica
    assert.equal(essenceOf(45), 2);   // Baya chispa
    assert.equal(essenceOf(20), 5);   // Néctar tibio
    assert.equal(essenceOf(8), 13);   // Hongo lumen
    assert.equal(essenceOf(2), 50);   // Fruta prisma / Geoda génesis
  });

  //Una carta sin valor no sería una carta: sería basura que ensucia el inventario.
  it("ninguna carta vale cero, por común que sea", () => {
    assert.equal(essenceOf(1000), 1);
    assert.equal(essenceOf(Number.MAX_SAFE_INTEGER), 1);
  });

  it("todo el catálogo produce esencia positiva", () => {
    for (const f of FOODS) {
      assert.ok(essenceOf(f.weight) >= 1, `${f.key} debe valer al menos 1`);
    }
  });

  // ── Estrellas ──────────────────────────────────────────────────────────────

  //Las estrellas son del HASH, no de la criatura: es lo que permite que una
  //carta común sea un hallazgo raro.
  it("las estrellas se leen del hash que encontró la carta", () => {
    assert.equal(starsOfHash("f".repeat(64)), 0);           // 0 bits → 0★
    assert.equal(starsOfHash(`0${"f".repeat(63)}`), 1);     // 4 bits → 1★
    assert.equal(starsOfHash(`00${"f".repeat(62)}`), 2);    // 8 bits → 2★
    assert.equal(starsOfHash(`0000${"f".repeat(60)}`), 4);  // 16 bits → 4★
  });

  it("el rango del hallazgo decide la familia", () => {
    assert.equal(kindForTier("consumable"), "food");
    assert.equal(kindForTier("durable"), "matter");
    assert.equal(kindForTier("capital"), "mutagen");
  });

  // ── Acuñación ──────────────────────────────────────────────────────────────

  it("un hallazgo acuña una carta con su esencia y sus estrellas", async () => {
    const ownerId = await newPlayer();
    const hash = uniqueHash();

    await withTransaction((client) =>
      mintFromYield(client, { hash, ownerId, tier: "consumable", itemKey: "fruta_prisma" })
    );

    const cards = await liveCardsOf(ownerId);
    assert.equal(cards.length, 1);
    assert.equal(cards[0]!.item_key, "fruta_prisma");
    assert.equal(cards[0]!.kind, "food");
    assert.equal(cards[0]!.essence, 50);
    assert.equal(cards[0]!.stars, starsOfHash(hash));
    assert.equal(cards[0]!.burned_at, null);
    //Cada carta dice con qué probabilidades nació.
    assert.equal(cards[0]!.rules_version, YIELD_ODDS.version);
  });

  //LA GARANTÍA DEL SUMINISTRO. Si un hash pudiera acuñar dos cartas, la escasez
  //dejaría de ser verificable y con ella el argumento entero.
  it("un hash acuña UNA carta, por mucho que se reintente", async () => {
    const ownerId = await newPlayer();
    const hash = uniqueHash();

    for (let i = 0; i < 4; i++) {
      await withTransaction((client) =>
        mintFromYield(client, { hash, ownerId, tier: "consumable", itemKey: "croqueta_basica" })
      );
    }

    assert.equal((await liveCardsOf(ownerId)).length, 1);
  });

  //Ni siquiera cambiando de dueño: el hash es del trabajo, no de quien lo reclama.
  it("el mismo hash no puede acuñarse para otro jugador", async () => {
    const first = await newPlayer();
    const second = await newPlayer();
    const hash = uniqueHash();

    await withTransaction((client) =>
      mintFromYield(client, { hash, ownerId: first, tier: "durable", itemKey: "veta_obsidiana" })
    );
    await withTransaction((client) =>
      mintFromYield(client, { hash, ownerId: second, tier: "durable", itemKey: "veta_obsidiana" })
    );

    assert.equal((await liveCardsOf(first)).length, 1);
    assert.equal((await liveCardsOf(second)).length, 0, "la segunda acuñación no roba la carta");
  });

  //Perder la carta de un trabajo real sería peor que valorarla de menos.
  it("un item_key desconocido no tira la acuñación", async () => {
    const ownerId = await newPlayer();
    const hash = uniqueHash();

    await withTransaction((client) =>
      mintFromYield(client, { hash, ownerId, tier: "capital", itemKey: "item_que_no_existe" })
    );

    const cards = await liveCardsOf(ownerId);
    assert.equal(cards.length, 1);
    assert.equal(cards[0]!.essence, 1, "cae al suelo de esencia en vez de perderse");
  });

  // ── Esencia del jugador y suministro ───────────────────────────────────────

  //El nivel es del jugador: la esencia suma por dueño, no por criatura.
  it("la esencia viva suma todas las cartas del jugador", async () => {
    const ownerId = await newPlayer();
    for (const key of ["fruta_prisma", "croqueta_basica", "hongo_lumen"]) {
      const hash = uniqueHash();
      await withTransaction((client) =>
        mintFromYield(client, { hash, ownerId, tier: "consumable", itemKey: key })
      );
    }
    assert.equal(await liveEssenceOf(ownerId), 50 + 1 + 13);
  });

  //Se mide POR JUGADOR y no con supply(): la suite corre los archivos en
  //paralelo, así que un contador global se mueve mientras se lee y el test
  //fallaría por concurrencia, no por un fallo real.
  it("una carta quemada sale del suministro vivo pero no de la tabla", async () => {
    const ownerId = await newPlayer();
    const hash = uniqueHash();
    await withTransaction((client) =>
      mintFromYield(client, { hash, ownerId, tier: "consumable", itemKey: "baya_chispa" })
    );

    const rowsOf = async () => {
      const r = await query(`SELECT 1 FROM cards WHERE owner_id = $1`, [ownerId]);
      return r.rowCount;
    };
    const rowsBefore = await rowsOf();
    assert.equal((await liveCardsOf(ownerId)).length, 1);

    await query(`UPDATE cards SET burned_at = now() WHERE hash = $1`, [hash]);

    assert.equal(await rowsOf(), rowsBefore, "la acuñada sigue en la tabla: es historia");
    assert.equal((await liveCardsOf(ownerId)).length, 0, "pero ya no está viva");
    assert.equal(await liveEssenceOf(ownerId), 0, "ya no se puede gastar");
  });

  //La invariante de supply() sin depender de valores absolutos, que es lo único
  //que se puede afirmar con otros tests escribiendo a la vez.
  it("el suministro siempre cuadra: vivas = acuñadas − quemadas", async () => {
    const s = await supply();
    assert.equal(s.live, s.minted - s.burned);
    assert.ok(s.minted >= s.burned, "no se puede quemar más de lo acuñado");
  });

  // ── El enganche de verdad ──────────────────────────────────────────────────

  //Los tests de arriba prueban mintFromYield aislada. Este prueba lo que de
  //verdad importa: que COSECHAR acuñe la carta. Sin él, el enganche en
  //submitYield podría no llamarse nunca y todo seguiría en verde.
  it("cosechar un hallazgo real acuña su carta en la misma transacción", async () => {
    const ownerId = await newPlayer();
    const creature = await emit({ ownerId, speciesKey: "glitchPup", provenance: "wild" });
    const jobRow = await issueJob(creature);

    //Misma conversión que rowToJob (privada en mining.ts): así se puede buscar el
    //nonce sin tocar la base un millón de veces.
    const header = jobRow.header as { templateId?: string };
    const job: MiningJobRecord = {
      id: jobRow.id,
      hashimonId: jobRow.hashimon_id,
      templateId: header.templateId ?? "",
      extranonce1: jobRow.extranonce1,
      shareTargetBits: jobRow.share_target_bits,
      blockTargetBits: jobRow.block_target_bits,
      expiresAt: new Date(jobRow.expires_at),
      mode: jobRow.mode,
      header: jobRow.header,
    };

    //El umbral de hallazgo son 20 bits: ~1 de cada 1.048.576 hashes. Se busca en
    //memoria, como haría el navegador del jugador.
    const extranonce2 = 0;
    let winner = -1;
    let winningHash = "";
    for (let nonce = 0; nonce < 8_000_000; nonce++) {
      const h = hashJob(job, extranonce2, nonce);
      if (evaluateYield(h).tier) { winner = nonce; winningHash = h; break; }
    }
    assert.notEqual(winner, -1, "no se encontró ningún hallazgo en 8M intentos");
    hashes.push(winningHash);

    const outcome = await submitYield(creature, { jobId: jobRow.id, extranonce2, nonce: winner });
    assert.equal(outcome.ok, true, `el hallazgo debía aceptarse: ${JSON.stringify(outcome)}`);

    //La prueba: existe la carta, cuelga del mismo hash y es del jugador.
    const cards = await liveCardsOf(ownerId);
    assert.equal(cards.length, 1, "un hallazgo acuña exactamente una carta");
    assert.equal(cards[0]!.hash, winningHash, "la carta cuelga del hash que la encontró");
    assert.equal(cards[0]!.owner_id, ownerId);
    assert.ok(cards[0]!.essence >= 1);
    assert.equal(cards[0]!.stars, starsOfHash(winningHash));
    assert.equal(cards[0]!.rules_version, YIELD_ODDS.version, "la cosecha real sella la versión");

    //Y el hallazgo quedó en su propio libro: los dos se confirmaron juntos.
    const yields = await query(`SELECT 1 FROM pow_yield WHERE hash = $1`, [winningHash]);
    assert.equal(yields.rowCount, 1, "la carta y el hallazgo van en la misma transacción");
  });

});
