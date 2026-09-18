import { sha256 } from "@/modules/core/core/sha256";
import { query, type Sql } from "@/modules/core/db/pool";
import {
  MATERIAL_WINDOW,
  RARITY_THRESHOLDS,
  RARITY_WINDOW,
  YIELD_THRESHOLDS,
  YIELD_WINDOW,
} from "@/modules/core/core/pow";
import { REGION, T_CAPITAL, T_DURABLE, YIELD_EPOCH } from "@/modules/core/core/yield-map";
import { FOODS, type Food } from "@/modules/mining/domain/foods";
import type { YieldTier } from "@/modules/core/core/pow";
import { FUSION_PREMIUM, RECIPES, type Recipe } from "@/modules/cards/data/recipes";
import { MATURATION_BANDS } from "@/modules/cards/data/maturation";
import {
  BONUS_CONFIRMATIONS,
  BONUS_CREDIT_STEP,
  BONUS_ROLL_MODULUS,
  BONUS_TIERS,
} from "@/modules/payments/data/bonus-table";

//Las versiones de las reglas que deciden una carta.
//
//Un regulador de cajas de botín pregunta dos cosas: cuáles son las probabilidades,
//y si son las mismas que se aplicaron de verdad. La segunda es la que falló en el
//caso Nexon (Corea, 2024): publicaban unas y aplicaban otras.
//
//Por eso la versión NO es un número que alguien sube a mano. Es el SHA-256 del
//contenido de las reglas. Cambiar un solo peso de foods.ts produce otra versión
//aunque nadie se acuerde, y cada carta guarda con cuál nació. El golden de
//rules-version.test.ts obliga además a que ese cambio sea consciente.

export type RulesKind = "yield" | "fusion" | "bonus" | "maturation";

export interface RulesVersion {
  kind: RulesKind;
  /** `<kind>:<sha256 del spec>`. */
  version: string;
  spec: unknown;
}

/**
 * TODO lo que decide qué carta sale de un hash. Si un parámetro cambia la
 * probabilidad de alguna carta, tiene que estar aquí:
 *
 *  - las ventanas del hash que se leen (hallazgo, material, rareza)
 *  - el umbral de hallazgo y los cortes de rareza
 *  - la geografía: cortes de zona, tamaño de región y época (deciden el techo)
 *  - el catálogo: clave, rango y peso de cada carta
 *
 * El orden de las claves es fijo por construcción y el catálogo se ordena por
 * clave, así que el mismo contenido da siempre el mismo JSON — y el mismo hash.
 */
export function yieldOddsSpec(foods: readonly Food[] = FOODS) {
  return {
    kind: "yield",
    windows: {
      yield: [YIELD_WINDOW.start, YIELD_WINDOW.end],
      material: [MATERIAL_WINDOW.start, MATERIAL_WINDOW.end],
      rarity: [RARITY_WINDOW.start, RARITY_WINDOW.end],
    },
    strike: {
      consumable: YIELD_THRESHOLDS.consumable,
      durable: YIELD_THRESHOLDS.durable,
      capital: YIELD_THRESHOLDS.capital,
    },
    rarity: { durable: RARITY_THRESHOLDS.durable, capital: RARITY_THRESHOLDS.capital },
    zone: { region: REGION, epoch: YIELD_EPOCH, durable: T_DURABLE, capital: T_CAPITAL },
    foods: [...foods]
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map((f) => [f.key, f.tier, f.weight]),
  };
}

/** Las reglas de fusión: recetas y prima. Mismo principio de orden fijo. */
export function fusionRulesSpec(
  recipes: readonly Recipe[] = RECIPES,
  premium: { ceiling: number; halflife: number } = FUSION_PREMIUM
) {
  return {
    kind: "fusion",
    premium: { ceiling: premium.ceiling, halflife: premium.halflife },
    recipes: [...recipes]
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map((r) => [r.key, r.from, r.count]),
  };
}

/** La tabla del bono del paquete (docs/BONO_VERIFICABLE_V1.md §3): tramos,
 *  módulo, confirmaciones, redondeo y la fórmula, que también es regla publicada. */
export function bonusRulesSpec(tiers: readonly { upto: number; pct: number }[] = BONUS_TIERS) {
  return {
    kind: "bonus",
    formula: "sha256(blockHash:orderId)|hex[0..8]|int|mod",
    modulus: BONUS_ROLL_MODULUS,
    tiers: tiers.map((t) => [t.upto, t.pct]),
    confirmations: BONUS_CONFIRMATIONS,
    creditStep: BONUS_CREDIT_STEP,
  };
}

/**
 * La maduración de una estampa (docs/ESTAMPAS_V1.md §4.5): qué bandas salen como
 * capullo, con qué pesos elige el bloque dentro de la banda, y la fórmula. Lleva la
 * versión de las probabilidades de hallazgo sobre la que se apoya: si cambia un peso de
 * foods.ts, cambia también esta.
 */
export function maturationRulesSpec(
  bands: Readonly<Record<YieldTier, readonly string[]>> = MATURATION_BANDS,
  foods: readonly Food[] = FOODS
) {
  const weightOf = new Map(foods.map((f) => [f.key, f.weight]));
  const tiers: YieldTier[] = ["capital", "consumable", "durable"];
  return {
    kind: "maturation",
    builds_on: versionOf("yield", yieldOddsSpec(foods)),
    tier: "rarity window of the mark hash",
    cocoon: "foodFor(material window of the mark hash, tier) in band(tier)",
    sealed: "sha256(markHash:blockHash_h), h = height(prevHash) + 1",
    item: "weighted pick within band(tier), material window of the sealed hash",
    bands: tiers.map((t) => [t, [...bands[t]].sort().map((k) => [k, weightOf.get(k) ?? null])]),
  };
}

/** La versión de un spec: `<kind>:<sha256 del JSON>`. */
export function versionOf(kind: RulesKind, spec: unknown): string {
  return `${kind}:${sha256(JSON.stringify(spec))}`;
}

function build(kind: RulesKind, spec: unknown): RulesVersion {
  return { kind, spec, version: versionOf(kind, spec) };
}

/** Las reglas vigentes, calculadas una vez al cargar el módulo. */
export const YIELD_ODDS: RulesVersion = build("yield", yieldOddsSpec());
export const FUSION_RULES: RulesVersion = build("fusion", fusionRulesSpec());
export const BONUS_RULES: RulesVersion = build("bonus", bonusRulesSpec());
export const MATURATION_RULES: RulesVersion = build("maturation", maturationRulesSpec());

/**
 * Publicar una versión: guardar sus reglas completas para siempre.
 *
 * Se llama dentro de la transacción de cada acuñación, sin memorizar en el
 * proceso a propósito: si se recordara "ya publicada" y esa transacción se
 * deshiciera, la fila no existiría y la FK de `cards.rules_version` tumbaría la
 * cosecha siguiente. `ON CONFLICT DO NOTHING` sobre la clave primaria es una
 * búsqueda por índice — barato, y correcto siempre.
 */
export async function publishRulesVersion(client: Sql, rules: RulesVersion): Promise<void> {
  await query(
    `INSERT INTO rules_versions (version, kind, spec) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (version) DO NOTHING`,
    [rules.version, rules.kind, JSON.stringify(rules.spec)],
    client
  );
}

/** Leer las reglas exactas de una versión, tal como se publicaron. */
export async function rulesVersionSpec(version: string): Promise<unknown | null> {
  const res = await query<{ spec: unknown }>(
    `SELECT spec FROM rules_versions WHERE version = $1`,
    [version]
  );
  return res.rows[0]?.spec ?? null;
}
