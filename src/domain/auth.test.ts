import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  encryptPrivateKey,
  decryptPrivateKey,
  generateSecp256k1Keypair,
  isValidCompressedPublicKey,
  isValidLuantiUsername,
  luantiPasswordHash,
} from "@/domain/crypto";
import { canOwn } from "@/domain/players";

describe("crypto / ownership helpers", () => {
  it("validates Luanti usernames", () => {
    assert.equal(isValidLuantiUsername("Hans"), true);
    assert.equal(isValidLuantiUsername("a"), true);
    assert.equal(isValidLuantiUsername("too_long_username_xxx"), false);
    assert.equal(isValidLuantiUsername("bad name"), false);
  });

  it("hashes Luanti legacy passwords", () => {
    const h = luantiPasswordHash("Hans", "secret123");
    assert.match(h, /^[A-Za-z0-9+/=]+$/);
    assert.equal(h, luantiPasswordHash("Hans", "secret123"));
    assert.notEqual(h, luantiPasswordHash("hans", "secret123"));
  });

  it("generates and round-trips encrypted private keys", () => {
    const kp = generateSecp256k1Keypair();
    assert.equal(isValidCompressedPublicKey(kp.publicKeyHex), true);
    const enc = encryptPrivateKey(kp.privateKeyHex, "password123");
    const plain = decryptPrivateKey(enc.ciphertext, "password123", enc.kdfSalt, enc.kdfParams);
    assert.equal(plain, kp.privateKeyHex);
  });

  it("canOwn requires public_key", () => {
    assert.equal(canOwn({ public_key: null }), false);
    assert.equal(canOwn({ public_key: "02ab" }), true);
  });
});
