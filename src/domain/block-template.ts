//Bridges issueJob() to a real Bitcoin Core node. Fetches getblocktemplate (BIP22/23),
//reduces it to a compact, creature-agnostic PreparedTemplate (coinbase split around the
//extranonce hole + merkle branch), and caches it so every job in the TTL window reuses one
//RPC round-trip instead of re-pulling a multi-MB template per creature.
import { config } from "@/config";
import { doubleSha256Buffer } from "@/core/pow";

export interface PreparedTemplate {
  templateId: string;
  height: number;
  prevhashBE: string;
  versionHex: string;
  bits: string;
  curtime: number;
  merkleBranch: string[];
  coinbasePrefix: string;
  coinbaseSuffix: string;
  extranonce2Size: number;
  fetchedAt: number;
}

const EXTRANONCE1_SIZE = 4;
const EXTRANONCE2_SIZE = 4;
const COINBASE_TAG_ASCII = "hashimon";
const RPC_TIMEOUT_MS = 5_000;
// ponytail: fixed multiplier, not config — promote to an env var if an operator
// ever needs to tune how long a stale template is served during a node outage.
const MAX_STALE_MS = 20 * 60_000;

let cached: PreparedTemplate | null = null;

export async function getPreparedTemplate(now = Date.now()): Promise<PreparedTemplate | null> {
  if (cached && now - cached.fetchedAt < config.templateRefreshMs) {
    return cached;
  }
  try {
    const raw = await fetchRawTemplate();
    cached = prepareTemplate(raw, now);
    return cached;
  } catch (err: unknown) {
    const host = safeHost(config.btcNodeUrl);
    console.error("block-template: getPreparedTemplate failed", { host, message: (err as Error).message });
    if (cached && now - cached.fetchedAt > MAX_STALE_MS) {
      // Serving an arbitrarily stale template isn't "degrading gracefully" anymore —
      // past this ceiling, mining against a long-superseded block is worse than no
      // bitcoin-mode job at all. Callers (mining.ts::issueJob) fall back to 'bound'.
      return null;
    }
    return cached;
  }
}

interface RawGetBlockTemplateResult {
  version: number;
  previousblockhash: string;
  bits: string;
  curtime: number;
  height: number;
  coinbasevalue: number;
  transactions: Array<{ txid: string }>;
}

async function fetchRawTemplate(): Promise<RawGetBlockTemplateResult> {
  const url = new URL(config.btcNodeUrl);
  const auth = Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64");
  const rpcUrl = `${url.protocol}//${url.host}${url.pathname}`;

  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Basic ${auth}` },
    body: JSON.stringify({
      jsonrpc: "1.0",
      id: "hashimon",
      method: "getblocktemplate",
      params: [{ rules: ["segwit"] }],
    }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`fetchRawTemplate: node responded ${res.status} at ${url.host}`);
  }

  const body = (await res.json()) as { result?: RawGetBlockTemplateResult; error?: { message: string } | null };
  if (body.error) {
    throw new Error(`fetchRawTemplate: rpc error at ${url.host}: ${body.error.message}`);
  }
  if (!body.result) {
    throw new Error(`fetchRawTemplate: empty result at ${url.host}`);
  }
  return body.result;
}

//Never includes credentials — only the host, for error messages and logs.
function safeHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).host;
  } catch {
    return "invalid-url";
  }
}

function prepareTemplate(raw: RawGetBlockTemplateResult, now: number): PreparedTemplate {
  const { prefix, suffix } = buildCoinbase(raw.height, raw.coinbasevalue);
  return {
    templateId: `${raw.height}-${raw.previousblockhash}`,
    height: raw.height,
    prevhashBE: raw.previousblockhash,
    versionHex: (raw.version >>> 0).toString(16).padStart(8, "0"),
    bits: raw.bits,
    curtime: raw.curtime,
    merkleBranch: computeMerkleBranch(raw.transactions.map((tx) => tx.txid)),
    coinbasePrefix: prefix,
    coinbaseSuffix: suffix,
    extranonce2Size: EXTRANONCE2_SIZE,
    fetchedAt: now,
  };
}

//Coinbase raw tx, split around the extranonce1+extranonce2 hole so hashJob() (core/pow.ts)
//can splice per-share values in without reparsing the transaction. No witness commitment
//output and a placeholder OP_RETURN payout — this template is never submitted to the network
//(submitblock is explicitly out of scope), so neither is required for hashing to be
//valid proof of work against the real header.
//ponytail: OP_RETURN payout, no witness commitment — add both if this ever grows a submitblock path.
function buildCoinbase(height: number, coinbaseValueSats: number): { prefix: string; suffix: string } {
  const heightPush = bip34HeightPush(height);
  const extranonceHoleBytes = EXTRANONCE1_SIZE + EXTRANONCE2_SIZE;
  const extranoncePushOpcode = extranonceHoleBytes.toString(16).padStart(2, "0");

  const tagHex = Buffer.from(COINBASE_TAG_ASCII, "ascii").toString("hex");
  const tagPushOpcode = (tagHex.length / 2).toString(16).padStart(2, "0");
  const scriptSigSuffix = tagPushOpcode + tagHex;

  const scriptSigPrefix = heightPush + extranoncePushOpcode;
  const scriptSigLen = scriptSigPrefix.length / 2 + extranonceHoleBytes + scriptSigSuffix.length / 2;

  const valueLE = Buffer.alloc(8);
  valueLE.writeBigUInt64LE(BigInt(coinbaseValueSats));

  const prefix =
    "01000000" + // version = 1, LE
    "01" + // input count
    "00".repeat(32) + // coinbase prevout txid = null
    "ffffffff" + // coinbase prevout index
    scriptSigLen.toString(16).padStart(2, "0") + // scriptSig length varint
    scriptSigPrefix;

  const suffix =
    scriptSigSuffix +
    "ffffffff" + // sequence
    "01" + // output count
    valueLE.toString("hex") +
    "01" + // scriptPubKey length
    "6a" + // OP_RETURN — unspendable placeholder, see note above
    "00000000"; // locktime

  return { prefix, suffix };
}

//BIP34: coinbase scriptSig starts with the block height as a minimal-length,
//sign-padded little-endian push (standard Bitcoin Script CScriptNum encoding).
function bip34HeightPush(height: number): string {
  const bytes: number[] = [];
  let n = height;
  while (n > 0) {
    bytes.push(n & 0xff);
    n = Math.floor(n / 256);
  }
  if (bytes.length === 0) {
    bytes.push(0);
  }
  if ((bytes[bytes.length - 1]! & 0x80) !== 0) {
    bytes.push(0x00);
  }
  const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  return bytes.length.toString(16).padStart(2, "0") + hex;
}

//Merkle branch for a variable (extranonce-dependent) coinbase leaf at index 0: at each tree
//level the sibling of index 0 is always position 1, and index 0's own combined value never
//feeds into any other branch entry — so it can be built from the OTHER txids alone, once per
//template, and reused by hashBitcoinJob() for every share regardless of extranonce.
export function computeMerkleBranch(txidsBE: string[]): string[] {
  let level: Buffer[] = [Buffer.alloc(32), ...txidsBE.map((txid) => Buffer.from(txid, "hex").reverse())];
  const branch: Buffer[] = [];

  while (level.length > 1) {
    branch.push(level[1]!);
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = i + 1 < level.length ? level[i + 1]! : level[i]!;
      next.push(doubleSha256Buffer(Buffer.concat([left, right])));
    }
    level = next;
  }

  return branch.map((b) => Buffer.from(b).reverse().toString("hex"));
}
