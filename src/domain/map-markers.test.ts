import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  homeblockToWorld,
  pickWorldDestination,
  presentMarker,
  BLOCK_SIZE,
  type MapMarkerRow,
} from "@/domain/map-markers";

describe("homeblockToWorld", () => {
  it("matches website formula (block * size + size/2)", () => {
    assert.deepEqual(homeblockToWorld([0, 0, 0]), { x: 8, y: 8, z: 8 });
    assert.deepEqual(homeblockToWorld([1, -1, 2], BLOCK_SIZE), {
      x: 16 + 8,
      y: -16 + 8,
      z: 32 + 8,
    });
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
});
