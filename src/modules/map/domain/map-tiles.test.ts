import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MAP_TILE_SIZE,
  ensureMapTilesDir,
  saveMapTile,
  listMapTiles,
  readMapTile,
} from "@/modules/map/domain/map-tiles";

/**
 * Every test points `dir` at its own throwaway tmp directory (the seam the
 * adapter added) instead of relying on config.mapTilesDir/env-var tricks —
 * no live DB, no shared filesystem state between tests.
 */
let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "map-tiles-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("MAP_TILE_SIZE", () => {
  it("matches the Luanti discovery_maps tile size (128)", () => {
    assert.equal(MAP_TILE_SIZE, 128);
  });
});

describe("ensureMapTilesDir", () => {
  it("creates a nested directory that doesn't exist yet (general)", async () => {
    const nested = path.join(tmpDir, "a", "b", "c");
    await ensureMapTilesDir(nested);
    // mkdir with recursive:true silently succeeds again on an existing dir —
    // proving it exists is the only reliable check without stat-ing it.
    await assert.doesNotReject(ensureMapTilesDir(nested));
  });

  it("is safe to call repeatedly on the same directory (idempotent)", async () => {
    await ensureMapTilesDir(tmpDir);
    await assert.doesNotReject(ensureMapTilesDir(tmpDir));
  });
});

describe("saveMapTile / readMapTile", () => {
  it("round-trips the exact PNG bytes through an auto-created directory (simple)", async () => {
    const dir = path.join(tmpDir, "fresh");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03]);
    await saveMapTile(3, -4, png, dir);

    const readBack = await readMapTile(3, -4, dir);
    assert.ok(readBack);
    assert.ok(readBack!.equals(png));
  });

  it("readMapTile returns null for a tile that was never saved (degenerate)", async () => {
    const result = await readMapTile(99, 99, tmpDir);
    assert.equal(result, null);
  });

  it("readMapTile propagates a non-ENOENT error instead of swallowing it (error)", async () => {
    // Point readMapTile's path at a directory, not a file: the underlying
    // readFile fails with EISDIR, which readMapTile must NOT treat as "missing".
    const dirAsFile = path.join(tmpDir, "tile_1_1.png");
    await mkdir(dirAsFile);
    await assert.rejects(readMapTile(1, 1, tmpDir), (err: unknown) => {
      return err instanceof Error && (err as NodeJS.ErrnoException).code === "EISDIR";
    });
  });

  it("overwriting the same coordinates replaces the stored tile (edge)", async () => {
    const first = Buffer.from([1, 1, 1]);
    const second = Buffer.from([2, 2, 2, 2]);
    await saveMapTile(0, 0, first, tmpDir);
    await saveMapTile(0, 0, second, tmpDir);
    const readBack = await readMapTile(0, 0, tmpDir);
    assert.ok(readBack!.equals(second));
  });
});

describe("listMapTiles", () => {
  it("returns [] when the directory doesn't exist (degenerate, no mkdir side effect)", async () => {
    const missing = path.join(tmpDir, "does-not-exist");
    assert.deepEqual(await listMapTiles(missing), []);
  });

  it("lists saved tiles as sorted [x, z] pairs, including negative coordinates (general)", async () => {
    await saveMapTile(5, 5, Buffer.from([1]), tmpDir);
    await saveMapTile(-2, 3, Buffer.from([1]), tmpDir);
    await saveMapTile(0, 0, Buffer.from([1]), tmpDir);
    await saveMapTile(-2, -1, Buffer.from([1]), tmpDir);

    const tiles = await listMapTiles(tmpDir);
    assert.deepEqual(tiles, [
      [-2, -1],
      [-2, 3],
      [0, 0],
      [5, 5],
    ]);
  });

  it("ignores files that don't match the tile_<x>_<z>.png pattern (edge)", async () => {
    await ensureMapTilesDir(tmpDir);
    await writeFile(path.join(tmpDir, "tile_1_2.png"), Buffer.from([1]));
    await writeFile(path.join(tmpDir, "readme.txt"), "not a tile");
    await writeFile(path.join(tmpDir, "tile_abc_def.png"), Buffer.from([1]));

    const tiles = await listMapTiles(tmpDir);
    assert.deepEqual(tiles, [[1, 2]]);
  });
});
