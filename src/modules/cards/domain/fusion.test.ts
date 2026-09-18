import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { pool, query, withTransaction } from "@/modules/core/db/pool";
import { mintFromYield } from "@/modules/cards/domain/cards";
import { fuse, fusedHashOf, fusionPremium } from "@/modules/cards/domain/fusion";
import { AppError } from "@/modules/core/http/errors";
import { FUSION_RULES, YIELD_ODDS } from "@/modules/cards/domain/rules-version";

//La fusión. Lo que se protege: que el linaje sea REPRODUCIBLE (si no, deja de ser
//un recibo y pasa a ser una anotación en la que hay que creer) y que la prima
//baje sin cruzar nunca el 1.

describe("fusión (against the local DB)", () => {
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
      `INSERT INTO players (display_name) VALUES ('FusionTest') RETURNING id`
    );
    const id = res.rows[0]!.id;
    playerIds.push(id);
    return id;
  }

  async function giveCards(ownerId: string, itemKey: string, n: number, tier: "consumable" | "durable" | "capital" = "consumable") {
    for (let i = 0; i < n; i++) {
      await withTransaction((client) =>
        mintFromYield(client, { hash: uniqueHash(), ownerId, tier, itemKey })
      );
    }
  }

  // ── La prima ───────────────────────────────────────────────────────────────

  it("la prima decrece como dice el documento", () => {
    assert.equal(fusionPremium(0).toFixed(3), "1.600");
    assert.equal(fusionPremium(5).toFixed(3), "1.400");
    assert.equal(fusionPremium(10).toFixed(3), "1.300");
    assert.equal(fusionPremium(50).toFixed(3), "1.100");
  });

  //La razón de elegir hiperbólica y no exponencial: fusionar deja de ser un
  //atajo, pero nunca se vuelve una trampa que destruya valor.
  it("la prima nunca cruza el 1, ni con mil fusiones", () => {
    for (const n of [0, 10, 100, 1_000, 100_000]) {
      assert.ok(fusionPremium(n) > 1, `prima(${n}) debe ser > 1`);
    }
    assert.ok(fusionPremium(0) > fusionPremium(10));
    assert.ok(fusionPremium(10) > fusionPremium(100));
  });

  // ── El linaje ──────────────────────────────────────────────────────────────

  //Si el hash dependiera del orden, el recibo no sería reproducible y habría que
  //creerse la anotación en vez de poder comprobarla.
  it("el hash del linaje no depende del orden", () => {
    const a = "aa".repeat(32);
    const b = "bb".repeat(32);
    const c = "cc".repeat(32);
    assert.equal(fusedHashOf([a, b, c]), fusedHashOf([c, a, b]));
    assert.notEqual(fusedHashOf([a, b]), fusedHashOf([a, c]));
  });

  // ── Fusionar ───────────────────────────────────────────────────────────────

  it("fusionar quema los ingredientes y acuña una carta con su recibo", async () => {
    const ownerId = await newPlayer();
    await giveCards(ownerId, "fruta_prisma", 5);

    const out = await fuse(ownerId, "super_fruta");

    assert.equal(out.lineage.length, 5);
    assert.equal(out.essenceBurned, 250, "5 × 50");
    assert.equal(out.premium.toFixed(3), "1.600", "primera fusión de la receta");
    assert.equal(out.essence, 400, "250 × 1,6");

    //EL RECIBO: cualquiera puede recomputar el hash desde el linaje.
    assert.equal(out.hash, fusedHashOf(out.lineage), "el linaje reproduce el hash");

    //Los ingredientes quedaron quemados, no borrados.
    const burned = await query(
      `SELECT 1 FROM cards WHERE hash = ANY($1::text[]) AND burned_at IS NOT NULL`,
      [out.lineage]
    );
    assert.equal(burned.rowCount, 5);

    const live = await query<{ kind: string; item_key: string; rules_version: string }>(
      `SELECT kind, item_key, rules_version FROM cards WHERE owner_id = $1 AND burned_at IS NULL`,
      [ownerId]
    );
    assert.equal(live.rowCount, 1, "sólo queda la fusionada");
    assert.equal(live.rows[0]!.kind, "fused");
    assert.equal(live.rows[0]!.item_key, "super_fruta");
    //No nació de una tirada: su versión es la de las reglas de fusión.
    assert.equal(live.rows[0]!.rules_version, FUSION_RULES.version);
    assert.notEqual(live.rows[0]!.rules_version, YIELD_ODDS.version);
  });

  it("sin ingredientes suficientes no fusiona", async () => {
    const ownerId = await newPlayer();
    await giveCards(ownerId, "fruta_prisma", 4); // hacen falta 5

    await assert.rejects(
      () => fuse(ownerId, "super_fruta"),
      (err: AppError) => err.code === "not_enough_cards"
    );

    const live = await query(`SELECT 1 FROM cards WHERE owner_id = $1 AND burned_at IS NULL`, [ownerId]);
    assert.equal(live.rowCount, 4, "no se quemó nada en el intento fallido");
  });

  it("una receta que no existe se rechaza", async () => {
    const ownerId = await newPlayer();
    await assert.rejects(
      () => fuse(ownerId, "receta_inventada"),
      (err: AppError) => err.code === "unknown_recipe"
    );
  });

  //El corazón de "decreciente": la segunda fusión de la MISMA receta rinde menos.
  it("la segunda fusión de una receta rinde menos que la primera", async () => {
    const ownerId = await newPlayer();
    await giveCards(ownerId, "fruta_prisma", 10);

    const first = await fuse(ownerId, "super_fruta");
    const second = await fuse(ownerId, "super_fruta");

    assert.equal(first.previousFusions, 0);
    assert.equal(second.previousFusions, 1);
    assert.ok(second.essence < first.essence, "la segunda vale menos esencia");
    assert.ok(second.essence > second.essenceBurned, "pero sigue compensando fusionar");
  });

  //El contador es por receta: gastar la prima de una no debe encarecer la otra.
  it("cada receta lleva su propio contador", async () => {
    const ownerId = await newPlayer();
    await giveCards(ownerId, "fruta_prisma", 5);
    await giveCards(ownerId, "veta_obsidiana", 8, "durable");

    await fuse(ownerId, "super_fruta");
    const other = await fuse(ownerId, "corazon_obsidiana");

    assert.equal(other.previousFusions, 0, "fusionar frutas no gastó la prima de la obsidiana");
    assert.equal(other.premium.toFixed(3), "1.600");
  });

  //Quemar lo fusionado no debe reiniciar el contador: las quemadas siguen en la tabla.
  it("quemar la fusionada no devuelve la prima al máximo", async () => {
    const ownerId = await newPlayer();
    await giveCards(ownerId, "fruta_prisma", 10);

    const first = await fuse(ownerId, "super_fruta");
    await query(`UPDATE cards SET burned_at = now() WHERE card_id = $1`, [first.cardId]);

    const second = await fuse(ownerId, "super_fruta");
    assert.equal(second.previousFusions, 1, "la fusionada quemada sigue contando");
    assert.ok(second.essence < first.essence);
  });

  it("la fusionada hereda las estrellas de su mejor ingrediente", async () => {
    const ownerId = await newPlayer();
    await giveCards(ownerId, "fruta_prisma", 5);
    //Se fuerza una estrella alta en uno de los ingredientes.
    await query(
      `UPDATE cards SET stars = 9
        WHERE card_id = (SELECT card_id FROM cards WHERE owner_id = $1 AND burned_at IS NULL LIMIT 1)`,
      [ownerId]
    );

    const out = await fuse(ownerId, "super_fruta");
    const minted = await query<{ stars: number }>(
      `SELECT stars FROM cards WHERE card_id = $1`,
      [out.cardId]
    );
    assert.equal(minted.rows[0]!.stars, 9, "hereda la mejor, no la suma ni un número inventado");
  });
});
