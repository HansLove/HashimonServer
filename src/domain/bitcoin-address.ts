//Decodes a bech32/bech32m segwit address (BIP173/BIP350) into a scriptPubKey, so
//block-template.ts can pay the coinbase to a real address instead of an OP_RETURN
//placeholder. Only segwit (bc1.../tb1.../bcrt1...) is supported — legacy base58
//addresses (1.../3...) are out of scope until an operator needs one.
import { bech32, bech32m } from "bech32";

export interface SegwitScriptPubKey {
  version: number;
  program: Buffer;
}

export function decodeSegwitAddress(address: string): SegwitScriptPubKey {
  const decoded = decodeWithEitherEncoding(address);
  const [witnessVersion, ...programWords] = decoded.words;
  if (witnessVersion === undefined) {
    throw new Error(`decodeSegwitAddress: empty data in "${address}"`);
  }

  const expectsBech32m = witnessVersion !== 0;
  if (decoded.usedBech32m !== expectsBech32m) {
    throw new Error(`decodeSegwitAddress: witness v${witnessVersion} must use ${expectsBech32m ? "bech32m" : "bech32"}`);
  }

  const program = Buffer.from(bech32.fromWords(programWords));
  if (witnessVersion === 0 && program.length !== 20 && program.length !== 32) {
    throw new Error(`decodeSegwitAddress: witness v0 program must be 20 or 32 bytes, got ${program.length}`);
  }
  if (witnessVersion > 16 || program.length < 2 || program.length > 40) {
    throw new Error(`decodeSegwitAddress: invalid witness program in "${address}"`);
  }

  return { version: witnessVersion, program };
}

export function segwitScriptPubKeyHex({ version, program }: SegwitScriptPubKey): string {
  const versionOpcode = (version === 0 ? 0x00 : 0x50 + version).toString(16).padStart(2, "0");
  const pushOpcode = program.length.toString(16).padStart(2, "0");
  return versionOpcode + pushOpcode + program.toString("hex");
}

//bech32 and bech32m share a charset but differ in checksum constant — the address format
//itself doesn't say which was used, so try both and record which one validated.
function decodeWithEitherEncoding(address: string): { words: number[]; usedBech32m: boolean } {
  try {
    return { words: bech32.decode(address).words, usedBech32m: false };
  } catch {
    // fall through to bech32m
  }
  try {
    return { words: bech32m.decode(address).words, usedBech32m: true };
  } catch {
    throw new Error(`decodeSegwitAddress: malformed address "${address}"`);
  }
}
