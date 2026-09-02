//Verifies the merkle branch and coinbase construction that block-template.ts feeds into
//hashBitcoinJob() (core/pow.ts). (a) is a small hand-verified vector; (c) is the decisive
//check — it round-trips computeMerkleBranch() against a from-scratch full tree over the
//real node's current template (~4000+ txids), which a small vector can't exercise: a wrong
//sibling at some level or a broken odd-duplication rule shows up only at that scale.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMerkleBranch, getPreparedTemplate } from "@/domain/block-template";
import { doubleSha256Buffer } from "@/core/pow";

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
