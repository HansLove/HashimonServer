#!/usr/bin/env node
/**
 * One-shot backfill: upload discovery_maps PNGs from a world persistent_maps/
 * directory to the Hashimon API (same endpoint Luanti uses after generate_tile).
 *
 * Usage:
 *   LUANTI_SERVER_SECRET=... node scripts/backfill-map-tiles.mjs /path/to/world/persistent_maps
 *   API_URL=http://127.0.0.1:4000 LUANTI_SERVER_SECRET=... node scripts/backfill-map-tiles.mjs ./persistent_maps
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const dir = process.argv[2];
const apiUrl = (process.env.API_URL ?? "http://127.0.0.1:4000").replace(/\/$/, "");
const secret = process.env.LUANTI_SERVER_SECRET ?? "";

if (!dir) {
  console.error("Usage: node scripts/backfill-map-tiles.mjs <persistent_maps_dir>");
  process.exit(1);
}
if (!secret) {
  console.error("LUANTI_SERVER_SECRET is required");
  process.exit(1);
}

const TILE_RE = /^tile_(-?\d+)_(-?\d+)\.png$/;
const names = (await readdir(dir)).filter((n) => TILE_RE.test(n));
console.log(`Uploading ${names.length} tiles from ${dir} → ${apiUrl}`);

let ok = 0;
let fail = 0;
for (const name of names) {
  const m = TILE_RE.exec(name);
  const tileX = Number(m[1]);
  const tileZ = Number(m[2]);
  const png = (await readFile(path.join(dir, name))).toString("base64");
  const res = await fetch(`${apiUrl}/internal/luanti-map-tiles`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Luanti-Secret": secret,
    },
    body: JSON.stringify({ tileX, tileZ, png }),
  });
  if (res.ok) {
    ok += 1;
    console.log(`ok ${name}`);
  } else {
    fail += 1;
    console.error(`fail ${name}: ${res.status} ${await res.text()}`);
  }
}
console.log(`Done: ${ok} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
