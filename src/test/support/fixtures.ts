/**
 * Test Data Builders for the two entities almost every DB-backed suite in the
 * repo needs as a starting point: a player row and, off it, a hashimon row
 * (wolkers.test.ts, armies.test.ts, food.test.ts, incubation.test.ts,
 * payments.test.ts, affiliates.test.ts already hand-roll this near-verbatim).
 * These hit the real Postgres — per project convention, the database itself
 * is never mocked — and return the row so a test's own `after()` can delete
 * what it created.
 */
import { randomBytes } from "node:crypto";
import { query, pool, type Sql } from "@/modules/core/db/pool";
import { CORE_VERSION } from "@/modules/core/core/index";
import { uniqueId } from "@/test/support/db";

export type SeededPlayer = { id: string; displayName: string };
export type SeedPlayerOverrides = Partial<{ displayName: string; credits: number }>;

export async function seedPlayer(overrides: SeedPlayerOverrides = {}, client: Sql = pool): Promise<SeededPlayer> {
  const displayName = overrides.displayName ?? uniqueId("Player");
  const result = await query<{ id: string }>(
    `INSERT INTO players (display_name, credits) VALUES ($1, $2) RETURNING id`,
    [displayName, overrides.credits ?? 0],
    client
  );
  return { id: result.rows[0]!.id, displayName };
}

/**
 * 64 lowercase hex chars via real randomness — `hashimons.dna` is `text NOT
 * NULL UNIQUE`, and other implementers run DB tests concurrently against the
 * same database, so a derived/padded string is not safe here.
 */
export function randomDna(): string {
  return randomBytes(32).toString("hex");
}

export type SeededHashimon = { id: string; dna: string; speciesKey: string };
export type SeedHashimonOverrides = Partial<{
  dna: string;
  speciesKey: string;
  templateId: string;
  birthNonce: string;
  algoVersion: string;
}>;

/** `fuego_guardian` is a real, registered species key (hashimon/data/species.ts) — the
 * same default every existing DB-backed suite already uses. */
export async function seedHashimon(
  ownerId: string,
  overrides: SeedHashimonOverrides = {},
  client: Sql = pool
): Promise<SeededHashimon> {
  const dna = overrides.dna ?? randomDna();
  const speciesKey = overrides.speciesKey ?? "fuego_guardian";
  const result = await query<{ id: string }>(
    `INSERT INTO hashimons (owner_id, dna, species_key, template_id, birth_nonce, algo_version)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      ownerId,
      dna,
      speciesKey,
      overrides.templateId ?? "t",
      overrides.birthNonce ?? "n",
      overrides.algoVersion ?? CORE_VERSION,
    ],
    client
  );
  return { id: result.rows[0]!.id, dna, speciesKey };
}

/**
 * `hashimons.owner_id` is `ON DELETE CASCADE`, so deleting the seeded players
 * alone also clears every hashimon a test created off them. Town/claim rows
 * are module-specific and stay each test's own `after()` responsibility.
 */
export async function deletePlayers(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await query(`DELETE FROM players WHERE id = ANY($1)`, [ids]);
}
