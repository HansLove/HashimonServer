import type { YieldTier } from "@/modules/core/core/pow";

/**
 * The FOOD GRAPH (V1) — the named things a harvest can yield, and how common each is.
 *
 * A harvest already decides a TIER (consumable / durable / capital) on three axes the
 * player never steers (work · place · luck — see `mining.ts::submitYield`). This registry
 * takes the last step: *which concrete item within that tier* you got. It is resolved
 * deterministically from the hash's material window (`foodFor`) — server-recomputed, never
 * a client claim — so pulling a rare food is a genuine, uncontrolled event ("azar
 * energético que nadie controla"), which is exactly what makes it fun and fair.
 *
 * `weight` is the number the player sees on the graph node: **higher = more common**
 * (100 = everyday, 1 = rare), matching the drawing. `from` is the item's parent in the
 * graph, used only to draw the tree — it does NOT gate anything (you don't climb it; the
 * roll is flat-weighted within a tier). Everything here is content: add nodes, retune
 * weights, or ship a new "compiler" later without touching the harvest mechanics.
 *
 * Consumables are the food both Hashimon and wolkers eat (the Hashi-croqueta pantry).
 * Durable = light materials (defensive infra); capital = evolution-grade stone (V2 market).
 */

export interface Food {
  /** Stable id — the DB convenience column `pow_yield.food_key` and the UI node key. */
  key: string;
  /** Player-facing name (Spanish, the product's default language). */
  name: string;
  tier: YieldTier;
  /** Commonness weight — higher is MORE common. The number shown on the graph node. */
  weight: number;
  /** Parent node in the food graph, for drawing the tree. Presentation only. */
  from?: string;
}

export const FOODS: Food[] = [
  // ── Consumable — foods (croquetas). The everyday sink; eaten by Hashimon and wolkers. ──
  { key: "croqueta_basica", name: "Croqueta básica", tier: "consumable", weight: 100 },
  { key: "baya_chispa", name: "Baya chispa", tier: "consumable", weight: 45, from: "croqueta_basica" },
  { key: "nectar_tibio", name: "Néctar tibio", tier: "consumable", weight: 20, from: "croqueta_basica" },
  { key: "hongo_lumen", name: "Hongo lumen", tier: "consumable", weight: 8, from: "baya_chispa" },
  { key: "fruta_prisma", name: "Fruta prisma", tier: "consumable", weight: 2, from: "hongo_lumen" }, // rare treat

  // ── Durable — light materials (defensive infrastructure). ──
  { key: "esquirla_ambar", name: "Esquirla de ámbar", tier: "durable", weight: 60 },
  { key: "veta_obsidiana", name: "Veta obsidiana", tier: "durable", weight: 25, from: "esquirla_ambar" },
  { key: "nucleo_denso", name: "Núcleo denso", tier: "durable", weight: 6, from: "veta_obsidiana" },

  // ── Capital — evolution-grade stone (the V2 market). ──
  { key: "roca_mutagena", name: "Roca mutágena", tier: "capital", weight: 12 },
  { key: "geoda_genesis", name: "Geoda génesis", tier: "capital", weight: 2, from: "roca_mutagena" }, // ultra rare
];

const BY_KEY: Map<string, Food> = new Map(FOODS.map((f) => [f.key, f]));
const BY_TIER: Record<YieldTier, Food[]> = {
  consumable: FOODS.filter((f) => f.tier === "consumable"),
  durable: FOODS.filter((f) => f.tier === "durable"),
  capital: FOODS.filter((f) => f.tier === "capital"),
};

export function foodByKey(key: string): Food | undefined {
  return BY_KEY.get(key);
}

/**
 * Resolve which concrete food a harvest yielded — weighted by `weight`, deterministic from
 * the material window (`evaluateYield().materialKey`, hex[32..48], 64 bits). Pure: the same
 * (materialKey, tier) always maps to the same food, and the server recomputes it rather
 * than trusting anything the client reports.
 */
export function foodFor(materialKey: string, tier: YieldTier): Food {
  const pool = BY_TIER[tier];
  // Every tier ships at least one food; this only guards a future empty-tier mistake.
  if (pool.length === 0) throw new Error(`no foods registered for tier ${tier}`);
  const total = pool.reduce((s, f) => s + f.weight, 0);
  // First 8 hex of the material window = a 32-bit roll; modulo bias over totals < 1000 is
  // negligible. `>>> 0` keeps it an unsigned int even if the hex parses to a large value.
  const roll = (parseInt(materialKey.slice(0, 8), 16) >>> 0) % total;
  let acc = 0;
  for (const f of pool) {
    acc += f.weight;
    if (roll < acc) return f;
  }
  return pool[pool.length - 1]!; // unreachable: roll < total
}
