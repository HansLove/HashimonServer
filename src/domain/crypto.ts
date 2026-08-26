import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, scryptSync, timingSafeEqual, type ScryptOptions } from "node:crypto";
import * as secp from "@noble/secp256k1";

function scryptAsync(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) { reject(err); return; }
      resolve(derivedKey);
    });
  });
}

export const LUANTI_USERNAME_RE = /^[A-Za-z0-9_-]{1,20}$/;

export type Custody = "server_encrypted" | "player";

export function isValidLuantiUsername(name: string): boolean {
  return LUANTI_USERNAME_RE.test(name);
}

/* ---- Luanti SRP-6a password entries -------------------------------------
 * The engine stores passwords as "#1#<b64 salt>#<b64 verifier>" and never sees the
 * plaintext (src/util/auth.cpp, src/util/srp.cpp). Byte-for-byte compatibility is the
 * whole requirement, so the derivation is reimplemented here rather than pulled from an
 * npm SRP package: they follow RFC 5054's padded-x/hex conventions, csrp hashes raw
 * minimal-length big-endian bytes.
 *   x = SHA256(salt || SHA256(lower(name) ":" password))   -- big-endian
 *   v = g^x mod N   with the RFC 5054 2048-bit group, g = 2
 */
const SRP_N_2048 = BigInt(
  "0xAC6BDB41324A9A9BF166DE5E1389582FAF72B6651987EE07FC3192943DB56050" +
  "A37329CBB4A099ED8193E0757767A13DD52312AB4B03310DCD7F48A9DA04FD50" +
  "E8083969EDB767B0CF6095179A163AB3661A05FBD5FAAAE82918A9962F0B93B8" +
  "55F97993EC975EEAA80D740ADBF4FF747359D041D5C33EA71D281E446B14773B" +
  "CA97B43A23FB801676BD207A436C6481F1D2B9078717461A5B9D32E688F87748" +
  "544523B524B0D57D5EA77A2775D2ECFA032CFBDBF52FB3786160279004E57AE6" +
  "AF874E7303CE53299CCC041C7BC308D82A5698F3A8D0C38271AE35F8E9DBFBB6" +
  "94B5C803D89F7AE435DE236D525F54759B65E372FCD68EF20FA7111F9E4AFF73"
);
const SRP_G = 2n;

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) { result = (result * b) % mod; }
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

/** Minimal-length big-endian bytes, matching gmp's mpz_to_bin (no leading zeros). */
function toMinimalBytes(n: bigint): Buffer {
  let hex = n.toString(16);
  if (hex.length % 2 === 1) { hex = "0" + hex; }
  return Buffer.from(hex, "hex");
}

function srpVerifier(name: string, password: string, salt: Buffer): Buffer {
  const namePassword = createHash("sha256")
    .update(`${name.toLowerCase()}:${password}`, "utf8")
    .digest();
  const x = BigInt("0x" + createHash("sha256").update(Buffer.concat([salt, namePassword])).digest("hex"));
  return toMinimalBytes(modPow(SRP_G, x, SRP_N_2048));
}

/** Luanti's DB-ready SRP entry for this name/password, with a fresh 16-byte salt. */
export function luantiSrpEntry(name: string, password: string): string {
  const salt = randomBytes(16);
  return `#1#${salt.toString("base64")}#${srpVerifier(name, password, salt).toString("base64")}`;
}

export const LUANTI_SRP_ENTRY_RE = /^#1#([A-Za-z0-9+/]+={0,2})#([A-Za-z0-9+/]+={0,2})$/;

/** Shape plus content: canonical base64, a 16-byte salt, a non-zero verifier inside the 2048-bit group. */
export function isLuantiSrpEntry(entry: string): boolean {
  const parsed = LUANTI_SRP_ENTRY_RE.exec(entry);
  if (!parsed) { return false; }
  const saltB64 = parsed[1]!;
  const verifierB64 = parsed[2]!;
  const salt = Buffer.from(saltB64, "base64");
  const verifier = Buffer.from(verifierB64, "base64");
  if (salt.toString("base64") !== saltB64 || verifier.toString("base64") !== verifierB64) { return false; }
  return salt.length === 16 && verifier.length > 0 && verifier.length <= 256 && verifier.some((b) => b !== 0);
}

/** Recompute the verifier with the entry's own salt and compare. */
export function luantiSrpVerify(name: string, password: string, entry: string): boolean {
  const parsed = LUANTI_SRP_ENTRY_RE.exec(entry);
  if (!parsed) { return false; }
  const saltB64 = parsed[1];
  const verifierB64 = parsed[2];
  if (!saltB64 || !verifierB64) { return false; }
  const expected = srpVerifier(name, password, Buffer.from(saltB64, "base64"));
  const actual = Buffer.from(verifierB64, "base64");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
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

/** Encrypt secp256k1 private key hex with a key derived from the account password.
 *  Uses the async scrypt (not scryptSync) so this doesn't block the event loop on
 *  every registration — scrypt at N=16384 is deliberately CPU-heavy. */
export async function encryptPrivateKey(privateKeyHex: string, password: string): Promise<EncryptedPrivateKey> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT.dkLen, {
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
