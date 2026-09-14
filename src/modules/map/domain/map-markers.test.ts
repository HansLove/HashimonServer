import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  homeblockToWorld,
  pickWorldDestination,
  presentMarker,
  BLOCK_SIZE,
  MAX_PLAYER_WAYPOINTS,
  MAX_NATION_POIS,
  ARRIVE_RADIUS,
  __setQueryForTest,
  __resetQueryForTest,
  createPlayerWaypoint,
  deletePlayerWaypoint,
  updatePlayerWaypoint,
  createNationPoi,
  deleteNationPoi,
  updateNationPoi,
  listPlayerWaypoints,
  listNationPois,
  listActiveHashimonQuests,
  arriveAtMarker,
  onWorldDestinationComplete,
  ensureHashimonDestination,
  ensureAllHashimonDestinations,
  capitalForPlayer,
  assertCanEditNation,
  bundleForPlayer,
  markersForLuantiUsername,
  arriveForLuantiUsername,
  questForHashimon,
  type MapMarkerRow,
} from "@/modules/map/domain/map-markers";
import { AppError } from "@/modules/core/http/errors";
import { fakeQuery, uniqueId } from "@/test/support/db";
import { seedPlayer, seedHashimon, deletePlayers } from "@/test/support/fixtures";
import { query as poolQuery, pool } from "@/modules/core/db/pool";

function rejectsWithCode(code: string) {
  return (err: unknown) => err instanceof AppError && err.code === code;
}

function markerRow(overrides: Partial<MapMarkerRow> = {}): MapMarkerRow {
  return {
    id: "marker-1",
    kind: "player",
    owner_player_id: "player-1",
    town_name: null,
    hashimon_id: null,
    x: 0,
    y: 8,
    z: 0,
    label: "test",
    color_index: 2,
    status: "active",
    meta: {},
    created_at: "2026-01-01T00:00:00.000Z",
    completed_at: null,
    ...overrides,
  };
}

describe("homeblockToWorld", () => {
  it("matches website formula (block * size + size/2)", () => {
    assert.deepEqual(homeblockToWorld([0, 0, 0]), { x: 8, y: 8, z: 8 });
    assert.deepEqual(homeblockToWorld([1, -1, 2], BLOCK_SIZE), {
      x: 16 + 8,
      y: -16 + 8,
      z: 32 + 8,
    });
  });

  it("floors an odd block size when halving", () => {
    assert.deepEqual(homeblockToWorld([2, 0, 0], 7), { x: 17, y: 3, z: 3 });
  });
});

describe("pickWorldDestination", () => {
  it("avoids capital and last sector tiles when alternatives exist", () => {
    const dest = pickWorldDestination({
      tiles: [
        [0, 0],
        [5, 5],
      ],
      lastSector: "tile:0:0",
      capitalWorld: { x: 8, y: 8, z: 8 }, // tile 0,0
      hashimonId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    });
    assert.equal(dest.sector, "tile:5:5");
    assert.equal(dest.x, 5 * 128 + 64);
    assert.equal(dest.z, 5 * 128 + 64);
  });

  it("is stable for the same hashimon id", () => {
    const a = pickWorldDestination({
      tiles: [
        [1, 1],
        [2, 2],
        [3, 3],
      ],
      lastSector: null,
      capitalWorld: null,
      hashimonId: "11111111-2222-3333-4444-555555555555",
    });
    const b = pickWorldDestination({
      tiles: [
        [1, 1],
        [2, 2],
        [3, 3],
      ],
      lastSector: null,
      capitalWorld: null,
      hashimonId: "11111111-2222-3333-4444-555555555555",
    });
    assert.deepEqual(a, b);
  });

  it("falls back to offset when no tiles", () => {
    const dest = pickWorldDestination({
      tiles: [],
      lastSector: null,
      capitalWorld: { x: 100, y: 12, z: 200 },
      hashimonId: "deadbeef-dead-beef-dead-beefdeadbeef",
    });
    assert.match(dest.sector, /^xz:/);
    assert.equal(dest.y, 12);
  });

  it("falls back to origin when there are no tiles and no capital (degenerate)", () => {
    const dest = pickWorldDestination({
      tiles: [],
      lastSector: null,
      capitalWorld: null,
      hashimonId: "",
    });
    assert.match(dest.sector, /^xz:/);
    assert.equal(dest.y, 8);
  });

  it("still picks a tile when every candidate is the avoided one", () => {
    const dest = pickWorldDestination({
      tiles: [[0, 0]],
      lastSector: "tile:0:0",
      capitalWorld: null,
      hashimonId: "11111111-2222-3333-4444-555555555555",
    });
    assert.equal(dest.sector, "tile:0:0");
  });
});

