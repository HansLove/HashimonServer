import { sha256 } from "@/modules/core/core/sha256";
import type { YieldTier } from "@/modules/core/core/pow";

/**
 * Server-side mirror of the world's deterministic YIELD GEOGRAPHY (Vibing V1,
 * docs/VIBING_V1.md §2) — byte-identical to `ihashima-website/src/lib/yield-map.ts`.
 *
 * Every region of the map yields one tier of energy-food/material, decided purely by its
 * coordinates: `zona(x,z) = f(SHA256(region, epoch))`. The web draws the map from this; the
 * server is the AUTHORITY on what a coordinate yields, so a Vibing tower's tier can never be
 * a client claim. Same discipline as `sha256.ts`/`dna.ts`: only the hex output must match,
 * and it does (`sha256(s)` here === `bytesToHex(sha256(enc.encode(s)))` on the web).
 *
 * Keep the constants (REGION, YIELD_EPOCH, T_CAPITAL, T_DURABLE, the window slices) in
 * lockstep with the web file — a divergence would make the map lie about the harvest.
 */

/** A region is REGION×REGION mapblocks (REGION*16 nodes on a side). Tunable. */
export const REGION = 4;
/** Bump to reshuffle the whole geography (later: driven by the Magi epoch/halving). */
export const YIELD_EPOCH = 1;
/** Towny mapblock edge in nodes (towny.settings.town_block_size) — world coord → mapblock. */
export const BLOCK_SIZE = 16;

// Nested leading-zero-bit thresholds over the tier window, tuned for SPATIAL visibility
// (rich zones rare but present): ~75% consumable, ~19% durable, ~6% capital.
const T_CAPITAL = 4;
const T_DURABLE = 2;

/** Leading zero BITS of a hex string — mirrors the web's `leadingZeroBitsHex`. */
function leadingZeroBitsHex(hex: string): number {
  let bits = 0;
  for (const ch of hex) {
    const v = parseInt(ch, 16);
    if (v === 0) {
      bits += 4;
      continue;
    }
    bits += Math.clz32(v) - 28; // v in 1..15 → leading zeros inside the nibble
    break;
  }
  return bits;
}

export interface Zone {
  tier: YieldTier;
  y: number; // leading-zero bits of the tier window (for debugging/calibration)
  material: number; // index into the tier's material list (surfaced later)
}

/** The yield of a REGION (region coordinates, not mapblock). Pure + deterministic. */
export function zoneAtRegion(regionX: number, regionZ: number, epoch = YIELD_EPOCH): Zone {
  const h = sha256(`vibe:${regionX}:${regionZ}:${epoch}`);
  const y = leadingZeroBitsHex(h.slice(16, 32)); // tier window (bits 64..127)
  const tier: YieldTier = y >= T_CAPITAL ? "capital" : y >= T_DURABLE ? "durable" : "consumable";
  const material = parseInt(h.slice(32, 40), 16) >>> 0; // material window
  return { tier, y, material };
}

/** The yield at a MAPBLOCK coordinate (what the cadastral map is drawn in). */
export function zoneAtMapblock(mbx: number, mbz: number, epoch = YIELD_EPOCH): Zone {
  return zoneAtRegion(Math.floor(mbx / REGION), Math.floor(mbz / REGION), epoch);
}

/** The yield at a WORLD-NODE coordinate (what a Vibing tower is planted at). */
export function zoneAtWorld(x: number, z: number, epoch = YIELD_EPOCH): Zone {
  return zoneAtMapblock(Math.floor(x / BLOCK_SIZE), Math.floor(z / BLOCK_SIZE), epoch);
}
