import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import {
  encryptPrivateKey,
  decryptPrivateKey,
  generateSecp256k1Keypair,
  isValidCompressedPublicKey,
  isValidLuantiUsername,
  isLuantiSrpEntry,
  luantiSrpEntry,
  luantiSrpVerify,
} from "@/domain/crypto";
import { canOwn, loginOwner, registerLuantiGuest, registerOwner } from "@/domain/players";
import { pool, query } from "@/db/pool";
import { AppError } from "@/http/errors";

function rejectsWithCode(code: string) {
  return (err: unknown) => err instanceof AppError && err.code === code;
}

describe("crypto / ownership helpers", () => {
  it("validates Luanti usernames", () => {
    assert.equal(isValidLuantiUsername("Hans"), true);
    assert.equal(isValidLuantiUsername("a"), true);
    assert.equal(isValidLuantiUsername("too_long_username_xxx"), false);
    assert.equal(isValidLuantiUsername("bad name"), false);
  });

  // Reference vector: this entry was produced by luantiSrpEntry and then fed to the
  // engine's own core.check_password_entry() on a throwaway devtest world, which
  // accepted it for "Hans" and "hans" with secret123 and rejected a wrong password.
  // If a change here breaks parity with the engine, this vector is what catches it.
  const ENGINE_VECTOR = "#1#CWvgWHs19Sugq+uNeEFcKQ==#MVCq88fjqjehoHtx6U9AcuV/+jVT/Up8lqi3HE0Zkn66zf4wGnOQ4DjiKErARvl0BK9njKPDdZ5kSC5TQEEveSdMytMiz/RgfnsTt1+O8lh6du0XnWrA2Agidyx6FIRh/ZlyeEuL2NZsULf6B96zc2BKtisNXGsdpCpM4Ji7Ep7OdoPnt+pfdCQEnsCTZCXK2WX4oxvA1A9uQB0wn8HJAU6/XuOW3oCh1iP7paa0l4asNrMHLBtEQSuq8j+h9BnRFZQ3b+ZWY8KAK/M279vYkfJ4qUqnB0xY82x+3pCNp+OywusvFNWyum0Uhf1JlpdEJWEzCVlAG48biFB85VsiCg==";

  it("matches the engine's SRP verifier for a known entry", () => {
    assert.equal(luantiSrpVerify("Hans", "secret123", ENGINE_VECTOR), true);
    // The engine lowercases the name before deriving x, so casing cannot diverge.
    assert.equal(luantiSrpVerify("hans", "secret123", ENGINE_VECTOR), true);
    assert.equal(luantiSrpVerify("Hans", "secret124", ENGINE_VECTOR), false);
  });

  it("round-trips a freshly generated SRP entry", () => {
    const entry = luantiSrpEntry("Hans", "secret123");
    assert.equal(isLuantiSrpEntry(entry), true);
    assert.equal(luantiSrpVerify("Hans", "secret123", entry), true);
    assert.equal(luantiSrpVerify("HANS", "secret123", entry), true);
    assert.equal(luantiSrpVerify("Hans", "wrong", entry), false);
    // Fresh salt per call, so the same credentials never yield the same entry.
    assert.notEqual(entry, luantiSrpEntry("Hans", "secret123"));
  });

  it("rejects non-SRP password entries", () => {
    assert.equal(isLuantiSrpEntry("K7poFuVjUiXSeZvwAnieGlRMpkk"), false); // legacy SHA1
    assert.equal(isLuantiSrpEntry("#1#onlysalt"), false);
    assert.equal(luantiSrpVerify("Hans", "secret123", "#1#onlysalt"), false);
  });

  it("accepts the unpadded base64 the engine actually emits (util/base64.cpp skips padding)", () => {
    const unpadded = ENGINE_VECTOR.replace(/=+/g, "");
    assert.equal(isLuantiSrpEntry(unpadded), true);
    assert.equal(luantiSrpVerify("Hans", "secret123", unpadded), true);
  });

  it("generates entries in the engine's unpadded format", () => {
    const entry = luantiSrpEntry("Hans", "secret123");
    assert.equal(entry.includes("="), false);
  });

  it("generates and round-trips encrypted private keys", async () => {
    const kp = generateSecp256k1Keypair();
    assert.equal(isValidCompressedPublicKey(kp.publicKeyHex), true);
    const enc = await encryptPrivateKey(kp.privateKeyHex, "password123");
    const plain = decryptPrivateKey(enc.ciphertext, "password123", enc.kdfSalt, enc.kdfParams);
    assert.equal(plain, kp.privateKeyHex);
  });

  it("canOwn requires public_key", () => {
    assert.equal(canOwn({ public_key: null }), false);
    assert.equal(canOwn({ public_key: "02ab" }), true);
  });
});

describe("Luanti guest login and claim (against the local DB)", () => {
  const testUsernames: string[] = [];

  function uniqueUsername(prefix: string): string {
    const suffix = process.hrtime.bigint().toString(36);
    const name = `${prefix}${suffix}`.slice(0, 20);
    testUsernames.push(name);
    return name;
  }

  after(async () => {
    if (testUsernames.length > 0) {
      await query(`DELETE FROM players WHERE username = ANY($1)`, [testUsernames]);
    }
    await pool.end();
  });

  it("logs a Luanti-only guest in against its SRP entry, with the wrong password rejected", async () => {
    const username = uniqueUsername("srpguest");
    await registerLuantiGuest(username, luantiSrpEntry(username, "correct-horse-1"));

    const result = await loginOwner(username, "correct-horse-1");
    assert.equal(result.player.username, username);
    assert.equal(canOwn(result.player), false);

    await assert.rejects(loginOwner(username, "wrong-password"), rejectsWithCode("invalid_credentials"));
  });

  it("claims a Luanti-only guest through registerOwner, keeping the same luanti_password", async () => {
    const username = uniqueUsername("claimguest");
    const luantiPassword = luantiSrpEntry(username, "correct-horse-2");
    const guest = await registerLuantiGuest(username, luantiPassword);

    const claimed = await registerOwner({
      username,
      password: "correct-horse-2",
      speciesKey: "genesis_fuego",
    });
    assert.equal(claimed.claimed, true);
    assert.equal(canOwn(claimed.player), true);
    assert.equal(claimed.hashimon !== undefined, true);

    const row = await query<{ luanti_password: string }>(
      `SELECT luanti_password FROM players WHERE id = $1`,
      [guest.id]
    );
    assert.equal(row.rows[0]?.luanti_password, luantiPassword);

    // Now claimed: the same endpoint refuses to claim it a second time.
    await assert.rejects(
      registerOwner({ username, password: "correct-horse-2", speciesKey: "genesis_fuego" }),
      rejectsWithCode("username_taken")
    );
  });

  it("refuses to claim a Luanti-only guest with the wrong password", async () => {
    const username = uniqueUsername("badclaim");
    await registerLuantiGuest(username, luantiSrpEntry(username, "correct-horse-3"));

    await assert.rejects(
      registerOwner({ username, password: "totally-wrong-pw", speciesKey: "genesis_fuego" }),
      rejectsWithCode("username_taken")
    );
  });
});