/**
 * Contract for GET /internal/luanti-map-markers → hashimon_map_sync.
 * Manual check: place a WP on /map → wait ≤30s in-game → discovery_maps shows api_<uuid>.
 */
describe("presentMarker Luanti contract", () => {
  it("exposes id, x/y/z, label, colorIndex, kind for discovery_maps upsert", () => {
    const row: MapMarkerRow = {
      id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      kind: "player",
      owner_player_id: "11111111-2222-4333-8444-555555555555",
      town_name: null,
      hashimon_id: null,
      x: 120.5,
      y: 8,
      z: -64,
      label: "WP 120,-64",
      color_index: 2,
      status: "active",
      meta: {},
      created_at: "2026-01-01T00:00:00.000Z",
      completed_at: null,
    };
    const m = presentMarker(row);
    assert.equal(m.id, row.id);
    assert.equal(m.kind, "player");
    assert.equal(m.x, 120.5);
    assert.equal(m.y, 8);
    assert.equal(m.z, -64);
    assert.equal(m.label, "WP 120,-64");
    assert.equal(m.colorIndex, 2);
    assert.ok("meta" in m);
    // Luanti reads camelCase colorIndex (see hashimon_map_sync apply_markers).
    assert.equal((m as { color_index?: unknown }).color_index, undefined);
  });

  it("defaults a missing/undefined meta to {} (degenerate row)", () => {
    const row = markerRow({ meta: undefined as unknown as Record<string, unknown> });
    assert.deepEqual(presentMarker(row).meta, {});
  });
});

describe("listPlayerWaypoints / listNationPois / listActiveHashimonQuests (query seam)", () => {
  it("parses jsonb meta, defaulting invalid shapes (array/null) to {}", async () => {
    const { query } = fakeQuery(() => [
      markerRow({ id: "a", meta: { note: "x" } }),
      markerRow({ id: "b", meta: [1, 2] as unknown as Record<string, unknown> }),
      markerRow({ id: "c", meta: null as unknown as Record<string, unknown> }),
    ]);
    __setQueryForTest(query);
    try {
      const out = await listPlayerWaypoints("p1");
      assert.equal(out.length, 3);
      assert.deepEqual(out[0]!.meta, { note: "x" });
      assert.deepEqual(out[1]!.meta, {});
      assert.deepEqual(out[2]!.meta, {});
    } finally {
      __resetQueryForTest();
    }
  });

  it("returns an empty list when nothing is active (degenerate)", async () => {
    const { query } = fakeQuery(() => []);
    __setQueryForTest(query);
    try {
      assert.deepEqual(await listNationPois("SomeTown"), []);
      assert.deepEqual(await listActiveHashimonQuests("p1"), []);
    } finally {
      __resetQueryForTest();
    }
  });
});

