import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  homeblockToWorld,
  pickWorldDestination,
  BLOCK_SIZE,
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
