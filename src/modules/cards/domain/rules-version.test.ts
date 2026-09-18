import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { pool, query, withTransaction } from "@/modules/core/db/pool";
import { FOODS } from "@/modules/mining/domain/foods";
import { RECIPES } from "@/modules/cards/data/recipes";
import {
  FUSION_RULES,
  YIELD_ODDS,
  fusionRulesSpec,
  publishRulesVersion,
  rulesVersionSpec,
  versionOf,
  yieldOddsSpec,
} from "@/modules/cards/domain/rules-version";

//Las versiones de reglas existen para que nadie pueda cambiar las probabilidades
//en silencio (el caso Nexon). Estos tests protegen justo eso.

// ── GOLDEN ───────────────────────────────────────────────────────────────────
//
// Si este test falla es porque cambió algo que decide qué carta sale de un hash.
// Eso NO es un bug que arreglar tocando el número: es una versión nueva de las
// probabilidades. Antes de actualizar el valor:
//   1. confirma que el cambio es intencional;
//   2. publica la tabla nueva donde los jugadores la lean;
//   3. entonces sí, pega aquí el hash nuevo.
const GOLDEN_YIELD = "yield:002a33871b18f921dd29a73e15ec8f56bb917deab98c6e6880ddf67c673c8b84";
const GOLDEN_FUSION = "fusion:cbd95014d767cf5352aebbe20b03a81159934a29f8229b99ef0c4fa815004898";

describe("versiones de reglas — puro", () => {
  it("las probabilidades vigentes son las publicadas (golden)", () => {
    assert.equal(YIELD_ODDS.version, GOLDEN_YIELD);
  });

  it("las reglas de fusión vigentes son las publicadas (golden)", () => {
    assert.equal(FUSION_RULES.version, GOLDEN_FUSION);
  });

  //LA GARANTÍA. Tocar un solo peso cambia la versión aunque nadie la suba a mano.
  it("cambiar un solo peso produce otra versión", () => {
    const altered = FOODS.map((f) => (f.key === "fruta_prisma" ? { ...f, weight: 3 } : f));
    assert.notEqual(versionOf("yield", yieldOddsSpec(altered)), YIELD_ODDS.version);
  });

  it("añadir o quitar una carta del catálogo produce otra versión", () => {
    const fewer = FOODS.filter((f) => f.key !== "geoda_genesis");
    assert.notEqual(versionOf("yield", yieldOddsSpec(fewer)), YIELD_ODDS.version);
  });

  it("cambiar la prima o una receta de fusión produce otra versión", () => {
    assert.notEqual(
      versionOf("fusion", fusionRulesSpec(RECIPES, { ceiling: 0.5, halflife: 10 })),
      FUSION_RULES.version
    );
    const cheaper = RECIPES.map((r) => (r.key === "super_fruta" ? { ...r, count: 4 } : r));
    assert.notEqual(versionOf("fusion", fusionRulesSpec(cheaper)), FUSION_RULES.version);
  });

  //Reordenar el catálogo no cambia ninguna probabilidad, así que no debe cambiar
  //la versión: si cambiara, la versión delataría cambios que no existen.
  it("reordenar el catálogo NO cambia la versión", () => {
    const shuffled = [...FOODS].reverse();
    assert.equal(versionOf("yield", yieldOddsSpec(shuffled)), YIELD_ODDS.version);
  });

  it("el spec contiene todo lo que decide una carta", () => {
    const spec = YIELD_ODDS.spec as Record<string, unknown>;
    for (const key of ["windows", "strike", "rarity", "zone", "foods"]) {
      assert.ok(key in spec, `falta ${key} en el spec`);
    }
    assert.equal((spec.foods as unknown[]).length, FOODS.length);
  });
});

describe("versiones de reglas — publicación (against the local DB)", () => {
  after(async () => {
    await pool.end();
  });

  //Una versión publicada debe poder leerse EXACTAMENTE como era, para siempre:
  //es lo que se le entrega a un auditor.
  it("una versión publicada se lee tal cual", async () => {
    await withTransaction((client) => publishRulesVersion(client, YIELD_ODDS));
    const spec = await rulesVersionSpec(YIELD_ODDS.version);
    assert.deepEqual(spec, YIELD_ODDS.spec);
  });

  it("publicar dos veces la misma versión es inocuo", async () => {
    await withTransaction((client) => publishRulesVersion(client, FUSION_RULES));
    await withTransaction((client) => publishRulesVersion(client, FUSION_RULES));
    const res = await query(`SELECT 1 FROM rules_versions WHERE version = $1`, [FUSION_RULES.version]);
    assert.equal(res.rowCount, 1);
  });

  it("una versión desconocida no devuelve nada", async () => {
    assert.equal(await rulesVersionSpec("yield:no-existe"), null);
  });
});