describe("createPlayerWaypoint (query seam)", () => {
  it("trims the label and creates the row through the seam", async () => {
    const { query, calls } = fakeQuery((text, params) => {
      if (text.includes("count(*)")) return [{ n: "3" }];
      return [
        markerRow({
          id: "wp-1",
          owner_player_id: params[0] as string,
          x: params[1] as number,
          y: params[2] as number,
          z: params[3] as number,
          label: params[4] as string,
        }),
      ];
    });
    __setQueryForTest(query);
    try {
      const wp = await createPlayerWaypoint({ playerId: "p1", x: 1, y: 2, z: 3, label: "  Home  " });
      assert.equal(wp.label, "Home");
      assert.deepEqual(wp.meta, {});
      assert.equal(calls.length, 2);
    } finally {
      __resetQueryForTest();
    }
  });

  it("defaults a blank label to 'Waypoint' and slices a long one to 80 chars (edge)", async () => {
    const { query } = fakeQuery((text, params) =>
      text.includes("count(*)") ? [{ n: "0" }] : [markerRow({ label: params[4] as string })]
    );
    __setQueryForTest(query);
    try {
      const blank = await createPlayerWaypoint({ playerId: "p1", x: 0, y: 0, z: 0, label: "   " });
      assert.equal(blank.label, "Waypoint");

      const long = await createPlayerWaypoint({ playerId: "p1", x: 0, y: 0, z: 0, label: "x".repeat(200) });
      assert.equal(long.label.length, 80);
    } finally {
      __resetQueryForTest();
    }
  });

  it("rejects a waypoint beyond MAX_PLAYER_WAYPOINTS (error)", async () => {
    const { query } = fakeQuery((text) =>
      text.includes("count(*)") ? [{ n: String(MAX_PLAYER_WAYPOINTS) }] : []
    );
    __setQueryForTest(query);
    try {
      await assert.rejects(
        createPlayerWaypoint({ playerId: "p1", x: 0, y: 0, z: 0, label: "one more" }),
        rejectsWithCode("waypoint_limit")
      );
    } finally {
      __resetQueryForTest();
    }
  });
});

describe("deletePlayerWaypoint / deleteNationPoi (query seam)", () => {
  it("dismisses an existing waypoint (simple)", async () => {
    const { query } = fakeQuery(() => [{}]);
    __setQueryForTest(query);
    try {
      await assert.doesNotReject(deletePlayerWaypoint("p1", "wp-1"));
    } finally {
      __resetQueryForTest();
    }
  });

  it("rejects when no active waypoint matched (error)", async () => {
    const { query } = fakeQuery(() => []);
    __setQueryForTest(query);
    try {
      await assert.rejects(deletePlayerWaypoint("p1", "missing"), rejectsWithCode("not_found"));
    } finally {
      __resetQueryForTest();
    }
  });

  it("rejects a nation POI outside the caller's town (error)", async () => {
    const { query } = fakeQuery(() => []);
    __setQueryForTest(query);
    try {
      await assert.rejects(deleteNationPoi("TownX", "poi-1"), rejectsWithCode("not_found"));
    } finally {
      __resetQueryForTest();
    }
  });
});

describe("updatePlayerWaypoint / updateNationPoi (query seam)", () => {
  it("applies the patch and returns the parsed row (general)", async () => {
    const { query } = fakeQuery(() => [markerRow({ id: "wp-1", label: "New", x: 9 })]);
    __setQueryForTest(query);
    try {
      const wp = await updatePlayerWaypoint("p1", "wp-1", { label: "New", x: 9 });
      assert.equal(wp.label, "New");
      assert.equal(wp.x, 9);
    } finally {
      __resetQueryForTest();
    }
  });

  it("rejects when the row doesn't exist (error)", async () => {
    const { query } = fakeQuery(() => []);
    __setQueryForTest(query);
    try {
      await assert.rejects(updatePlayerWaypoint("p1", "missing", {}), rejectsWithCode("not_found"));
      await assert.rejects(updateNationPoi("TownX", "missing", {}), rejectsWithCode("not_found"));
    } finally {
      __resetQueryForTest();
    }
  });
});

describe("createNationPoi (query seam)", () => {
  it("rejects a POI beyond MAX_NATION_POIS (error)", async () => {
    const { query } = fakeQuery((text) =>
      text.includes("count(*)") ? [{ n: String(MAX_NATION_POIS) }] : []
    );
    __setQueryForTest(query);
    try {
      await assert.rejects(
        createNationPoi({ townName: "TownX", ownerPlayerId: "p1", x: 0, y: 0, z: 0, label: "" }),
        rejectsWithCode("poi_limit")
      );
    } finally {
      __resetQueryForTest();
    }
  });

  it("defaults a blank label to 'POI' (edge)", async () => {
    const { query } = fakeQuery((text, params) =>
      text.includes("count(*)")
        ? [{ n: "0" }]
        : [markerRow({ kind: "nation", town_name: "TownX", label: params[5] as string })]
    );
    __setQueryForTest(query);
    try {
      const poi = await createNationPoi({ townName: "TownX", ownerPlayerId: "p1", x: 0, y: 0, z: 0, label: "   " });
      assert.equal(poi.label, "POI");
    } finally {
      __resetQueryForTest();
    }
  });
});

