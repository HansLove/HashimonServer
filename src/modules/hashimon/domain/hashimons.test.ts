// Emission ledger (hashimons.ts) + the species allowlist it gates on (data/species.ts).
// present()/isGenesisSpecies()/deriveBirthNonce() are pure — no DB needed. emit() and the
// inventory reads hit the real local Postgres, per project convention (never mocked).
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { pool, query } from "@/modules/core/db/pool";
import { config } from "@/modules/core/config";
import { Dna, CORE_VERSION, hashShareLegacy, leadingZeroBits } from "@/modules/core/core/index";
import { SPIRITS, ELEMENT_ASCII } from "@/modules/core/core/birth-identity";
import type { HashimonRow } from "@/modules/hashimon/domain/hashimons";
import {
  present,
  isGenesisSpecies,
  deriveBirthNonce,
  emit,
  listByOwner,
  getForOwner,
  countForOwner,
  countStarterEmissions,
} from "@/modules/hashimon/domain/hashimons";
import { Hashimons, GenesisV2, LEGACY_GENESIS, isGenesisV2, isAnyGenesis } from "@/modules/hashimon/data/species";
import { uniqueId } from "@/test/support/db";
import { seedPlayer, seedHashimon, deletePlayers } from "@/test/support/fixtures";

const playerIds: string[] = [];

after(async () => {
  await deletePlayers(playerIds);
  await pool.end();
});

async function seedOwner(): Promise<string> {
  const player = await seedPlayer();
  playerIds.push(player.id);
  return player.id;
}

// ---------------------------------------------------------------------------
// species.ts — the server-side allowlist emit() gates against
// ---------------------------------------------------------------------------

describe("species — the server-side allowlist", () => {
  it("rejects the empty key on both genesis predicates (degenerate)", () => {
    assert.equal(isGenesisV2(""), false);
    assert.equal(isAnyGenesis(""), false);
  });

  it("recognizes a Genesis V2 key it generated itself (simple)", () => {
    const key = Object.keys(GenesisV2)[0]!;
    assert.equal(isGenesisV2(key), true);
  });

  it("distinguishes legacy genesis, curated non-genesis and unknown keys (general)", () => {
    assert.equal(isAnyGenesis("genesis_agua"), true); // legacy V1, still recognized
    assert.equal(isAnyGenesis("voltKit"), false); // curated but never a genesis
    assert.equal(isAnyGenesis("no_such_species"), false); // not in the registry at all
  });

  it("builds exactly Spirits x Elements Genesis V2 cells (edge)", () => {
    const expected = SPIRITS.length * Object.keys(ELEMENT_ASCII).length;
    assert.equal(Object.keys(GenesisV2).length, expected);
  });

  it("a key absent from the registry is neither genesis nor emittable (error)", () => {
    assert.equal(isGenesisV2("no_such_species"), false);
    assert.equal(isAnyGenesis("no_such_species"), false);
    assert.equal(Hashimons["no_such_species"], undefined);
  });

  it("names a Genesis V2 cell by element prefix + spirit name", () => {
    // g2_hearth_fuego -> "Ember Hearth": Ember is fuego's ELEMENT_PREFIX, Hearth is the spirit's name.
    const cell = GenesisV2["g2_hearth_fuego"];
    assert.ok(cell);
    assert.equal(cell!.templateId, "template_g2_hearth_fuego");
    assert.equal(cell!.name, "Ember Hearth");
  });

  it("keeps every legacy genesis key in the allowlist so archived creatures still verify", () => {
    for (const key of LEGACY_GENESIS) {
      assert.ok(Hashimons[key], `expected ${key} to remain in the allowlist`);
    }
    assert.equal(Hashimons["s001"]!.templateId, "template_genesis_001");
    assert.equal(Hashimons["voltKit"]!.templateId, "template_electric_001");
  });

  it("the registry is exactly Genesis V2 plus the 18 legacy/curated entries", () => {
    assert.equal(Object.keys(Hashimons).length, Object.keys(GenesisV2).length + 18);
  });
});

