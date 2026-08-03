import { randomBytes } from "node:crypto";
import { query, withTransaction } from "../db/pool";
import { audit } from "./audit";
import { Dna, progressionOf, verifyStoredPow, type PowRecord, CORE_VERSION } from "../core";
import { Hashimons } from "../data/species";

//The stored row. Note what is NOT here: no stats, no colours, no type. Those are
//derived from dna + pow by the Caos Core (see present()), so they can never be
//stored wrong or forged. The row is pure provenance + the pow biography.
export interface HashimonRow {
  id: string;
  owner_id: string;
  dna: string;
  species_key: string;
  template_id: string;
  birth_nonce: string;
  provenance: string;
  algo_version: string;
  name: string;
  born_at: string;
  best_share_bits: number;
  best_share_hash: string | null;
  best_share_nonce: number | null;
  best_share_extranonce2: number | null;
  extranonce2: number;
  total_hashes: number;
  valid_shares: number;
  found_block: boolean;
}

function powOf(row: HashimonRow): PowRecord {
  return {
    bestShareBits: row.best_share_bits,
    bestShareHash: row.best_share_hash,
    bestShareNonce: row.best_share_nonce,
    bestShareExtranonce2: row.best_share_extranonce2,
    totalHashes: row.total_hashes,
    extranonce2: row.extranonce2,
    validShares: row.valid_shares,
    foundBlock: row.found_block,
  };
}

//The API view of a creature: identity + provenance + DERIVED progression, plus a
//self-verifying proof block so any client can confirm the effort is real.
export function present(row: HashimonRow) {
  const pow = powOf(row);
  const progression = progressionOf(pow);
  const verdict = verifyStoredPow(row.dna, pow);
  return {
    id: row.id,
    ownerId: row.owner_id,
    dna: row.dna,
    speciesKey: row.species_key,
    templateId: row.template_id,
    birthNonce: row.birth_nonce,
    name: row.name,
    provenance: row.provenance,
    algoVersion: row.algo_version,
    bornAt: row.born_at,
    ...progression, //tier, stars, stage, progress, nextThreshold, bits
    pow: {
      bestShareBits: pow.bestShareBits,
      bestShareHash: pow.bestShareHash,
      bestShareNonce: pow.bestShareNonce,
      bestShareExtranonce2: pow.bestShareExtranonce2 ?? null,
      extranonce2: pow.extranonce2,
      totalHashes: pow.totalHashes,
      validShares: pow.validShares,
      foundBlock: pow.foundBlock,
    },
    //A creature born but not yet mined is "unmined", not tampered — surface that.
    verified: verdict.status === "ok" ? true : verdict.status === "unmined" ? null : false,
  };
}

export type Provenance = "wild" | "starter";

export function isGenesisSpecies(speciesKey: string): boolean {
  return speciesKey.startsWith("genesis_");
}

export async function countStarterEmissions(ownerId: string): Promise<number> {
  const res = await query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM hashimons WHERE owner_id = $1 AND provenance = 'starter'`,
    [ownerId]
  );
  return res.rows[0]?.count ?? 0;
}

//Emit (officially give birth to) a new creature. THE SERVER OWNS THE BIRTH: it
//generates the birth nonce, so the client cannot grind for a rare identity, and
//derives the DNA itself. dna is UNIQUE in the table; on the (astronomically
//unlikely) collision we simply try another nonce. The row and its audit entry
//commit together.
//
//What the client sends the server (a species it encountered) is a REQUEST; what
//identity that becomes is the server's to decide. Wild-encounter seeding from a
//server-owned world seed (so even *which* species you meet isn't client-chosen)
//is the Phase 3 Caos Engine hook — this is the emission gate it plugs into.
export async function emit(input: {
  ownerId: string;
  speciesKey: string;
  templateId?: string;
  provenance?: Provenance;
  name?: string;
}): Promise<HashimonRow> {
  const species = Hashimons[input.speciesKey];
  if (!species) {
    throw new Error(`unknown species: ${input.speciesKey}`);
  }
  const templateId = input.templateId ?? species.templateId;
  const provenance = input.provenance ?? "wild";

  for (let attempt = 0; attempt < 5; attempt++) {
    const birthNonce = randomBytes(8).toString("hex");
    const dna = Dna.derive(templateId, birthNonce, input.speciesKey);

    try {
      return await withTransaction(async (client) => {
        const res = await query<HashimonRow>(
          `INSERT INTO hashimons (owner_id, dna, species_key, template_id, birth_nonce, provenance, algo_version, name)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING *`,
          [input.ownerId, dna, input.speciesKey, templateId, birthNonce, provenance, CORE_VERSION, input.name?.trim() || ""],
          client
        );
        const row = res.rows[0]!;
        await audit(client, {
          playerId: input.ownerId,
          hashimonId: row.id,
          action: "emission",
          detail: { speciesKey: input.speciesKey, provenance, dna },
        });
        return row;
      });
    } catch (err: unknown) {
      // 23505 = unique_violation on dna. Extremely unlikely; retry a new nonce.
      if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505") {
        continue;
      }
      throw err;
    }
  }
  throw new Error("emission failed: could not derive a unique DNA after several attempts");
}

export async function listByOwner(ownerId: string): Promise<HashimonRow[]> {
  const res = await query<HashimonRow>(
    `SELECT * FROM hashimons WHERE owner_id = $1 ORDER BY born_at ASC`,
    [ownerId]
  );
  return res.rows;
}

export async function getForOwner(id: string, ownerId: string): Promise<HashimonRow | null> {
  const res = await query<HashimonRow>(
    `SELECT * FROM hashimons WHERE id = $1 AND owner_id = $2`,
    [id, ownerId]
  );
  return res.rows[0] ?? null;
}

export async function countForOwner(ownerId: string): Promise<number> {
  const res = await query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM hashimons WHERE owner_id = $1`,
    [ownerId]
  );
  return res.rows[0]?.count ?? 0;
}