describe("arriveAtMarker (query seam)", () => {
  it("rejects a marker that doesn't exist (degenerate)", async () => {
    const { query } = fakeQuery(() => []);
    __setQueryForTest(query);
    try {
      await assert.rejects(
        arriveAtMarker({ playerId: "p1", markerId: "missing", x: 0, y: 0, z: 0 }),
        rejectsWithCode("not_found")
      );
    } finally {
      __resetQueryForTest();
    }
  });

  it("rejects a marker that is no longer active (error)", async () => {
    const { query } = fakeQuery(() => [markerRow({ status: "completed" })]);
    __setQueryForTest(query);
    try {
      await assert.rejects(
        arriveAtMarker({ playerId: "player-1", markerId: "m1", x: 0, y: 8, z: 0 }),
        rejectsWithCode("not_found")
      );
    } finally {
      __resetQueryForTest();
    }
  });

  it("rejects a non-hashimon marker kind (error)", async () => {
    const { query } = fakeQuery(() => [markerRow({ kind: "player" })]);
    __setQueryForTest(query);
    try {
      await assert.rejects(
        arriveAtMarker({ playerId: "player-1", markerId: "m1", x: 0, y: 8, z: 0 }),
        rejectsWithCode("invalid_kind")
      );
    } finally {
      __resetQueryForTest();
    }
  });

  it("rejects a quest that belongs to someone else (error)", async () => {
    const { query } = fakeQuery(() => [markerRow({ kind: "hashimon", owner_player_id: "someone-else" })]);
    __setQueryForTest(query);
    try {
      await assert.rejects(
        arriveAtMarker({ playerId: "player-1", markerId: "m1", x: 0, y: 8, z: 0 }),
        rejectsWithCode("forbidden")
      );
    } finally {
      __resetQueryForTest();
    }
  });

  it("rejects arrival outside the radius, defaulting to ARRIVE_RADIUS when meta lacks one (edge)", async () => {
    const { query } = fakeQuery(() => [
      markerRow({ kind: "hashimon", owner_player_id: "player-1", x: 0, y: 8, z: 0, meta: {} }),
    ]);
    __setQueryForTest(query);
    try {
      await assert.rejects(
        arriveAtMarker({ playerId: "player-1", markerId: "m1", x: ARRIVE_RADIUS + 9, y: 8, z: 0 }),
        rejectsWithCode("too_far")
      );
    } finally {
      __resetQueryForTest();
    }
  });

  it("completes on arrival within radius, using meta.sector and meta.radius (general)", async () => {
    const { query } = fakeQuery((text) =>
      text.includes("SELECT * FROM map_markers WHERE id")
        ? [
            markerRow({
              kind: "hashimon",
              owner_player_id: "player-1",
              hashimon_id: null,
              x: 0,
              y: 8,
              z: 0,
              meta: { sector: "tile:1:1", radius: 5 },
            }),
          ]
        : [markerRow({ kind: "hashimon", status: "completed" })]
    );
    __setQueryForTest(query);
    try {
      const result = await arriveAtMarker({ playerId: "player-1", markerId: "m1", x: 3, y: 8, z: 0 });
      assert.equal(result.completed, true);
      assert.equal(result.marker.status, "completed");
    } finally {
      __resetQueryForTest();
    }
  });
});

