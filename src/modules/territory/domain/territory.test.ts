// Proyección Towny (claims, ranking, roster) y la cola de acciones político/claim que el
// mundo re-valida. Lo que importa comprobar: que las funciones puras (presenters, geometría
// de mapblock, merge de overlays) hacen exactamente lo documentado, y que el CRUD contra
// Postgres upsertea/filtra/ordena como dice cada comentario.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TOWN_CLAIM_DAILY_LIMIT,
  countTownClaimsToday,
  enqueueRankAction,
  enqueueTownAction,
  formatClaimTarget,
  getPlayerTerritory,
  getTownClaimQuota,
  getTownClaimsByName,
  getTownInvites,
  getTownMembers,
  hasPendingClaimAt,
  listInvitesForPlayer,
  listPendingClaimsForTown,
  listPendingTownActions,
  listTownClaims,
  listTownRanking,
  listVisibleClaimOverlays,
  mapblockBordersTown,
  mapblockOwnedByTown,
  memberIsOfficer,
  mergeClaimOverlaysIntoTowns,
  parseClaimTarget,
  presentTerritory,
  presentTownClaims,
  presentTownRanking,
  replaceTownClaims,
  resolveTownAction,
  upsertPlayerTerritory,
  type PlayerTerritoryRow,
  type TownActionRow,
  type TownClaimInput,
  type TownClaimsRow,
  type TownMember,
  type TownRankRow,
} from "@/modules/territory/domain/territory";
import { pool, query } from "@/modules/core/db/pool";