// ---------------------------------------------------------------------------
// present() — pure derivation, no DB
// ---------------------------------------------------------------------------

function buildRow(overrides: Partial<HashimonRow> = {}): HashimonRow {
  return {
    id: uniqueId("row"),
    owner_id: uniqueId("owner"),
    dna: "a".repeat(64),
    species_key: "s001",
    template_id: "template_genesis_001",
    birth_nonce: "n",
    provenance: "wild",
    algo_version: CORE_VERSION,
    name: "",
    born_at: "2026-01-01T00:00:00Z",
    birth_spirit: null,
    life_number: null,
    archived_at: null,
    archive_reason: null,
    best_share_bits: 0,
    best_share_hash: null,
    best_share_nonce: null,
    best_share_extranonce2: null,
    best_share_bitcoin: null,
    extranonce2: 0,
    total_hashes: 0,
    valid_shares: 0,
    found_block: false,
    ...overrides,
  };
}

describe("present() — derived client-facing view", () => {
  it("a row with no recorded share is unmined, not tampered (degenerate)", () => {
    const view = present(buildRow());
    assert.equal(view.verified, null);
    assert.equal(view.bits, 0);
    assert.equal(view.stage, 1); // progressionOf floors an unmined creature to stage 1
  });

  it("a genuine legacy share verifies true (simple)", () => {
    const dna = "b".repeat(64);
    const nonce = 12345;
    const hash = hashShareLegacy(dna, nonce);
    const bits = leadingZeroBits(hash);
    const row = buildRow({
      dna,
      best_share_bits: bits,
      best_share_hash: hash,
      best_share_nonce: nonce,
    });
    const view = present(row);
    assert.equal(view.verified, true);
    assert.equal(view.bits, bits);
    assert.equal(view.pow.bestShareHash, hash);
  });

  it("carries identity, provenance and Birth Identity fields through untouched (general)", () => {
    const row = buildRow({
      owner_id: "owner-123",
      species_key: "g2_hearth_fuego",
      template_id: "template_g2_hearth_fuego",
      provenance: "starter",
      name: "Ember",
      birth_spirit: "hearth",
      life_number: 5,
      archived_at: "2026-02-01T00:00:00Z",
    });
    const view = present(row);
    assert.equal(view.ownerId, "owner-123");
    assert.equal(view.speciesKey, "g2_hearth_fuego");
    assert.equal(view.provenance, "starter");
    assert.equal(view.name, "Ember");
    assert.equal(view.birthSpirit, "hearth");
    assert.equal(view.lifeNumber, 5);
    assert.equal(view.archivedAt, "2026-02-01T00:00:00Z");
  });

  it("claiming more bits than the recomputed hash actually has is not verified (edge — underclaim)", () => {
    const dna = "c".repeat(64);
    const nonce = 999;
    const hash = hashShareLegacy(dna, nonce);
    const actualBits = leadingZeroBits(hash);
    const row = buildRow({
      dna,
      best_share_bits: actualBits + 100, // claim far more than the hash supports
      best_share_hash: hash,
      best_share_nonce: nonce,
    });
    assert.equal(present(row).verified, false);
  });

  it("a stored hash that does not recompute from the dna is rejected as forged (error)", () => {
    const row = buildRow({
      dna: "d".repeat(64),
      best_share_bits: 4,
      best_share_hash: "f".repeat(64), // does not match hashShareLegacy(dna, nonce)
      best_share_nonce: 1,
    });
    assert.equal(present(row).verified, false);
  });
});

// ---------------------------------------------------------------------------
// isGenesisSpecies() — thin wrapper over species::isAnyGenesis
// ---------------------------------------------------------------------------

describe("isGenesisSpecies()", () => {
  it("rejects the empty key (degenerate)", () => {
    assert.equal(isGenesisSpecies(""), false);
  });

  it("accepts a Genesis V2 key and rejects a curated non-genesis one (general)", () => {
    assert.equal(isGenesisSpecies("g2_hearth_fuego"), true);
    assert.equal(isGenesisSpecies("voltKit"), false);
  });
});