describe("arriveAtMarker completing a hashimon quest (real DB care + memory)", () => {
  it("cares for the creature and writes a companion memory line", async () => {
    const player = await seedPlayer();
    const creature = await seedHashimon(player.id);
    try {
      const sector = "tile:7:7";
      const { query } = fakeQuery(async (text, params) => {
        if (text.includes("SELECT * FROM map_markers WHERE id")) {
          return [
            markerRow({
              kind: "hashimon",
              owner_player_id: player.id,
              hashimon_id: creature.id,
              x: 0,
              y: 8,
              z: 0,
              meta: { sector, radius: 5 },
            }),
          ];
        }
        if (text.includes("UPDATE map_markers SET status = 'completed'")) {
          return [markerRow({ kind: "hashimon", status: "completed", hashimon_id: creature.id })];
        }
        // companion_memory INSERT (from onWorldDestinationComplete) — let it hit the real pool.
        const res = await poolQuery(text, params);
        return res.rows;
      });
      __setQueryForTest(query);
      try {
        const result = await arriveAtMarker({ playerId: player.id, markerId: "m1", x: 3, y: 8, z: 0 });
        assert.equal(result.completed, true);
      } finally {
        __resetQueryForTest();
      }

      const memory = await poolQuery<{ text: string }>(
        `SELECT text FROM companion_memory WHERE hashimon_id = $1`,
        [creature.id]
      );
      assert.equal(memory.rows.length, 1);
      assert.match(memory.rows[0]!.text, /^Me llevaste a tile:7:7\./);
    } finally {
      await deletePlayers([player.id]);
    }
  });
});

describe("onWorldDestinationComplete (real DB)", () => {
  it("writes a truncated companion memory line naming the sector", async () => {
    const player = await seedPlayer();
    const creature = await seedHashimon(player.id);
    try {
      await onWorldDestinationComplete(creature.id, "xz:12:34");
      const rows = await poolQuery<{ text: string }>(
        `SELECT text FROM companion_memory WHERE hashimon_id = $1`,
        [creature.id]
      );
      assert.equal(rows.rows.length, 1);
      assert.match(rows.rows[0]!.text, /^Me llevaste a xz:12:34\./);
    } finally {
      await deletePlayers([player.id]);
    }
  });
});

describe("ensureHashimonDestination (real DB)", () => {
  it("returns null when world care isn't currently the lowest (degenerate)", async () => {
    const player = await seedPlayer();
    const creature = await seedHashimon(player.id);
    try {
      const marker = await ensureHashimonDestination({
        playerId: player.id,
        hashimonId: creature.id,
        creatureName: "Rex",
      });
      assert.equal(marker, null);
    } finally {
      await deletePlayers([player.id]);
    }
  });

  it("creates one destination when world care is the lowest, and re-ensure is idempotent (general)", async () => {
    const player = await seedPlayer();
    const creature = await seedHashimon(player.id);
    try {
      const longAgo = new Date(Date.now() - 400 * 3_600_000);
      await poolQuery(
        `INSERT INTO companion_state (hashimon_id, world_at) VALUES ($1, $2)
           ON CONFLICT (hashimon_id) DO UPDATE SET world_at = EXCLUDED.world_at`,
        [creature.id, longAgo]
      );

      const first = await ensureHashimonDestination({
        playerId: player.id,
        hashimonId: creature.id,
        creatureName: "Rex",
      });
      assert.ok(first);
      assert.equal(first!.kind, "hashimon");
      assert.match((first!.meta as { sector: string }).sector, /^xz:/);

      const second = await ensureHashimonDestination({
        playerId: player.id,
        hashimonId: creature.id,
        creatureName: "Rex",
      });
      assert.equal(second!.id, first!.id, "re-ensure must not create a second active destination");
    } finally {
      await deletePlayers([player.id]);
    }
  });
});

