import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "@/modules/core/config";

/** Discovery-maps tile size in nodes (and PNG pixels). Must match Luanti. */
export const MAP_TILE_SIZE = 128;

const TILE_RE = /^tile_(-?\d+)_(-?\d+)\.png$/;

function tileFilename(tileX: number, tileZ: number): string {
  return `tile_${tileX}_${tileZ}.png`;
}

function tilePath(tileX: number, tileZ: number, dir: string): string {
  return path.join(dir, tileFilename(tileX, tileZ));
}

/** Ensure the on-disk tile store exists. Safe to call repeatedly.
 *  `dir` defaults to config.mapTilesDir; tests can point it at a tmp dir. */
export async function ensureMapTilesDir(dir: string = config.mapTilesDir): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/** Persist a discovery_maps PNG (raw bytes) for public serving. */
export async function saveMapTile(
  tileX: number,
  tileZ: number,
  png: Buffer,
  dir: string = config.mapTilesDir
): Promise<void> {
  await ensureMapTilesDir(dir);
  await writeFile(tilePath(tileX, tileZ, dir), png);
}

/** List every stored tile as [tileX, tileZ] pairs, sorted for stable responses.
 *  Missing dir → empty list (don't mkdir here: the container may be read-only until
 *  a volume is mounted; uploads create the dir via saveMapTile). */
export async function listMapTiles(dir: string = config.mapTilesDir): Promise<[number, number][]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EACCES") return [];
    throw err;
  }
  const out: [number, number][] = [];
  for (const name of names) {
    const m = TILE_RE.exec(name);
    if (!m) continue;
    out.push([Number(m[1]), Number(m[2])]);
  }
  out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return out;
}

/** Read one PNG, or null if missing. */
export async function readMapTile(
  tileX: number,
  tileZ: number,
  dir: string = config.mapTilesDir
): Promise<Buffer | null> {
  try {
    return await readFile(tilePath(tileX, tileZ, dir));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw err;
  }
}