// ---------------------------------------------------------------------------
// deriveBirthNonce() — the birth-nonce source, both branches
// ---------------------------------------------------------------------------

describe("deriveBirthNonce()", () => {
  it("falls back to plain randomBytes when BIRTH_SECRET is empty (degenerate config)", () => {
    const original = config.birthSecret;
    // `config` is `as const` at the TYPE level only — the runtime object is a plain,
    // mutable literal (no Object.freeze), so a test can flip it and restore it.
    (config as unknown as { birthSecret: string }).birthSecret = "";
    try {
      const a = deriveBirthNonce("owner-1", "s001", 0);
      const b = deriveBirthNonce("owner-1", "s001", 0);
      assert.match(a, /^[0-9a-f]{16}$/);
      assert.notEqual(a, b); // randomBytes entropy, never repeats
    } finally {
      (config as unknown as { birthSecret: string }).birthSecret = original;
    }
  });

  it("switches to the auditable HMAC path once BIRTH_SECRET is configured (simple)", () => {
    const original = config.birthSecret;
    (config as unknown as { birthSecret: string }).birthSecret = "test-birth-secret";
    try {
      const a = deriveBirthNonce("owner-1", "s001", 0);
      const b = deriveBirthNonce("owner-1", "s001", 0);
      assert.match(a, /^[0-9a-f]{16}$/);
      assert.notEqual(a, b); // hrtime + random entropy still enter the preimage
    } finally {
      (config as unknown as { birthSecret: string }).birthSecret = original;
    }
  });

  it("stays well-formed for boundary retry values (edge: negative, zero, huge)", () => {
    for (const retry of [-1, 0, Number.MAX_SAFE_INTEGER]) {
      assert.match(deriveBirthNonce("owner-1", "s001", retry), /^[0-9a-f]{16}$/);
    }
  });
});

// ---------------------------------------------------------------------------
// emit() — against the local DB
// ---------------------------------------------------------------------------

describe("emit() — against the local DB", () => {
  it("rejects a species absent from the allowlist (error)", async () => {
    const ownerId = await seedOwner();
    await assert.rejects(
      emit({ ownerId, speciesKey: "no_such_species" }),
      { message: "unknown species: no_such_species" }
    );
  });

  it("births a wild creature with server-derived defaults (simple)", async () => {
    const ownerId = await seedOwner();
    const row = await emit({ ownerId, speciesKey: "s001" });
    assert.equal(row.owner_id, ownerId);
    assert.equal(row.species_key, "s001");
    assert.equal(row.template_id, "template_genesis_001");
    assert.equal(row.provenance, "wild");
    assert.equal(row.algo_version, CORE_VERSION);
    assert.equal(row.name, "");
    assert.equal(row.dna, Dna.derive(row.template_id, row.birth_nonce, "s001"));
  });

  it("honors provenance, trimmed name and Genesis birth fields (general)", async () => {
    const ownerId = await seedOwner();
    const row = await emit({
      ownerId,
      speciesKey: "voltKit",
      provenance: "starter",
      name: "  Sparky  ",
      birthSpirit: "hearth",
      lifeNumber: 5,
    });
    assert.equal(row.provenance, "starter");
    assert.equal(row.name, "Sparky");
    assert.equal(row.birth_spirit, "hearth");
    assert.equal(row.life_number, 5);
  });

  it("retries once on a dna collision (bounded, deterministic via the deriveNonce seam)", async () => {
    const ownerId = await seedOwner();
    const speciesKey = "s001";
    const templateId = Hashimons[speciesKey]!.templateId;
    const collidingNonce = uniqueId("collide");
    const freshNonce = uniqueId("fresh");
    const collidingDna = Dna.derive(templateId, collidingNonce, speciesKey);

    // Seed a row that already occupies the dna the first attempt will derive.
    await seedHashimon(ownerId, { dna: collidingDna, speciesKey, templateId, birthNonce: collidingNonce });

    const calls: number[] = [];
    const deriveNonce = (_ownerId: string, _speciesKey: string, retry: number): string => {
      calls.push(retry);
      return retry === 0 ? collidingNonce : freshNonce;
    };

    const row = await emit({ ownerId, speciesKey }, deriveNonce);

    assert.deepEqual(calls, [0, 1]); // exactly one retry, not five
    assert.equal(row.birth_nonce, freshNonce);
    assert.equal(row.dna, Dna.derive(templateId, freshNonce, speciesKey));
  });

  it("gives up after 5 unresolved collisions (edge — retry budget exhausted)", async () => {
    const ownerId = await seedOwner();
    const speciesKey = "s001";
    const templateId = Hashimons[speciesKey]!.templateId;
    const stuckNonce = uniqueId("stuck");
    const stuckDna = Dna.derive(templateId, stuckNonce, speciesKey);

    await seedHashimon(ownerId, { dna: stuckDna, speciesKey, templateId, birthNonce: stuckNonce });

    let callCount = 0;
    const deriveNonce = (): string => {
      callCount += 1;
      return stuckNonce; // every attempt derives the same already-taken dna
    };

    await assert.rejects(
      emit({ ownerId, speciesKey }, deriveNonce),
      { message: "emission failed: could not derive a unique DNA after several attempts" }
    );
    assert.equal(callCount, 5);
  });
});

