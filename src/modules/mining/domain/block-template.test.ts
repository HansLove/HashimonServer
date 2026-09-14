//Verifies the merkle branch and coinbase construction that block-template.ts feeds into
//hashBitcoinJob() (core/pow.ts). (a) is a small hand-verified vector; (c) is the decisive
//check — it round-trips computeMerkleBranch() against a from-scratch full tree over the
//real node's current template (~4000+ txids), which a small vector can't exercise: a wrong
//sibling at some level or a broken odd-duplication rule shows up only at that scale.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeMerkleBranch,
  getPreparedTemplate,
  resetPreparedTemplateCache,
  type FetchRawTemplate,
} from "@/modules/mining/domain/block-template";
import { doubleSha256Buffer } from "@/modules/core/core/pow";
import { config } from "@/modules/core/config";

//Minimal getblocktemplate-shaped fixture — same fields prepareTemplate() reads, so the
//injectable FetchRawTemplate seam can drive getPreparedTemplate() deterministically without
//a live node. Structurally matches the module's own (unexported) RawGetBlockTemplateResult.
function fakeRawTemplate(overrides: Partial<{
  version: number;
  previousblockhash: string;
  bits: string;
  curtime: number;
  height: number;
  coinbasevalue: number;
  transactions: Array<{ txid: string }>;
}> = {}) {
  return {
    version: overrides.version ?? 0x20000000,
    previousblockhash: overrides.previousblockhash ?? "11".repeat(32),
    bits: overrides.bits ?? "1d00ffff",
    curtime: overrides.curtime ?? 1_700_000_000,
    height: overrides.height ?? 850_000,
    coinbasevalue: overrides.coinbasevalue ?? 312_500_000,
    transactions: overrides.transactions ?? [],
  };
}

//Full pairwise merkle tree (duplicate-last-if-odd), written independently from the
//production peel-loop, over leaves given in display (BE) hex.
function fullMerkleRoot(leavesBE: string[]): string {
  let level: Buffer[] = leavesBE.map((hex) => Buffer.from(hex, "hex").reverse());
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = i + 1 < level.length ? level[i + 1]! : level[i]!;
      next.push(doubleSha256Buffer(Buffer.concat([left, right])));
    }
    level = next;
  }
  return Buffer.from(level[0]!).reverse().toString("hex");
}

//Folds a merkle branch against a leaf-0 hash the same way hashBitcoinJob() does: the branch
//is in internal byte order, so siblings are concatenated raw. Only the ends convert to display.
function foldBranch(leaf0BE: string, branch: string[]): string {
  let root: Buffer = Buffer.from(leaf0BE, "hex").reverse();
  for (const sibling of branch) {
    root = doubleSha256Buffer(Buffer.concat([root, Buffer.from(sibling, "hex")]));
  }
  return Buffer.from(root).reverse().toString("hex");
}

