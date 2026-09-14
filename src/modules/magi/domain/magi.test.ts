import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { fakeSql, uniqueId } from "@/test/support/db";
import type { MagiNoteRow } from "@/modules/magi/domain/magi";

//The seal secret has to exist before @/config is read by the module under test.
process.env.MAGI_SEAL_SECRET ??= "test-seal-secret";
process.env.MAGI_SATS_PER_MAGI ??= "1000";
//Small on purpose: the cap-exhaustion test fills it and every DB-backed test
//below cleans up its own rows, so a tiny cap stays meaningful test-to-test
//instead of requiring thousands of inserts to ever reach it.
process.env.MAGI_SUPPLY_CAP ??= "4";

const {
  sealOf,
  verifySeal,
  tokenFor,
  isForgedToken,
  decideCustodyVerdict,
  supply,
  holderState,
  issue,
  withdraw,
  deposit,
  check,
  MagiSupplyExhausted,
} = await import("@/modules/magi/domain/magi");
const { pool, query } = await import("@/modules/core/db/pool");

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

/* ---- isForgedToken (pure) ------------------------------------------------ */
//Pure predicate: no I/O, cannot throw for any input, so there is no Error
//category to cover here.

test("isForgedToken: degenerate — an empty serial is forged", () => {
  assert.equal(isForgedToken(token({ serial: "" })), true);
});

test("isForgedToken: simple — a well-formed serial with a valid seal is not forged", () => {
  assert.equal(isForgedToken(token()), false);
});

test("isForgedToken: general — a well-formed serial with a tampered seal is forged", () => {
  assert.equal(isForgedToken(token({ seal: "f".repeat(64) })), true);
});

test("isForgedToken: edge — UUID_RE only checks shape (hex/dash, 36 chars), not real UUID layout; the seal is what actually decides", () => {
  const looseSerial = "a".repeat(36); //36 hex chars, no dashes at all — still passes the length+charset check
  assert.equal(isForgedToken(token({ serial: looseSerial })), false);
});

/* ---- decideCustodyVerdict (pure) ----------------------------------------- */
//Pure function: no I/O, cannot throw for any input, so there is no Error
//category to cover here.

