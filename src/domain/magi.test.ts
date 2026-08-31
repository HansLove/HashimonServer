import assert from "node:assert/strict";
import { test } from "node:test";

//The seal secret has to exist before @/config is read by the module under test.
process.env.MAGI_SEAL_SECRET ??= "test-seal-secret";
process.env.MAGI_SATS_PER_MAGI ??= "1000";

const { sealOf, verifySeal, tokenFor } = await import("@/domain/magi");

const SERIAL = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

function token(overrides: Partial<Record<string, unknown>> = {}) {
  const base = {
    serial: SERIAL,
    sats: 1000,
    epoch: 1,
    nonce: "a".repeat(32),
  };
  const merged = { ...base, ...overrides } as { serial: string; sats: number; epoch: number; nonce: string };
  return {
    ...merged,
    seal: (overrides.seal as string) ?? sealOf(merged.serial, merged.sats, merged.epoch, merged.nonce),
  };
}

test("a freshly sealed note verifies", () => {
  assert.equal(verifySeal(token()), true);
});

test("editing the denomination breaks the seal", () => {
  const note = token();
  assert.equal(verifySeal({ ...note, sats: 1_000_000 }), false);
});

test("moving a seal onto another serial breaks it", () => {
  const note = token();
  assert.equal(verifySeal({ ...note, serial: "00000000-0000-0000-0000-000000000000" }), false);
});

test("a note from another epoch does not verify against this one", () => {
  const note = token({ epoch: 2 });
  assert.equal(verifySeal({ ...note, epoch: 1 }), false);
});

//The duplication guarantee in miniature: a clone is byte-identical and therefore
//equally well sealed. Only the nonce — retired in the ledger the moment either copy
//is checked — tells the two apart, which is why custody rotation exists.
test("a clone carries a valid seal; only the rotated nonce distinguishes it", () => {
  const original = token();
  const clone = { ...original };
  assert.equal(verifySeal(clone), true);

  const rotated = token({ nonce: "b".repeat(32) });
  assert.equal(verifySeal(rotated), true);
  assert.notEqual(rotated.seal, original.seal);
  //The clone still verifies as *issued*, but its nonce is no longer the ledger's.
  assert.notEqual(clone.nonce, rotated.nonce);
});

test("a fabricated seal is rejected", () => {
  assert.equal(verifySeal(token({ seal: "f".repeat(64) })), false);
  assert.equal(verifySeal(token({ seal: "" })), false);
});

test("tokenFor seals exactly the row it is given", () => {
  const row = {
    serial: SERIAL,
    sats: 1000,
    epoch: 1,
    state: "materialized" as const,
    custody_nonce: "c".repeat(32),
    custody_seq: 3,
    holder: "aaron",
    issued_at: "2026-08-28T00:00:00Z",
    moved_at: "2026-08-28T00:00:00Z",
  };
  const t = tokenFor(row);
  assert.equal(t.nonce, row.custody_nonce);
  assert.equal(verifySeal(t), true);
});