//Minimal getblocktemplate fetch, independent of block-template.ts's internal cache — only
//extracts txids, in a single call, so the round-trip check below can't race the mempool.
async function fetchTxidsOnce(): Promise<string[] | null> {
  const rawUrl = process.env.BTC_NODE_CONNECTION_URL;
  if (!rawUrl) {
    return null;
  }
  const url = new URL(rawUrl);
  const auth = Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64");
  const rpcUrl = `${url.protocol}//${url.host}${url.pathname}`;
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Basic ${auth}` },
      body: JSON.stringify({ jsonrpc: "1.0", id: "block-template-test", method: "getblocktemplate", params: [{ rules: ["segwit"] }] }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: { transactions?: Array<{ txid: string }> } };
    return body.result?.transactions?.map((tx) => tx.txid) ?? null;
  } catch {
    return null;
  }
}

test("computeMerkleBranch matches a hand-computed small tree (incl. odd-node duplication)", () => {
  const txids = ["aa".repeat(32), "bb".repeat(32), "cc".repeat(32)];
  const branch = computeMerkleBranch(txids);
  //Internal byte order — the reverse of the display hex a block explorer would show.
  assert.deepEqual(branch, [
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "af2f84dc364906ee18beddba66db4a4651b0fb8b6a910fa410dca452e6b98528",
  ]);
});

test("computeMerkleBranch of zero other txids yields an empty branch", () => {
  assert.deepEqual(computeMerkleBranch([]), []);
});

test("real template: coinbase reassembles into a well-formed transaction", async () => {
  const prepared = await getPreparedTemplate();
  if (!prepared) {
    // Node unreachable in this environment — nothing to verify against.
    return;
  }

  const extranonce1 = "deadbeef";
  const extranonce2 = "00000001";
  const rawTx = prepared.coinbasePrefix + extranonce1 + extranonce2 + prepared.coinbaseSuffix;

  assert.equal(rawTx.length % 2, 0, "coinbase hex must have an even length");
  assert.equal(rawTx.slice(0, 8), "01000000", "tx version must be 1, little-endian");
  assert.equal(rawTx.slice(-8), "00000000", "locktime must be present at the end");
  assert.equal(rawTx.slice(8, 10), "01", "input count must be 1");
  assert.equal(rawTx.slice(10, 74), "00".repeat(32), "coinbase prevout txid must be null");
  assert.equal(rawTx.slice(74, 82), "ffffffff", "coinbase prevout index must be 0xffffffff");
});

test("real template: merkle branch round-trips against a from-scratch full tree", async () => {
  const txids = await fetchTxidsOnce();
  if (!txids) {
    return;
  }

  const syntheticCoinbaseLeaf = "11".repeat(32);
  const rootViaBranch = foldBranch(syntheticCoinbaseLeaf, computeMerkleBranch(txids));
  const rootViaFullTree = fullMerkleRoot([syntheticCoinbaseLeaf, ...txids]);

  assert.equal(rootViaBranch, rootViaFullTree);
});

//Injectable-fetch coverage (the extract-and-override seam): drives the cache-hit,
//re-fetch, stale-serve and exhausted-cache branches without touching a live node.
test("getPreparedTemplate resolves a fake raw template into a well-formed PreparedTemplate", async () => {
  resetPreparedTemplateCache();
  const raw = fakeRawTemplate({ height: 900_000, previousblockhash: "22".repeat(32) });
  const now = 1_700_000_000_000;

  const prepared = await getPreparedTemplate(now, async () => raw);

  assert.ok(prepared);
  assert.equal(prepared.templateId, `900000-${"22".repeat(32)}`);
  assert.equal(prepared.height, 900_000);
  assert.equal(prepared.fetchedAt, now);
  assert.equal(prepared.extranonce2Size, 4);
  //Coinbase reassembles into a well-formed transaction, same shape the "real template"
  //check above verifies, deterministically this time.
  const rawTx = prepared.coinbasePrefix + "deadbeef" + "00000001" + prepared.coinbaseSuffix;
  assert.equal(rawTx.length % 2, 0, "coinbase hex must have an even length");
  assert.equal(rawTx.slice(0, 8), "01000000", "tx version must be 1, little-endian");
  assert.equal(rawTx.slice(-8), "00000000", "locktime must be present at the end");
  resetPreparedTemplateCache();
});

test("getPreparedTemplate caches within the refresh window and re-fetches past it", async () => {
  resetPreparedTemplateCache();
  const raw = fakeRawTemplate();
  let calls = 0;
  const fetchTemplate: FetchRawTemplate = async () => {
    calls++;
    return raw;
  };
  const now = 1_700_000_000_000;

  const first = await getPreparedTemplate(now, fetchTemplate);
  assert.equal(calls, 1);

  const cacheHit = await getPreparedTemplate(now + 1_000, fetchTemplate);
  assert.equal(calls, 1, "a call inside the refresh window must not re-fetch");
  assert.equal(cacheHit, first);

  const refetched = await getPreparedTemplate(now + config.templateRefreshMs + 1, fetchTemplate);
  assert.equal(calls, 2, "a call past the refresh window must re-fetch");
  assert.notEqual(refetched, null);
  resetPreparedTemplateCache();
});

test("getPreparedTemplate serves the stale cache when a re-fetch fails, within the ceiling", async () => {
  resetPreparedTemplateCache();
  const raw = fakeRawTemplate();
  const now = 1_700_000_000_000;
  const first = await getPreparedTemplate(now, async () => raw);
  assert.ok(first);

  const failing: FetchRawTemplate = async () => {
    throw new Error("node unreachable");
  };
  const served = await getPreparedTemplate(now + config.templateRefreshMs + 1, failing);
  assert.deepEqual(served, first, "a failed refresh must serve the last good template");
  resetPreparedTemplateCache();
});

test("getPreparedTemplate drops a cache stale beyond MAX_STALE_MS and returns null", async () => {
  resetPreparedTemplateCache();
  const raw = fakeRawTemplate();
  const now = 1_700_000_000_000;
  await getPreparedTemplate(now, async () => raw);

  const failing: FetchRawTemplate = async () => {
    throw new Error("node unreachable");
  };
  const result = await getPreparedTemplate(now + 20 * 60_000 + 1, failing);
  assert.equal(result, null, "past the staleness ceiling, degrading further is worse than no template");
  resetPreparedTemplateCache();
});

test("getPreparedTemplate with no prior cache and a failing fetch returns null", async () => {
  resetPreparedTemplateCache();
  const result = await getPreparedTemplate(1_700_000_000_000, async () => {
    throw new Error("boom");
  });
  assert.equal(result, null);
  resetPreparedTemplateCache();
});
