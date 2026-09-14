// Meta-diplomacia entre towns (Towny no tiene alianzas propias). Lo que hay que comprobar:
// que el par se guarda canónico sin importar el orden en que se pida, y que
// presentDiplomacy separa allies/incoming/outgoing correctamente.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  activateAlliance,
  deleteAlliance,
  getAlliance,
  insertProposal,
  listActiveAlliancePairs,
  listAlliancesForTown,
  presentDiplomacy,
  resolveTownName,
  type AllianceRow,
} from "@/modules/territory/domain/diplomacy";
import { pool, query } from "@/modules/core/db/pool";

describe("presentDiplomacy — función pura", () => {
  it("separa aliados activos, propuestas salientes (proposed_by = town) y entrantes", () => {
    const rows: AllianceRow[] = [
      { id: 1, town_a: "Brújula", town_b: "Norte", status: "active", proposed_by: "Norte" },
      { id: 2, town_a: "Brújula", town_b: "Sur", status: "proposed", proposed_by: "Brújula" },
      { id: 3, town_a: "Este", town_b: "Brújula", status: "proposed", proposed_by: "Este" },
    ];
    const result = presentDiplomacy("Brújula", rows);
    assert.deepEqual(result, { allies: ["Norte"], incoming: ["Este"], outgoing: ["Sur"] });
  });

  it("sin filas devuelve las tres listas vacías", () => {
    assert.deepEqual(presentDiplomacy("Brújula", []), { allies: [], incoming: [], outgoing: [] });
  });

  it("resuelve el otro town sin importar en qué columna quedó (town_a o town_b)", () => {
    const rows: AllianceRow[] = [
      { id: 1, town_a: "Alfa", town_b: "Brújula", status: "active", proposed_by: "Alfa" },
    ];
    assert.deepEqual(presentDiplomacy("Brújula", rows).allies, ["Alfa"]);
  });
});

describe("diplomacy — CRUD contra Postgres", () => {
  const townNames: string[] = [];

  after(async () => {
    if (townNames.length > 0) {
      await query(`DELETE FROM town_alliances WHERE town_a = ANY($1) OR town_b = ANY($1)`, [townNames]);
      await query(`DELETE FROM town_claims WHERE town_name = ANY($1)`, [townNames]);
    }
    await pool.end();
  });

  function nextTown(prefix = "DiploTest"): string {
    const name = `${prefix}-${process.hrtime.bigint().toString(36)}`;
    townNames.push(name);
    return name;
  }

  it("resolveTownName: resuelve case-insensitive a la grafía canónica; sin match -> null", async () => {
    const townName = nextTown("Brújula");
    await query(`INSERT INTO town_claims (town_name, block_count) VALUES ($1, 1)`, [townName]);
    assert.equal(await resolveTownName(townName.toLowerCase()), townName);
    assert.equal(await resolveTownName("no-existe-" + townName), null);
  });

  it("getAlliance: sin relación -> null", async () => {
    const a = nextTown("A");
    const b = nextTown("B");
    assert.equal(await getAlliance(a, b), null);
  });

  it("insertProposal + getAlliance: el par se guarda canónico sin importar el orden de consulta", async () => {
    const a = nextTown("A");
    const b = nextTown("B");
    await insertProposal(a, b);
    const viaAB = await getAlliance(a, b);
    const viaBA = await getAlliance(b, a);
    assert.ok(viaAB);
    assert.equal(viaAB!.status, "proposed");
    assert.equal(viaAB!.proposed_by, a);
    assert.deepEqual(viaAB, viaBA); // misma fila canónica, en cualquier orden de consulta
  });

  it("insertProposal: una segunda propuesta duplicada no pisa la primera (ON CONFLICT DO NOTHING)", async () => {
    const a = nextTown("A");
    const b = nextTown("B");
    await insertProposal(a, b);
    await insertProposal(b, a); // el otro town "propone" después: no debe cambiar proposed_by
    const alliance = await getAlliance(a, b);
    assert.equal(alliance?.proposed_by, a);
  });

  it("activateAlliance: pasa la relación de proposed a active", async () => {
    const a = nextTown("A");
    const b = nextTown("B");
    await insertProposal(a, b);
    await activateAlliance(a, b);
    const alliance = await getAlliance(a, b);
    assert.equal(alliance?.status, "active");
  });

  it("deleteAlliance: borra la fila; getAlliance vuelve a devolver null", async () => {
    const a = nextTown("A");
    const b = nextTown("B");
    await insertProposal(a, b);
    await deleteAlliance(a, b);
    assert.equal(await getAlliance(a, b), null);
  });

  it("listAlliancesForTown: encuentra relaciones tanto si el town quedó en town_a como en town_b", async () => {
    const hub = nextTown("Hub");
    const neighborLow = nextTown("AAA"); // menor alfabéticamente: hub quedará en town_b
    const neighborHigh = nextTown("ZZZ"); // mayor: hub quedará en town_a
    await insertProposal(hub, neighborLow);
    await insertProposal(hub, neighborHigh);
    const relations = await listAlliancesForTown(hub);
    assert.equal(relations.length, 2);
    const others = relations.map((r) => (r.town_a === hub ? r.town_b : r.town_a)).sort();
    assert.deepEqual(others, [neighborHigh, neighborLow].sort());
  });

  it("listActiveAlliancePairs: sólo devuelve relaciones activas, no las meramente propuestas", async () => {
    const a = nextTown("A");
    const b = nextTown("B");
    const c = nextTown("C");
    await insertProposal(a, b);
    await activateAlliance(a, b);
    await insertProposal(a, c); // se queda en proposed

    const pairs = await listActiveAlliancePairs();
    const [lo, hi] = a < b ? [a, b] : [b, a];
    assert.ok(pairs.some(([x, y]) => x === lo && y === hi));
    assert.ok(!pairs.some(([x, y]) => (x === a && y === c) || (x === c && y === a)));
  });
});