// ---------------------------------------------------------------------------
// Inventory reads — against the local DB
// ---------------------------------------------------------------------------

describe("inventory reads — against the local DB", () => {
  it("a fresh owner has no creatures and no starter emissions (degenerate)", async () => {
    const ownerId = await seedOwner();
    assert.deepEqual(await listByOwner(ownerId), []);
    assert.equal(await countForOwner(ownerId), 0);
    assert.equal(await countStarterEmissions(ownerId), 0);
  });

  it("listByOwner/getForOwner/countForOwner see what emit() just created (simple)", async () => {
    const ownerId = await seedOwner();
    const row = await emit({ ownerId, speciesKey: "s001" });

    const listed = await listByOwner(ownerId);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.id, row.id);

    assert.deepEqual(await getForOwner(row.id, ownerId), row);
    assert.equal(await countForOwner(ownerId), 1);
  });

  it("getForOwner scopes strictly by owner (general — cross-owner lookup fails closed)", async () => {
    const ownerId = await seedOwner();
    const otherOwnerId = await seedOwner();
    const row = await emit({ ownerId, speciesKey: "s001" });

    assert.equal(await getForOwner(row.id, otherOwnerId), null);
  });

  it("listByOwner orders multiple creatures ascending by born_at (general)", async () => {
    const ownerId = await seedOwner();
    const first = await emit({ ownerId, speciesKey: "s001" });
    const second = await emit({ ownerId, speciesKey: "voltKit" });

    const listed = await listByOwner(ownerId);
    assert.deepEqual(listed.map((h) => h.id), [first.id, second.id]);
  });

  it("countStarterEmissions counts only unarchived starter provenance (edge)", async () => {
    const ownerId = await seedOwner();
    await emit({ ownerId, speciesKey: "s001" }); // wild — does not count
    const starter = await emit({ ownerId, speciesKey: "voltKit", provenance: "starter" });
    assert.equal(await countStarterEmissions(ownerId), 1);

    // Archiving is not exposed by this module (it belongs to the not-yet-built
    // rebirth flow) — flip the column directly to verify the filter still excludes it.
    await query(`UPDATE hashimons SET archived_at = now() WHERE id = $1`, [starter.id]);
    assert.equal(await countStarterEmissions(ownerId), 0);
  });

  it("getForOwner returns null for a well-formed id that was never emitted (error)", async () => {
    const ownerId = await seedOwner();
    assert.equal(await getForOwner("00000000-0000-0000-0000-000000000000", ownerId), null);
  });
});
