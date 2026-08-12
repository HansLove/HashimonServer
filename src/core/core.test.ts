//Core verification — byte-identical with the browser client.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256, doubleSha256 } from "@/core/sha256";
import { Dna } from "@/core/dna";
import {
  leadingZeroBits,
  hashShare,
  hashShareLegacy,
  hashShareBound,
  deriveExtranonce1,
  progressionOf,
  progressionFromBits,
  verifyStoredPow,
  verifyJobShare,
  emptyPow,
  type PowRecord,
  type MiningJobRecord,
} from "@/core/pow";

const TEST_DNA = "deadbeef".repeat(8);

test("sha256 matches the reference vector", () => {
  assert.equal(sha256(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("doubleSha256 is sha256 of the hex digest of sha256 (client hashOnce)", () => {
  assert.equal(doubleSha256("abc"), sha256(sha256("abc")));
});

test("DNA derivation is deterministic and format-exact", () => {
  const a = Dna.derive("template_solar_001", 481927, "solarCub");
  const b = Dna.derive("template_solar_001", 481927, "solarCub");
  assert.equal(a, b);
  assert.equal(a.length, 64);
  assert.equal(a, sha256("template_solar_001:481927:solarCub"));
  assert.notEqual(a, Dna.derive("template_solar_001", 481928, "solarCub"));
});

test("leadingZeroBits counts nibble and sub-nibble zeros", () => {
  assert.equal(leadingZeroBits("ffff"), 0);
  assert.equal(leadingZeroBits("0fff"), 4);
  assert.equal(leadingZeroBits("00ff"), 8);
  assert.equal(leadingZeroBits("1fff"), 3);
  assert.equal(leadingZeroBits("8fff"), 0);
});

test("progression maps best-share bits to tier/stars/stage", () => {
  assert.deepEqual(progressionOf({ bestShareBits: 0 }), {
    tier: 0, stars: 0, stage: 1, progress: 0, nextThreshold: 4, bits: 0,
  });
  assert.equal(progressionOf({ bestShareBits: 16 }).tier, 4);
  assert.equal(progressionOf({ bestShareBits: 18 }).stars, 4);
  assert.equal(progressionOf({ bestShareBits: 18 }).progress, 2);
});

test("progressionFromBits caps at 33", () => {
  assert.deepEqual(progressionFromBits(48), { tier: 12, stars: 12, stage: 12 });
  assert.deepEqual(progressionFromBits(200), { tier: 33, stars: 33, stage: 33 });
});

test("deriveExtranonce1 takes first 8 hex of dna", () => {
  assert.equal(deriveExtranonce1(TEST_DNA), "deadbeef");
});

test("legacy golden vector", () => {
  const dna = "a".repeat(64);
  const hash = hashShareLegacy(dna, 0);
  assert.equal(hash, "771af4b9e44eda9b10748e92dd00abff4a4006092b70f0a34c25470f748487e4");
  assert.equal(leadingZeroBits(hash), 1);
});

test("bound golden vector (12-bit share)", () => {
  const hash = hashShareBound(TEST_DNA, "deadbeef", 0, 364);
  assert.equal(hash, "0008709c9ea8a11062c9c8bde70efb243ed51d8d735c1b3cc746fbca23aaf890");
  assert.equal(leadingZeroBits(hash), 12);
});

test("verifyStoredPow accepts legacy share and rejects forgery", () => {
  const dna = Dna.derive("t", 1, "solarCub");
  let nonce = 0;
  let hash = "";
  let bits = 0;
  do {
    hash = hashShare(dna, nonce);
    bits = leadingZeroBits(hash);
    if (bits >= 8) { break; }
    nonce++;
  } while (nonce < 5_000_000);
  assert.ok(bits >= 8);

  const honest: PowRecord = { ...emptyPow(), bestShareBits: bits, bestShareHash: hash, bestShareNonce: nonce };
  assert.equal(verifyStoredPow(dna, honest).status, "ok");

  const forged: PowRecord = { ...honest, bestShareNonce: nonce + 1 };
  assert.equal(verifyStoredPow(dna, forged).status, "mismatch");

  const overclaim: PowRecord = { ...honest, bestShareBits: bits + 8 };
  assert.equal(verifyStoredPow(dna, overclaim).status, "underclaim");

  assert.equal(verifyStoredPow(dna, emptyPow()).status, "unmined");
});

test("verifyStoredPow accepts bound share", () => {
  const hash = hashShareBound(TEST_DNA, "deadbeef", 0, 364);
  const pow: PowRecord = {
    ...emptyPow(),
    bestShareBits: 12,
    bestShareHash: hash,
    bestShareNonce: 364,
    bestShareExtranonce2: 0,
  };
  assert.equal(verifyStoredPow(TEST_DNA, pow).status, "ok");
});

function boundJob(): MiningJobRecord {
  return {
    id: "job-1",
    hashimonId: "h1",
    templateId: "tmpl",
    extranonce1: "deadbeef",
    shareTargetBits: 12,
    blockTargetBits: 64,
    expiresAt: new Date(Date.now() + 60_000),
    mode: "bound",
    header: {
      version: 1,
      prevHash: "00",
      merkleRoot: TEST_DNA,
      timestamp: 1,
      bits: "1d00ffff",
    },
  };
}

test("verifyJobShare rejects under target", () => {
  const result = verifyJobShare(boundJob(), TEST_DNA, { jobId: "job-1", extranonce2: 0, nonce: 0 }, new Set());
  assert.equal(result.accepted, false);
  assert.equal(result.error, "under_target");
});

test("verifyJobShare accepts golden vector", () => {
  const result = verifyJobShare(
    boundJob(),
    TEST_DNA,
    { jobId: "job-1", extranonce2: 0, nonce: 364 },
    new Set(),
  );
  assert.equal(result.accepted, true);
  assert.equal(result.bits, 12);
});

test("verifyJobShare rejects duplicate share hash", () => {
  const job = boundJob();
  const submit = { jobId: "job-1", extranonce2: 0, nonce: 364 };
  const seen = new Set<string>();
  const first = verifyJobShare(job, TEST_DNA, submit, seen);
  assert.equal(first.accepted, true);
  seen.add(first.hash);
  const dup = verifyJobShare(job, TEST_DNA, submit, seen);
  assert.equal(dup.error, "duplicate_share");
});