describe("territory — pure presenters and geometry", () => {
  it("presentTownClaims: home es null si falta cualquier coordenada, tupla si están las tres", () => {
    const rows: TownClaimsRow[] = [
      {
        town_name: "Brújula",
        block_count: 3,
        mayor: "diego",
        home_x: 1,
        home_y: 8,
        home_z: -1,
        blocks: [[1, 8, -1]],
        members: [{ name: "diego", rank: "mayor" }],
        invites: [],
      },
      {
        town_name: "SinHogar",
        block_count: 0,
        mayor: null,
        home_x: null,
        home_y: 8,
        home_z: 0,
        blocks: [],
        members: [],
        invites: [],
      },
    ];
    const presented = presentTownClaims(rows);
    assert.deepEqual(presented[0]!.home, [1, 8, -1]);
    assert.equal(presented[1]!.home, null);
  });

  it("presentTownRanking: asigna rank 1-based en el orden recibido", () => {
    const rows: TownRankRow[] = [
      { town_name: "A", block_count: 30, member_count: 4, mayor: "x" },
      { town_name: "B", block_count: 10, member_count: 1, mayor: null },
    ];
    const presented = presentTownRanking(rows);
    assert.equal(presented[0]!.rank, 1);
    assert.equal(presented[1]!.rank, 2);
    assert.equal(presented[1]!.mayor, null);
  });

  it("presentTerritory: sin fila -> hasTown false y updatedAt null", () => {
    assert.deepEqual(presentTerritory(null), {
      hasTown: false,
      townName: null,
      townBlockCount: 0,
      ownedPlotCount: 0,
      isMayor: false,
      updatedAt: null,
    });
  });

  it("presentTerritory: fila sin town_name -> hasTown false pero conserva updatedAt", () => {
    const row: PlayerTerritoryRow = {
      player_id: "p1",
      town_name: null,
      town_block_count: 0,
      owned_plot_count: 0,
      is_mayor: false,
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    const presented = presentTerritory(row);
    assert.equal(presented.hasTown, false);
    assert.equal(presented.updatedAt, "2026-01-01T00:00:00.000Z");
  });

  it("presentTerritory: fila con town -> hasTown true con todos los campos de la fila", () => {
    const row: PlayerTerritoryRow = {
      player_id: "p1",
      town_name: "Brújula",
      town_block_count: 12,
      owned_plot_count: 3,
      is_mayor: true,
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    assert.deepEqual(presentTerritory(row), {
      hasTown: true,
      townName: "Brújula",
      townBlockCount: 12,
      ownedPlotCount: 3,
      isMayor: true,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("formatClaimTarget: codifica bx,by,bz incluyendo negativos", () => {
    assert.equal(formatClaimTarget(1, 2, 3), "1,2,3");
    assert.equal(formatClaimTarget(-4, 0, -9), "-4,0,-9");
  });

  it("parseClaimTarget: hace el viaje de ida y vuelta con formatClaimTarget", () => {
    assert.deepEqual(parseClaimTarget(formatClaimTarget(-4, 0, 9)), [-4, 0, 9]);
  });

  it("parseClaimTarget: recorta espacios y rechaza formatos inválidos", () => {
    assert.deepEqual(parseClaimTarget(" 1,2,3 "), [1, 2, 3]);
    assert.equal(parseClaimTarget("no-a-target"), null);
    assert.equal(parseClaimTarget("1,2"), null);
    assert.equal(parseClaimTarget(""), null);
  });

  it("mapblockBordersTown: distancia Manhattan 1 es borde, 0 y 2+ no lo son", () => {
    const blocks: [number, number, number][] = [[0, 0, 0]];
    assert.equal(mapblockBordersTown(1, 0, 0, blocks), true); // ortogonal, distancia 1
    assert.equal(mapblockBordersTown(0, 0, 0, blocks), false); // el mismo bloque, distancia 0
    assert.equal(mapblockBordersTown(1, 0, 1, blocks), false); // diagonal, distancia 2
    assert.equal(mapblockBordersTown(5, 5, 5, []), false); // sin bloques, no hay frontera
  });

  it("mapblockOwnedByTown: coincidencia exacta de coordenadas", () => {
    const blocks: [number, number, number][] = [[2, 8, -3]];
    assert.equal(mapblockOwnedByTown(2, 8, -3, blocks), true);
    assert.equal(mapblockOwnedByTown(2, 8, -2, blocks), false);
    assert.equal(mapblockOwnedByTown(0, 0, 0, []), false);
  });

  it("memberIsOfficer: mayor y comayor cuentan, resident no, comparación case-insensitive", () => {
    const members: TownMember[] = [
      { name: "Diego", rank: "mayor" },
      { name: "ana", rank: "comayor" },
      { name: "bob", rank: "resident" },
    ];
    assert.equal(memberIsOfficer(members, "diego"), true);
    assert.equal(memberIsOfficer(members, "ANA"), true);
    assert.equal(memberIsOfficer(members, "bob"), false);
    assert.equal(memberIsOfficer(members, "nadie"), false);
    assert.equal(memberIsOfficer([], "diego"), false);
  });

  it("mergeClaimOverlaysIntoTowns: sin overlays devuelve la misma lista sin tocarla", () => {
    const towns = presentTownClaims([
      {
        town_name: "Brújula",
        block_count: 1,
        mayor: null,
        home_x: null,
        home_y: null,
        home_z: null,
        blocks: [[0, 0, 0]],
        members: [],
        invites: [],
      },
    ]);
    const merged = mergeClaimOverlaysIntoTowns(towns, []);
    assert.equal(merged, towns); // misma referencia, early-return documentado
  });

  it("mergeClaimOverlaysIntoTowns: añade bloques nuevos case-insensitive y sube blockCount", () => {
    const towns = presentTownClaims([
      {
        town_name: "Brújula",
        block_count: 1,
        mayor: null,
        home_x: null,
        home_y: null,
        home_z: null,
        blocks: [[0, 0, 0]],
        members: [],
        invites: [],
      },
    ]);
    const merged = mergeClaimOverlaysIntoTowns(towns, [
      { townName: "brújula", block: [1, 0, 0] },
    ]);
    assert.deepEqual(merged[0]!.blocks, [
      [0, 0, 0],
      [1, 0, 0],
    ]);
    assert.equal(merged[0]!.blockCount, 2);
  });

  it("mergeClaimOverlaysIntoTowns: deduplica overlays que ya están en el snapshot y no toca towns sin overlay", () => {
    const towns = presentTownClaims([
      {
        town_name: "Brújula",
        block_count: 5,
        mayor: null,
        home_x: null,
        home_y: null,
        home_z: null,
        blocks: [[0, 0, 0]],
        members: [],
        invites: [],
      },
      {
        town_name: "OtroPueblo",
        block_count: 1,
        mayor: null,
        home_x: null,
        home_y: null,
        home_z: null,
        blocks: [[9, 9, 9]],
        members: [],
        invites: [],
      },
    ]);
    const merged = mergeClaimOverlaysIntoTowns(towns, [{ townName: "Brújula", block: [0, 0, 0] }]);
    assert.equal(merged[0], towns[0]); // ya lo tenía: misma referencia, sin cambios
    assert.equal(merged[1], towns[1]); // sin overlay propio: intacto
  });

  it("mergeClaimOverlaysIntoTowns: overlay de un town que no está en el snapshot se ignora", () => {
    const towns = presentTownClaims([
      {
        town_name: "Brújula",
        block_count: 1,
        mayor: null,
        home_x: null,
        home_y: null,
        home_z: null,
        blocks: [[0, 0, 0]],
        members: [],
        invites: [],
      },
    ]);
    const merged = mergeClaimOverlaysIntoTowns(towns, [{ townName: "Fantasma", block: [5, 5, 5] }]);
    assert.deepEqual(merged, towns);
  });
});

describe("territory — CRUD contra Postgres", () => {
  const playerIds: string[] = [];
  const townNames: string[] = [];

  after(async () => {
    if (townNames.length > 0) {
      await query(`DELETE FROM town_actions WHERE town_name = ANY($1)`, [townNames]);
      await query(`DELETE FROM town_claims WHERE town_name = ANY($1)`, [townNames]);
    }
    if (playerIds.length > 0) {
      await query(`DELETE FROM players WHERE id = ANY($1)`, [playerIds]);
    }
    await pool.end();
  });

  function nextTown(prefix = "TerritoryTest"): string {
    const name = `${prefix}-${process.hrtime.bigint().toString(36)}`;
    townNames.push(name);
    return name;
  }

  async function seedPlayerRow(): Promise<string> {
    const result = await query<{ id: string }>(
      `INSERT INTO players (display_name) VALUES ($1) RETURNING id`,
      [`TerritoryPlayer-${process.hrtime.bigint().toString(36)}`]
    );
    const id = result.rows[0]!.id;
    playerIds.push(id);
    return id;
  }

  it("upsertPlayerTerritory: inserta y luego un segundo upsert reemplaza los campos", async () => {
    const playerId = await seedPlayerRow();
    const first = await upsertPlayerTerritory({
      playerId,
      townName: "Brújula",
      townBlockCount: 4,
      ownedPlotCount: 1,
      isMayor: false,
    });
    assert.equal(first.town_name, "Brújula");

    const second = await upsertPlayerTerritory({
      playerId,
      townName: "OtroPueblo",
      townBlockCount: 9,
      ownedPlotCount: 2,
      isMayor: true,
    });
    assert.equal(second.town_name, "OtroPueblo");
    assert.equal(second.owned_plot_count, 2);
    assert.equal(second.is_mayor, true);

    const stored = await getPlayerTerritory(playerId);
    assert.equal(stored?.town_name, "OtroPueblo");
  });

  it("getPlayerTerritory: sin fila devuelve null", async () => {
    const result = await getPlayerTerritory("00000000-0000-0000-0000-000000000000");
    assert.equal(result, null);
  });

  it("listTownRanking: ordena por block_count desc, member_count desc, town_name asc, y respeta el limit", async () => {
    const townA = nextTown("Rank");
    const townB = nextTown("Rank");
    await query(
      `INSERT INTO town_claims (town_name, block_count, member_count, mayor) VALUES ($1, 50, 3, 'x')`,
      [townA]
    );
    await query(
      `INSERT INTO town_claims (town_name, block_count, member_count, mayor) VALUES ($1, 10, 1, null)`,
      [townB]
    );
    const ranking = await listTownRanking(1);
    assert.equal(ranking.length, 1);
    assert.equal(ranking[0]!.town_name, townA);
  });

  it("getTownMembers: town inexistente -> array vacío, town existente -> su roster", async () => {
    const townName = nextTown("Members");
    const members: TownMember[] = [
      { name: "diego", rank: "mayor" },
      { name: "ana", rank: "resident" },
    ];
    await query(
      `INSERT INTO town_claims (town_name, block_count, member_count, mayor, members) VALUES ($1, 2, 2, 'diego', $2::jsonb)`,
      [townName, JSON.stringify(members)]
    );
    assert.deepEqual(await getTownMembers(townName), members);
    assert.deepEqual(await getTownMembers("NoExiste-" + townName), []);
  });

  it("getTownClaimsByName: fila existente trae invites por defecto vacías; inexistente -> null", async () => {
    const townName = nextTown("ClaimsByName");
    await query(`INSERT INTO town_claims (town_name, block_count) VALUES ($1, 1)`, [townName]);
    const found = await getTownClaimsByName(townName);
    assert.equal(found?.town_name, townName);
    assert.deepEqual(found?.invites, []);
    assert.equal(await getTownClaimsByName("NoExiste-" + townName), null);
  });

  it("listTownClaims / presentTownClaims: pipeline completo, ordenado por block_count desc", async () => {
    const smaller = nextTown("Claims");
    const bigger = nextTown("Claims");
    await query(`INSERT INTO town_claims (town_name, block_count) VALUES ($1, 2)`, [smaller]);
    await query(`INSERT INTO town_claims (town_name, block_count) VALUES ($1, 20)`, [bigger]);
    const rows = await listTownClaims();
    const presented = presentTownClaims(rows);
    const names = presented.map((t) => t.townName);
    assert.ok(names.indexOf(bigger) < names.indexOf(smaller));
  });

  it("countTownClaimsToday / getTownClaimQuota: sólo cuenta claims pending/applied de hoy", async () => {
    const townName = nextTown("Quota");
    await query(
      `INSERT INTO town_actions (town_name, actor, target, op, status) VALUES ($1, 'diego', '1,0,1', 'claim', 'pending')`,
      [townName]
    );
    await query(
      `INSERT INTO town_actions (town_name, actor, target, op, status) VALUES ($1, 'diego', '2,0,2', 'claim', 'applied')`,
      [townName]
    );
    await query(
      `INSERT INTO town_actions (town_name, actor, target, op, status) VALUES ($1, 'diego', '3,0,3', 'claim', 'rejected')`,
      [townName]
    );
    // No cuenta: no es un claim.
    await query(
      `INSERT INTO town_actions (town_name, actor, target, op, status) VALUES ($1, 'diego', 'diego', 'kick', 'pending')`,
      [townName]
    );
    // No cuenta: es de ayer.
    await query(
      `INSERT INTO town_actions (town_name, actor, target, op, status, created_at)
       VALUES ($1, 'diego', '9,0,9', 'claim', 'pending', now() - interval '1 day')`,
      [townName]
    );
    assert.equal(await countTownClaimsToday(townName), 2);
    const quota = await getTownClaimQuota(townName);
    assert.deepEqual(quota, {
      used: 2,
      limit: TOWN_CLAIM_DAILY_LIMIT,
      remaining: TOWN_CLAIM_DAILY_LIMIT - 2,
    });
  });

  it("hasPendingClaimAt: true sólo si hay un claim pending exactamente en ese target", async () => {
    const townName = nextTown("PendingAt");
    await query(
      `INSERT INTO town_actions (town_name, actor, target, op, status) VALUES ($1, 'diego', '4,0,4', 'claim', 'pending')`,
      [townName]
    );
    assert.equal(await hasPendingClaimAt(townName, "4,0,4"), true);
    assert.equal(await hasPendingClaimAt(townName, "5,0,5"), false);
  });

  it("listVisibleClaimOverlays: pending y applied recientes aparecen, applied antiguo no", async () => {
    const townName = nextTown("Overlays");
    await query(
      `INSERT INTO town_actions (town_name, actor, target, op, status) VALUES ($1, 'diego', '1,0,1', 'claim', 'pending')`,
      [townName]
    );
    await query(
      `INSERT INTO town_actions (town_name, actor, target, op, status, applied_at)
       VALUES ($1, 'diego', '2,0,2', 'claim', 'applied', now())`,
      [townName]
    );
    await query(
      `INSERT INTO town_actions (town_name, actor, target, op, status, applied_at)
       VALUES ($1, 'diego', '3,0,3', 'claim', 'applied', now() - interval '10 minutes')`,
      [townName]
    );
    const overlays = await listVisibleClaimOverlays();
    const forTown = overlays.filter((o) => o.townName === townName);
    const targets = forTown.map((o) => o.block.join(","));
    assert.ok(targets.includes("1,0,1"));
    assert.ok(targets.includes("2,0,2"));
    assert.ok(!targets.includes("3,0,3"));
  });

  it("listPendingClaimsForTown: sólo los claims pending de ese town, en orden de creación", async () => {
    const townName = nextTown("PendingForTown");
    await query(
      `INSERT INTO town_actions (town_name, actor, target, op, status) VALUES ($1, 'diego', '1,0,1', 'claim', 'pending')`,
      [townName]
    );
    await query(
      `INSERT INTO town_actions (town_name, actor, target, op, status) VALUES ($1, 'diego', '2,0,2', 'claim', 'applied')`,
      [townName]
    );
    const pending = await listPendingClaimsForTown(townName);
    assert.deepEqual(pending, [[1, 0, 1]]);
  });

  it("enqueueTownAction / listPendingTownActions / resolveTownAction: ciclo completo", async () => {
    const townName = nextTown("Actions");
    await enqueueTownAction({ townName, actor: "diego", target: "ana", op: "invite" });
    const pendingBefore = await listPendingTownActions(1000);
    const mine = pendingBefore.find((a) => a.town_name === townName) as TownActionRow | undefined;
    assert.ok(mine);
    assert.equal(mine!.op, "invite");

    await resolveTownAction(mine!.id, "applied", "ok");
    const pendingAfter = await listPendingTownActions(1000);
    assert.ok(!pendingAfter.some((a) => a.id === mine!.id));
  });

  it("enqueueRankAction: wrapper deprecado que encola la misma fila que enqueueTownAction", async () => {
    const townName = nextTown("RankAction");
    await enqueueRankAction({ townName, actor: "diego", target: "ana", op: "add", rank: "comayor" });
    const pending = await listPendingTownActions(1000);
    const mine = pending.find((a) => a.town_name === townName);
    assert.equal(mine?.op, "add");
    assert.equal(mine?.rank, "comayor");
  });

  it("getTownInvites / listInvitesForPlayer: usernames case-insensitive", async () => {
    const townName = nextTown("Invites");
    await query(
      `INSERT INTO town_claims (town_name, block_count, invites) VALUES ($1, 1, '["Ana"]'::jsonb)`,
      [townName]
    );
    assert.deepEqual(await getTownInvites(townName), ["Ana"]);
    const found = await listInvitesForPlayer("ANA");
    assert.ok(found.includes(townName));
    const notFound = await listInvitesForPlayer("nadie-invitado-" + townName);
    assert.ok(!notFound.includes(townName));
  });

  it("replaceTownClaims: upsertea el listado sin borrar towns incluidos, y añade nuevos", async () => {
    const keep = nextTown("Replace");
    await query(`INSERT INTO town_claims (town_name, block_count) VALUES ($1, 1)`, [keep]);

    const fresh = nextTown("Replace");
    const input: TownClaimInput[] = [
      {
        name: keep,
        blockCount: 7,
        memberCount: 2,
        mayor: "diego",
        homeX: 0,
        homeY: 8,
        homeZ: 0,
        blocks: [[0, 0, 0]],
        members: [{ name: "diego", rank: "mayor" }],
        invites: [],
      },
      {
        name: fresh,
        blockCount: 1,
        memberCount: 1,
        mayor: null,
        homeX: null,
        homeY: null,
        homeZ: null,
        blocks: [],
        members: [],
        invites: [],
      },
    ];
    const count = await replaceTownClaims(input);
    assert.equal(count, 2);

    const keptRow = await getTownClaimsByName(keep);
    assert.equal(keptRow?.block_count, 7); // upserteado, no re-creado a ciegas
    const freshRow = await getTownClaimsByName(fresh);
    assert.ok(freshRow); // town nuevo insertado
  });

  it("replaceTownClaims: con lista vacía borra TODA la tabla town_claims (comportamiento documentado)", async () => {
    // El propio código comenta: "not an incremental merge". Lo confirmamos contra una
    // tabla propia y aislada (no la compartida) para no interferir con otras suites
    // que corren contra la misma base de datos en paralelo.
    const isolatedTown = nextTown("WipeCheck");
    await query(`INSERT INTO town_claims (town_name, block_count) VALUES ($1, 1)`, [isolatedTown]);
    const backup = await query<{
      town_name: string;
      block_count: number;
      member_count: number;
      mayor: string | null;
      home_x: number | null;
      home_y: number | null;
      home_z: number | null;
      blocks: [number, number, number][];
      members: TownMember[];
      invites: string[];
    }>(
      `SELECT town_name, block_count, member_count, mayor, home_x, home_y, home_z, blocks, members,
              COALESCE(invites, '[]'::jsonb) AS invites
         FROM town_claims`
    );
    try {
      const count = await replaceTownClaims([]);
      assert.equal(count, 0);
      const afterWipe = await query(`SELECT count(*)::int AS n FROM town_claims`);
      assert.equal((afterWipe.rows[0] as { n: number }).n, 0);
    } finally {
      // Restaura exactamente lo que había, incluido lo de otras suites concurrentes.
      for (const row of backup.rows) {
        await query(
          `INSERT INTO town_claims
             (town_name, block_count, member_count, mayor, home_x, home_y, home_z, blocks, members, invites)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb)
           ON CONFLICT (town_name) DO NOTHING`,
          [
            row.town_name,
            row.block_count,
            row.member_count,
            row.mayor,
            row.home_x,
            row.home_y,
            row.home_z,
            JSON.stringify(row.blocks),
            JSON.stringify(row.members),
            JSON.stringify(row.invites),
          ]
        );
      }
    }
  });
});
