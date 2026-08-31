// Paridad TS <-> Lua de la Birth Identity, sobre las 17,897 fechas de 1970-2018.
//
// Corre los DOS INTÉRPRETES REALES: node sobre core/birth-identity.ts y luajit
// sobre hashimon_core/birth_identity.lua, y compara línea por línea. Un
// validador que reimplementa las reglas se valida sólo a sí mismo — esa fue
// exactamente la lección de validate_morphology.py, que reportaba PASS mientras
// el 100% de las criaturas eran lobos.
//
//   cd api && pnpm validate:birth        (o: node --import tsx scripts/validate-birth-identity.mts)
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { birthIdentityOf, SPIRITS } from "@/core/birth-identity";
import { Hashimons, GenesisV2, isGenesisV2 } from "@/data/species";

//El dump Lua vive en el repo, no en el paquete api.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const dates = [];
for (let y = 1970; y <= 2018; y++) {
  for (let m = 1; m <= 12; m++) {
    const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
    for (let d = 1; d <= dim; d++) {
      dates.push(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    }
  }
}

const ts = dates.map((iso) => {
  const b = birthIdentityOf(iso);
  return `${iso}|${b.lifeNumber}|${b.element}|${b.undertone ?? "-"}|${b.spirit}|${b.speciesKey}|${b.templateId}`;
});

let lua;
try {
  lua = execFileSync("luajit", [path.join(REPO, "scripts/birth_identity_dump.lua")], {
    cwd: REPO, encoding: "utf8", maxBuffer: 64 << 20,
  }).trim().split("\n");
} catch (err) {
  console.error("FAIL: could not run luajit —", err.message);
  process.exit(1);
}

let fail = 0;
if (lua.length !== ts.length) {
  console.error(`FAIL: line count TS ${ts.length} vs Lua ${lua.length}`);
  fail++;
}
for (let i = 0; i < Math.min(ts.length, lua.length); i++) {
  if (ts[i] !== lua[i]) {
    if (fail < 6) { console.error(`FAIL @${i}\n  TS  ${ts[i]}\n  Lua ${lua[i]}`); }
    fail++;
  }
}

// Cierre del allowlist: ninguna fecha puede producir una especie que la puerta
// de emisión rechace. Si esto falla, un jugador legítimo no puede registrarse.
let orphan = 0;
for (const iso of dates) {
  const k = birthIdentityOf(iso).speciesKey;
  if (!isGenesisV2(k) || !Hashimons[k]) { orphan++; }
}

// Reparto: lo que se mide es lo que se juega.
const el = {}, sp = {};
for (const iso of dates) {
  const b = birthIdentityOf(iso);
  el[b.element] = (el[b.element] ?? 0) + 1;
  sp[b.spirit] = (sp[b.spirit] ?? 0) + 1;
}
const pct = (n) => `${((100 * n) / dates.length).toFixed(1)}%`;

console.log(`dates          ${dates.length} (1970-2018)`);
console.log(`parity         ${fail === 0 ? `OK — ${ts.length}/${ts.length} identical` : `${fail} MISMATCHES`}`);
console.log(`allowlist      ${orphan === 0 ? `OK — every date resolves to an accepted speciesKey` : `${orphan} ORPHANS`}`);
console.log(`species        ${Object.keys(GenesisV2).length}/60 generated`);
console.log(`elements       ${Object.entries(el).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pct(v)}`).join("  ")}`);
console.log(`spirits        ${SPIRITS.map((s) => `${s.name} ${pct(sp[s.key])}`).join("  ")}`);

const families = SPIRITS.flatMap((s) => s.line);
const dupes = families.filter((f, i) => families.indexOf(f) !== i);
console.log(`families       ${families.length} across 12 lines${dupes.length ? ` — DUPLICATED: ${dupes}` : ", no duplicates"}`);

process.exit(fail === 0 && orphan === 0 && dupes.length === 0 ? 0 : 1);
