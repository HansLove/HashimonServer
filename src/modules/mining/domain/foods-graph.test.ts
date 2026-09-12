// The food graph (V1): pure catalog + deterministic weighted resolver. No DB.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOODS, foodFor, foodByKey } from "@/modules/mining/domain/foods";
import type { YieldTier } from "@/modules/core/core/pow";

test("every tier ships at least one food, and keys are unique", () => {
  for (const tier of ["consumable", "durable", "capital"] as YieldTier[]) {
    assert.ok(FOODS.some((f) => f.tier === tier), `no food for ${tier}`);
  }
  assert.equal(new Set(FOODS.map((f) => f.key)).size, FOODS.length, "duplicate food key");
  for (const f of FOODS) {
    if (f.from) assert.ok(foodByKey(f.from), `${f.key}.from=${f.from} is not a real node`);
    assert.ok(f.weight > 0, `${f.key} weight must be positive`);
  }
});

test("foodFor is deterministic and reads only the material window", () => {
  const a = foodFor("abcdef0123456789", "consumable");
  assert.equal(foodFor("abcdef0123456789", "consumable").key, a.key); // stable
  // Only hex[0..8] of the material key drives the roll; the tail must not change it.
  assert.equal(foodFor("abcdef01ffffffff", "consumable").key, foodFor("abcdef0100000000", "consumable").key);
});

test("foodFor picks the weighted node the roll lands in (first item at roll 0)", () => {
  // roll = parseInt(first8,16) % totalWeight. 0x00000000 → roll 0 → first item of the tier.
  assert.equal(foodFor("0000000000000000", "consumable").key, "croqueta_basica");
  assert.equal(foodFor("0000000000000000", "durable").key, "esquirla_ambar");
  assert.equal(foodFor("0000000000000000", "capital").key, "roca_mutagena");
});

test("the whole consumable pool is reachable and weighted toward common foods", () => {
  const pool = FOODS.filter((f) => f.tier === "consumable");
  const total = pool.reduce((s, f) => s + f.weight, 0);
  const seen = new Map<string, number>();
  // Sweep every possible roll value by crafting the exact remainder into the window.
  for (let roll = 0; roll < total; roll++) {
    const hex = (roll >>> 0).toString(16).padStart(8, "0");
    const key = foodFor(hex + "00000000", "consumable").key;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  // Each node occupies exactly its weight-many roll slots — the graph's numbers are the odds.
  for (const f of pool) assert.equal(seen.get(f.key), f.weight, `${f.key} span`);
  // The rare treat is the smallest slice; the root is the largest.
  assert.ok((seen.get("fruta_prisma") ?? 0) < (seen.get("croqueta_basica") ?? 0));
});
