//Vectors from BIP173 (v0) and BIP350 (v1/taproot) test suites, plus the operator's
//actual default payout address, to guard decodeSegwitAddress against a wrong
//coinbase output paying an unspendable or wrong-owner script.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeSegwitAddress, segwitScriptPubKeyHex } from "@/domain/bitcoin-address";

test("decodes a mainnet P2WPKH (v0) address into its scriptPubKey", () => {
  const result = decodeSegwitAddress("BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4");
  assert.equal(result.version, 0);
  assert.equal(segwitScriptPubKeyHex(result), "0014751e76e8199196d454941c45d1b3a323f1433bd6");
});

test("decodes a mainnet P2TR (v1/taproot) address into its scriptPubKey", () => {
  const result = decodeSegwitAddress("bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr");
  assert.equal(result.version, 1);
  assert.equal(result.program.length, 32);
});

test("decodes the operator's default payout address", () => {
  const result = decodeSegwitAddress("bc1qcpzntzsnkkz7fue6jqumey63rj4epqj59uyws0");
  assert.equal(result.version, 0);
  assert.equal(result.program.length, 20);
});

test("rejects a bad checksum", () => {
  assert.throws(() => decodeSegwitAddress("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5"));
});

test("rejects mixed-case addresses", () => {
  assert.throws(() => decodeSegwitAddress("bc1Qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"));
});
