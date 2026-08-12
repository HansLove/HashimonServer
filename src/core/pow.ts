//Proof-of-work rules — browser grinds, server verifies (referee, not oracle).
//Modes: bound (MVP), legacy (original client), bitcoin (future Spoon jobs).
import { createHash } from "node:crypto";
import { doubleSha256 } from "@/core/sha256";

export const BITS_PER_STAR = 4;
export const MAX_STAGE = 33;
export const DEFAULT_SHARE_TARGET_BITS = 12;
export const DEFAULT_BLOCK_TARGET_BITS = 64;
/** @deprecated use DEFAULT_SHARE_TARGET_BITS — kept for legacy client parity */
export const SHARE_TARGET_BITS = 10;
export const BLOCK_TARGET_BITS = 64;

export interface JobHeader {
  version: number;
  prevHash: string;
  merkleRoot: string;
  timestamp: number;
  bits: string;
}

export interface BitcoinJobInput {
  prevhashBE: string;
  versionHex: string;
  bits: string;
  merkleBranch: string[];
  extranonce1: string;
  extranonce2Size: number;
  coinbasePrefix: string;
  coinbaseSuffix: string;
  extranonce2: string;
  nTimeHex: string;
  nonceHex: string;
  versionBits?: string | null;
}

export interface ShareSubmitInput {
  jobId: string;
  extranonce2: number;
  nonce: number;
  hash?: string;
}

export interface MiningJobRecord {
  id: string;
  hashimonId: string;
  templateId: string;
  extranonce1: string;
  shareTargetBits: number;
  blockTargetBits: number;
  expiresAt: Date;
  header: JobHeader;
  mode: "bound" | "legacy" | "bitcoin";
  bitcoin?: Omit<BitcoinJobInput, "extranonce2" | "nTimeHex" | "nonceHex">;
}

export interface VerifyJobShareResult {
  verified: boolean;
  accepted: boolean;
  bits: number;
  hash: string;
  error?: string;
  progression: { tier: number; stars: number; stage: number };
}

export interface PowRecord {
  bestShareBits: number;
  bestShareHash: string | null;
  bestShareNonce: number | null;
  bestShareExtranonce2?: number | null;
  totalHashes: number;
  extranonce2: number;
  validShares: number;
  foundBlock: boolean;
}

export function emptyPow(): PowRecord {
  return {
    bestShareBits: 0,
    bestShareHash: null,
    bestShareNonce: null,
    bestShareExtranonce2: null,
    totalHashes: 0,
    extranonce2: 0,
    validShares: 0,
    foundBlock: false,
  };
}

export interface Progression {
  tier: number;
  stars: number;
  stage: number;
  progress: number;
  nextThreshold: number;
  bits: number;
}

export function progressionOf(pow: Pick<PowRecord, "bestShareBits">): Progression {
  const bits = pow.bestShareBits || 0;
  const tier = Math.floor(bits / BITS_PER_STAR);
  const stage = Math.min(MAX_STAGE, Math.max(1, tier));
  return {
    tier,
    stars: tier,
    stage,
    progress: bits - tier * BITS_PER_STAR,
    nextThreshold: BITS_PER_STAR,
    bits,
  };
}

export function progressionFromBits(bits: number): { tier: number; stars: number; stage: number } {
  const value = Math.min(Math.floor(bits / BITS_PER_STAR), MAX_STAGE);
  return { tier: value, stars: value, stage: Math.max(1, value) };
}

export function deriveExtranonce1(dna: string): string {
  const cleaned = dna.replace(/[^0-9a-fA-F]/g, "").slice(0, 8).toLowerCase();
  return cleaned.length > 0 ? cleaned : "deadbeef";
}

/** Original Hashimon placeholder: doubleSha256(`${dna}:${extranonce2}`) */
export function hashShareLegacy(dna: string, extranonce2: number | string): string {
  return doubleSha256(`${dna}:${extranonce2}`);
}

/** Bound mode MVP: doubleSha256(`${dna}:${extranonce1}:${extranonce2}:${nonce}`) */
export function hashShareBound(
  dna: string,
  extranonce1: string,
  extranonce2: number,
  nonce: number,
): string {
  return doubleSha256(`${dna}:${extranonce1}:${extranonce2}:${nonce}`);
}

/** @deprecated alias for hashShareLegacy */
export function hashShare(dna: string, nonce: number | string): string {
  return hashShareLegacy(dna, nonce);
}

function doubleSha256Buffer(input: Buffer | string): Buffer {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  const h1 = createHash("sha256").update(buf).digest();
  return createHash("sha256").update(h1).digest();
}

export function reverseHex(hex: string): string {
  return Buffer.from(hex, "hex").reverse().toString("hex");
}

export function leadingZeroBits(hex: string): number {
  const normalized = hex.toLowerCase().replace(/^0x/, "");
  let bits = 0;
  for (const ch of normalized) {
    const n = parseInt(ch, 16);
    if (Number.isNaN(n)) { break; }
    if (n === 0) {
      bits += 4;
      continue;
    }
    for (let b = 3; b >= 0; b -= 1) {
      if ((n & (1 << b)) === 0) { bits += 1; }
      else { break; }
    }
    break;
  }
  return bits;
}

