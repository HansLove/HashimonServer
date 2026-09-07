// Genera los vectores dorados de apariencia que atan el TypeScript y el Lua.
// Uso: node --import tsx scripts/gen-wolker-golden.mts
import { writeFileSync } from "node:fs";
import { CHILD_DAYS, appearanceOf, signOf, wolkerId } from "@/modules/territory/domain/wolkers";

const NOW = new Date("2026-01-01T00:00:00Z");
const vectors = [];
for (let n = 0; n < 24; n++) {
  const id = wolkerId("seed".padEnd(64, "0"), "seed".padEnd(64, "0"), n);
  for (const ageDays of [0, CHILD_DAYS - 1, CHILD_DAYS, 400]) {
    const bornAt = new Date(NOW.getTime() - ageDays * 86_400_000);
    const look = appearanceOf(id, bornAt, NOW);
    vectors.push({ id, ageDays, sign: signOf(id), stage: look.stage, model: look.model });
  }
}
const out = new URL("../../3d-world/mods/hashimon_wolkers/test/appearance_golden.json", import.meta.url);
writeFileSync(out, JSON.stringify({ childDays: CHILD_DAYS, vectors }, null, 2) + "\n");
console.log(`${vectors.length} vectores → ${out.pathname}`);