function noteRow(overrides: Partial<MagiNoteRow> = {}): MagiNoteRow {
  return {
    serial: SERIAL,
    sats: 1000,
    epoch: 1,
    state: "vaulted",
    custody_nonce: "a".repeat(32),
    custody_seq: 0,
    holder: "aaron",
    issued_at: "2026-01-01T00:00:00Z",
    moved_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

test("decideCustodyVerdict: degenerate — no row in the ledger is unknown", () => {
  const decision = decideCustodyVerdict(undefined, token());
  assert.equal(decision.verdict, "unknown");
  assert.equal(decision.result.reason, "no such note in the ledger");
});

test("decideCustodyVerdict: simple — a retired note is rejected regardless of a matching nonce", () => {
  const row = noteRow({ state: "retired" });
  const decision = decideCustodyVerdict(row, token({ nonce: row.custody_nonce }));
  assert.equal(decision.verdict, "retired");
});

test("decideCustodyVerdict: general — a mismatched nonce is stale and detail carries the ledger's own values, not the presented token's", () => {
  const row = noteRow({ custody_nonce: "b".repeat(32), custody_seq: 5, holder: "someone-else" });
  const presented = token({ nonce: "a".repeat(32) });
  const decision = decideCustodyVerdict(row, presented);
  assert.equal(decision.verdict, "stale");
  assert.deepEqual(decision.detail, { presented_nonce: "a".repeat(32), ledger_seq: 5, ledger_holder: "someone-else" });
});

test("decideCustodyVerdict: edge — a live note with a matching nonce proceeds to rotation and carries no result", () => {
  const row = noteRow({ custody_nonce: "a".repeat(32) });
  const decision = decideCustodyVerdict(row, token({ nonce: "a".repeat(32) }));
  assert.equal(decision.verdict, "proceed");
  assert.equal(decision.result, undefined);
});

/* ---- supply (pure logic, fake Sql) ---------------------------------------- */

test("supply: degenerate — an empty ledger reports zero across the board", async () => {
  const client = fakeSql(() => []);
  const result = await supply(client);
  assert.equal(result.issued, 0);
  assert.equal(result.vaulted, 0);
  assert.equal(result.reserveSats, 0);
});

test("supply: general — aggregates per-state counts and derives issued/reserve from them", async () => {
  const client = fakeSql((text) =>
    text.includes("GROUP BY state")
      ? [
          { state: "vaulted", n: "2" },
          { state: "materialized", n: "1" },
          { state: "retired", n: "1" },
        ]
      : []
  );
  const result = await supply(client);
  assert.equal(result.vaulted, 2);
  assert.equal(result.materialized, 1);
  assert.equal(result.retired, 1);
  assert.equal(result.issued, 4);
  assert.equal(result.reserveSats, 4 * result.satsPerMagi);
});

/* ---- holderState (pure logic, fake Sql) ------------------------------------ */

test("holderState: degenerate — a holder with no notes gets zero counts and an empty list", async () => {
  const client = fakeSql(() => []);
  const result = await holderState("nobody", client);
  assert.deepEqual(result, { holder: "nobody", vaulted: 0, materialized: 0, notes: [] });
});

test("holderState: general — splits vaulted vs materialized and maps every note's fields", async () => {
  const rows = [
    { serial: "s1", sats: 1000, epoch: 1, state: "vaulted", custody_nonce: "n1", custody_seq: 0, holder: "aaron", issued_at: "t", moved_at: "m1" },
    { serial: "s2", sats: 1000, epoch: 1, state: "materialized", custody_nonce: "n2", custody_seq: 2, holder: "aaron", issued_at: "t", moved_at: "m2" },
  ];
  const client = fakeSql(() => rows);
  const result = await holderState("aaron", client);
  assert.equal(result.vaulted, 1);
  assert.equal(result.materialized, 1);
  assert.deepEqual(result.notes[1], { serial: "s2", state: "materialized", sats: 1000, custodySeq: 2, movedAt: "m2" });
});

/* ---- issuance, custody and the vault<->world round trip (real Postgres) --- */
//DB-backed: exercises issue/withdraw/deposit/check/custodyOne/runCustody/log
//together, the paths the fake-Sql tests above cannot reach because they run
//inside withTransaction against the real pool with no injection point. Every
//test mints under its own unique holder and deletes its own rows so the tiny
//test-only MAGI_SUPPLY_CAP stays meaningful from test to test.

test("issue mints notes up to the supply cap and refuses once it is reached", async () => {
  const holder = uniqueId("magi-cap");
  const { rows: before } = await query<{ n: string }>("SELECT count(*)::text AS n FROM magi_notes", []);
  const cap = Number(process.env.MAGI_SUPPLY_CAP);
  const room = cap - Number(before[0]!.n);
  assert.ok(room >= 1, "test requires at least one free slot under the configured cap");
  try {
    const filled = await issue(holder, room);
    assert.equal(filled.issued, room);
    assert.equal(filled.supply.issued, cap);

    await assert.rejects(() => issue(holder, 1), MagiSupplyExhausted);
  } finally {
    await query("DELETE FROM magi_notes WHERE holder = $1", [holder]);
  }
});

test("issue then withdraw hands out a verifiable, materialized token", async () => {
  const holder = uniqueId("magi-holder");
  try {
    await issue(holder, 1);
    const tokens = await withdraw(holder, 1);
    assert.equal(tokens.length, 1);
    assert.equal(verifySeal(tokens[0]!), true);

    const state = await holderState(holder);
    assert.equal(state.materialized, 1);
    assert.equal(state.vaulted, 0);
  } finally {
    await query("DELETE FROM magi_notes WHERE holder = $1", [holder]);
  }
});

test("deposit accepts a materialized note back into the vault and rotates its nonce", async () => {
  const holder = uniqueId("magi-holder");
  try {
    await issue(holder, 1);
    const [withdrawn] = await withdraw(holder, 1);
    const [result] = await deposit(holder, [withdrawn!]);
    assert.equal(result!.verdict, "ok");
    assert.notEqual(result!.token!.nonce, withdrawn!.nonce);

    const state = await holderState(holder);
    assert.equal(state.vaulted, 1);
    assert.equal(state.materialized, 0);
  } finally {
    await query("DELETE FROM magi_notes WHERE holder = $1", [holder]);
  }
});

test("check rotates a materialized note's nonce without moving it out of the world", async () => {
  const holder = uniqueId("magi-holder");
  try {
    await issue(holder, 1);
    const [withdrawn] = await withdraw(holder, 1);
    const [result] = await check(holder, [withdrawn!], "pickup");
    assert.equal(result!.verdict, "ok");
    assert.notEqual(result!.token!.nonce, withdrawn!.nonce);

    const state = await holderState(holder);
    assert.equal(state.materialized, 1);
  } finally {
    await query("DELETE FROM magi_notes WHERE holder = $1", [holder]);
  }
});

test("a forged token is rejected before any ledger lookup", async () => {
  const holder = uniqueId("magi-holder");
  const forged = token({ seal: "0".repeat(64) });
  const [result] = await deposit(holder, [forged]);
  assert.equal(result!.verdict, "forged");
  assert.equal(result!.reason, "seal does not verify");
});

test("an unknown serial that carries a valid seal is rejected as unknown", async () => {
  const holder = uniqueId("magi-holder");
  const phantom = token({ serial: randomUUID() }); //well-formed, self-consistent seal, never issued
  const [result] = await deposit(holder, [phantom]);
  assert.equal(result!.verdict, "unknown");
});

test("presenting an already-rotated nonce is rejected as stale, keeping the current copy safe", async () => {
  const holder = uniqueId("magi-holder");
  try {
    await issue(holder, 1);
    const [original] = await withdraw(holder, 1);
    const [depositResult] = await deposit(holder, [original!]); //rotates the nonce, note now vaulted

    assert.equal(depositResult!.verdict, "ok");
    const [staleResult] = await check(holder, [original!], "duplicate-check");
    assert.equal(staleResult!.verdict, "stale");
  } finally {
    await query("DELETE FROM magi_notes WHERE holder = $1", [holder]);
  }
});

test("a retired note is rejected even when its seal and nonce are still valid", async () => {
  const holder = uniqueId("magi-holder");
  try {
    await issue(holder, 1);
    const [withdrawn] = await withdraw(holder, 1);
    await query("UPDATE magi_notes SET state = 'retired' WHERE serial = $1", [withdrawn!.serial]);

    const [result] = await deposit(holder, [withdrawn!]);
    assert.equal(result!.verdict, "retired");
  } finally {
    await query("DELETE FROM magi_notes WHERE holder = $1", [holder]);
  }
});

after(() => pool.end());