export function hashJob(job: MiningJobRecord, extranonce2: number, nonce: number): string {
  const dna = job.header.merkleRoot;
  if (job.mode === "legacy") {
    return hashShareLegacy(dna, extranonce2);
  }
  if (job.mode === "bitcoin" && job.bitcoin) {
    return hashBitcoinJob({
      ...job.bitcoin,
      extranonce2: extranonce2.toString(16).padStart(job.bitcoin.extranonce2Size * 2, "0"),
      nTimeHex: job.header.timestamp.toString(16).padStart(8, "0"),
      nonceHex: nonce.toString(16).padStart(8, "0"),
    }).hashBE;
  }
  return hashShareBound(dna, job.extranonce1, extranonce2, nonce);
}

export function hashBitcoinJob(input: BitcoinJobInput): { hashBE: string; hashLE: string; headerHex: string } {
  const en2Padded = input.extranonce2.padStart(input.extranonce2Size * 2, "0");
  const coinbaseHex = input.coinbasePrefix + input.extranonce1 + en2Padded + input.coinbaseSuffix;
  let root = doubleSha256Buffer(Buffer.from(coinbaseHex, "hex"));

  for (const branchHexBE of input.merkleBranch) {
    const branchLE = Buffer.from(branchHexBE, "hex").reverse();
    root = doubleSha256Buffer(Buffer.concat([root, branchLE]));
  }

  const merkleRootLE = reverseHex(root.toString("hex"));
  let versionLE = reverseHex(input.versionHex.padStart(8, "0"));

  if (input.versionBits && input.versionBits.toLowerCase() !== input.versionHex.toLowerCase()) {
    const maskBE = 0x1fffe000;
    const origBE = parseInt(input.versionHex, 16) >>> 0;
    const bitsBE = parseInt(input.versionBits, 16) >>> 0;
    const newVersionBE = ((origBE & ~maskBE) | (bitsBE & maskBE)) >>> 0;
    versionLE = reverseHex(newVersionBE.toString(16).padStart(8, "0"));
  }

  const headerHex =
    versionLE +
    reverseHex(input.prevhashBE) +
    merkleRootLE +
    reverseHex(input.nTimeHex.padStart(8, "0")) +
    reverseHex(input.bits.padStart(8, "0")) +
    reverseHex(input.nonceHex.padStart(8, "0"));

  const hashRawLE = doubleSha256Buffer(Buffer.from(headerHex, "hex")).toString("hex");
  const hashBE = reverseHex(hashRawLE);
  return { hashBE, hashLE: hashRawLE, headerHex };
}

export function calibratedShareTargetBits(): number {
  return Number(process.env.HASHIMON_SHARE_TARGET_BITS) || DEFAULT_SHARE_TARGET_BITS;
}

export type StoredShareVerdict =
  | { status: "unmined" }
  | { status: "ok"; bits: number }
  | { status: "mismatch"; claimedHash: string | null; recomputedHash: string }
  | { status: "underclaim"; claimedBits: number; actualBits: number };

/** Verify a creature's stored best share (dual-mode: bound if extranonce2 recorded). */
export function verifyStoredPow(dna: string, pow: PowRecord): StoredShareVerdict {
  if (pow.bestShareNonce == null || pow.bestShareHash == null) {
    return { status: "unmined" };
  }

  let recomputed: string;
  if (pow.bestShareExtranonce2 != null) {
    recomputed = hashShareBound(
      dna,
      deriveExtranonce1(dna),
      pow.bestShareExtranonce2,
      pow.bestShareNonce,
    );
  } else {
    recomputed = hashShareLegacy(dna, pow.bestShareNonce);
  }

  if (recomputed !== pow.bestShareHash) {
    return { status: "mismatch", claimedHash: pow.bestShareHash, recomputedHash: recomputed };
  }
  const actualBits = leadingZeroBits(recomputed);
  if (actualBits < pow.bestShareBits) {
    return { status: "underclaim", claimedBits: pow.bestShareBits, actualBits };
  }
  return { status: "ok", bits: actualBits };
}

/** @deprecated use verifyStoredPow */
export function verifyShare(dna: string, pow: PowRecord): StoredShareVerdict {
  return verifyStoredPow(dna, pow);
}

/** Verify a submitted share against an active mining job. */
export function verifyJobShare(
  job: MiningJobRecord,
  dna: string,
  submit: ShareSubmitInput,
  seenShareHashes: Set<string>,
): VerifyJobShareResult {
  const fail = (error: string, hash = ""): VerifyJobShareResult => ({
    verified: false,
    accepted: false,
    bits: 0,
    hash,
    error,
    progression: progressionFromBits(0),
  });

  if (!submit.jobId || submit.jobId !== job.id) {
    return fail("stale_job");
  }
  if (job.expiresAt.getTime() < Date.now()) {
    return fail("stale_job");
  }
  if (job.extranonce1 !== deriveExtranonce1(dna)) {
    return fail("dna_mismatch");
  }
  if (!Number.isInteger(submit.extranonce2) || submit.extranonce2 < 0) {
    return fail("invalid_nonce");
  }
  if (!Number.isInteger(submit.nonce) || submit.nonce < 0 || submit.nonce > 0xffffffff) {
    return fail("invalid_nonce");
  }

  const hash = hashJob(job, submit.extranonce2, submit.nonce);
  const bits = leadingZeroBits(hash);

  if (bits < job.shareTargetBits) {
    return fail("under_target", hash);
  }
  if (seenShareHashes.has(hash)) {
    return fail("duplicate_share", hash);
  }

  return {
    verified: true,
    accepted: true,
    bits,
    hash,
    progression: progressionFromBits(bits),
  };
}
