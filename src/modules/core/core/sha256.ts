//SHA-256 primitive for the shared deterministic core.
//
//The browser ships a hand-rolled pure-JS SHA-256 (window.SHA256) so it can hash
//synchronously without crypto.subtle. On the server we use Node's native digest
//instead: the IMPLEMENTATIONS differ, but the OUTPUT is byte-identical for the
//same input (verified against the client impl + WebCrypto). Verification here is
//by recomputation, so only the digest has to match — and it does.
import { createHash } from "node:crypto";

export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

//Bitcoin-style proof of work hashes twice. This mirrors HashimonMining.hashOnce
//exactly: the inner digest is a hex STRING, and the outer hash consumes that
//string as text — so `doubleSha256("x") === sha256(sha256("x"))`.
export function doubleSha256(input: string): string {
  return sha256(sha256(input));
}