describe("capitalForPlayer / assertCanEditNation (real DB)", () => {
  it("capitalForPlayer is null for a player with no town (degenerate)", async () => {
    const player = await seedPlayer();
    try {
      assert.equal(await capitalForPlayer(player.id), null);
    } finally {
      await deletePlayers([player.id]);
    }
  });

  it("assertCanEditNation rejects a player with no town (error)", async () => {
    const player = await seedPlayer();
    try {
      await assert.rejects(assertCanEditNation(player.id, null), rejectsWithCode("no_town"));
    } finally {
      await deletePlayers([player.id]);
    }
  });

  it("a mayor may always edit, and capitalForPlayer resolves the town's home block (general)", async () => {
    const player = await seedPlayer();
    const townName = uniqueId("Town");
    try {
      await poolQuery(
        `INSERT INTO player_territory (player_id, town_name, is_mayor) VALUES ($1, $2, true)`,
        [player.id, townName]
      );
      await poolQuery(
        `INSERT INTO town_claims (town_name, home_x, home_y, home_z) VALUES ($1, $2, $3, $4)`,
        [townName, 16, 8, 32]
      );

      const perm = await assertCanEditNation(player.id, null);
      assert.deepEqual(perm, { townName, isMayor: true });

      const capital = await capitalForPlayer(player.id);
      assert.deepEqual(capital, {
        townName,
        home: [16, 8, 32],
        world: homeblockToWorld([16, 8, 32]),
        blockSize: BLOCK_SIZE,
      });
    } finally {
      await poolQuery(`DELETE FROM town_claims WHERE town_name = $1`, [townName]);
      await deletePlayers([player.id]);
    }
  });

  it("a resident with no matching rank is forbidden; a co-mayor member is allowed (edge)", async () => {
    const player = await seedPlayer();
    const townName = uniqueId("Town");
    try {
      await poolQuery(
        `INSERT INTO player_territory (player_id, town_name, is_mayor) VALUES ($1, $2, false)`,
        [player.id, townName]
      );
      await assert.rejects(assertCanEditNation(player.id, null), rejectsWithCode("forbidden"));

      await poolQuery(`INSERT INTO town_claims (town_name, members) VALUES ($1, $2::jsonb)`, [
        townName,
        JSON.stringify([{ name: "Someone", rank: "resident" }]),
      ]);
      await assert.rejects(assertCanEditNation(player.id, "Someone"), rejectsWithCode("forbidden"));

      await poolQuery(`UPDATE town_claims SET members = $2::jsonb WHERE town_name = $1`, [
        townName,
        JSON.stringify([{ name: "CoMayor", rank: "comayor" }]),
      ]);
      const perm = await assertCanEditNation(player.id, "CoMayor");
      assert.deepEqual(perm, { townName, isMayor: false });
    } finally {
      await poolQuery(`DELETE FROM town_claims WHERE town_name = $1`, [townName]);
      await deletePlayers([player.id]);
    }
  });
});

describe("ensureAllHashimonDestinations / bundleForPlayer / questForHashimon (real DB)", () => {
  it("returns [] for a player with no creatures, and bundleForPlayer reflects a fresh player (degenerate)", async () => {
    const player = await seedPlayer();
    try {
      assert.deepEqual(await ensureAllHashimonDestinations(player.id), []);

      const bundle = await bundleForPlayer(player.id, null);
      assert.deepEqual(bundle.waypoints, []);
      assert.deepEqual(bundle.nationPois, []);
      assert.deepEqual(bundle.hashimonQuests, []);
      assert.equal(bundle.capital, null);
      assert.equal(bundle.canEditNation, false);
      assert.equal(bundle.townName, null);
      assert.equal(bundle.checkpoint, null);
    } finally {
      await deletePlayers([player.id]);
    }
  });

  it("skips an owned creature that doesn't currently want world care (general)", async () => {
    const player = await seedPlayer();
    await seedHashimon(player.id);
    try {
      assert.deepEqual(await ensureAllHashimonDestinations(player.id), []);
    } finally {
      await deletePlayers([player.id]);
    }
  });

  it("questForHashimon returns null for a hashimon the player doesn't own (error)", async () => {
    const player = await seedPlayer();
    try {
      assert.equal(
        await questForHashimon(player.id, "00000000-0000-0000-0000-000000000000", "Rex"),
        null
      );
    } finally {
      await deletePlayers([player.id]);
    }
  });
});

describe("markersForLuantiUsername / arriveForLuantiUsername (real DB)", () => {
  it("returns an empty bundle for an unknown Luanti username (degenerate)", async () => {
    const result = await markersForLuantiUsername(uniqueId("nobody"));
    assert.deepEqual(result, { playerId: null, markers: [], capital: null });
  });

  it("arriveForLuantiUsername rejects an unknown username (error)", async () => {
    await assert.rejects(
      arriveForLuantiUsername({ username: uniqueId("nobody"), markerId: "m1", x: 0, y: 0, z: 0 }),
      rejectsWithCode("not_found")
    );
  });
});

after(() => pool.end());
