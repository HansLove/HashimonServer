import assert from "node:assert/strict";
import { test } from "node:test";
import {
  elementOfSpeciesKey, spiritOfSpeciesKeyOrNull,
} from "@/modules/companion/domain/chat-helpers";

// ---------------------------------------------------------------------------
// spiritOfSpeciesKeyOrNull
// ---------------------------------------------------------------------------

test("spiritOfSpeciesKeyOrNull: null/undefined/empty have no spirit (V1 creatures)", () => {
  assert.equal(spiritOfSpeciesKeyOrNull(null), null);
  assert.equal(spiritOfSpeciesKeyOrNull(undefined), null);
  assert.equal(spiritOfSpeciesKeyOrNull(""), null);
});

test("spiritOfSpeciesKeyOrNull: a Genesis V2 key extracts a registered spirit", () => {
  assert.equal(spiritOfSpeciesKeyOrNull("g2_guardian_fuego"), "guardian");
  assert.equal(spiritOfSpeciesKeyOrNull("g2_bloom_electrico"), "bloom");
});

test("spiritOfSpeciesKeyOrNull: a non-V2 key never matches", () => {
  assert.equal(spiritOfSpeciesKeyOrNull("fuego_guardian"), null);
  assert.equal(spiritOfSpeciesKeyOrNull("v1_guardian_fuego"), null);
});

test("spiritOfSpeciesKeyOrNull: a signo-shaped prefix that names no registered spirit is null", () => {
  //Un signo pegado sin espacio a un elemento inventado no debe fingir ser válido.
  assert.equal(spiritOfSpeciesKeyOrNull("g2_dragonsignoquenoexiste_fuego"), null);
});

// ---------------------------------------------------------------------------
// elementOfSpeciesKey
// ---------------------------------------------------------------------------

test("elementOfSpeciesKey: null/undefined/empty have no element", () => {
  assert.equal(elementOfSpeciesKey(null), null);
  assert.equal(elementOfSpeciesKey(undefined), null);
  assert.equal(elementOfSpeciesKey(""), null);
});

test("elementOfSpeciesKey: reads the element straight from the key", () => {
  assert.equal(elementOfSpeciesKey("g2_guardian_fuego"), "fuego");
  assert.equal(elementOfSpeciesKey("g2_hearth_agua"), "agua");
});

test("elementOfSpeciesKey: electrico gets its internal accented spelling", () => {
  assert.equal(elementOfSpeciesKey("g2_bloom_electrico"), "eléctrico");
});

test("elementOfSpeciesKey: a key without the trailing element segment does not match", () => {
  assert.equal(elementOfSpeciesKey("g2_guardian_"), null);
  assert.equal(elementOfSpeciesKey("not_a_species_key"), null);
});
