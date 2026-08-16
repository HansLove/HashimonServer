import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import * as secp from "@noble/secp256k1";

export const LUANTI_USERNAME_RE = /^[A-Za-z0-9_-]{1,20}$/;

export type Custody = "server_encrypted" | "player";

export function isValidLuantiUsername(name: string): boolean {
  return LUANTI_USERNAME_RE.test(name);
}

/** Legacy Luanti password hash: base64(SHA1(name + password)). */
export function luantiPasswordHash(name: string, password: string): string {
  return createHash("sha1").update(name + password, "utf8").digest("base64");
}

export function isValidCompressedPublicKey(hex: string): boolean {
  if (!/^(02|03)[0-9a-fA-F]{64}$/.test(hex)) { return false; }
  try {
    secp.ProjectivePoint.fromHex(hex);
    return true;
  } catch {
    return false;
  }
}

export interface GeneratedKeypair {
  privateKeyHex: string;
  publicKeyHex: string;
}

export function generateSecp256k1Keypair(): GeneratedKeypair {
  const privateKey = secp.utils.randomPrivateKey();
  const publicKey = secp.getPublicKey(privateKey, true);
  return {
    privateKeyHex: Buffer.from(privateKey).toString("hex"),
    publicKeyHex: Buffer.from(publicKey).toString("hex"),
  };
}

export interface EncryptedPrivateKey {
  ciphertext: Buffer;
  kdfSalt: string;
  kdfParams: { N: number; r: number; p: number; dkLen: number; cipher: string };
}

const SCRYPT = { N: 16384, r: 8, p: 1, dkLen: 32 } as const;

/** Encrypt secp256k1 private key hex with a key derived from the account password. */
export function encryptPrivateKey(privateKeyHex: string, password: string): EncryptedPrivateKey {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, SCRYPT.dkLen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(privateKeyHex, "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  // layout: iv(12) || tag(16) || ciphertext
  return {
    ciphertext: Buffer.concat([iv, tag, encrypted]),
    kdfSalt: salt.toString("hex"),
    kdfParams: { ...SCRYPT, cipher: "aes-256-gcm" },
  };
}

export function decryptPrivateKey(
  blob: Buffer,
  password: string,
  kdfSaltHex: string,
  kdfParams: { N: number; r: number; p: number; dkLen: number }
): string {
  const salt = Buffer.from(kdfSaltHex, "hex");
  const key = scryptSync(password, salt, kdfParams.dkLen, {
    N: kdfParams.N,
    r: kdfParams.r,
    p: kdfParams.p,
  });
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const data = blob.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export function encPrivateKeyToBase64(blob: Buffer): string {
  return blob.toString("base64");
}
