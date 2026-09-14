# Hashimon PoW Specification

Byte-exact reference for browser grinding + server verification. Derived from Spoon mini-PoW (`Spoon.energy/private-mini-spoon/mp/mining.service.js`) and the Hashimon DNA job adapter.

## Modes

| Mode | Use case | Dataset |
|------|----------|---------|
| `bound` | **Hashimon MVP** (browser + verify) | UTF-8 `${dna}:${extranonce1}:${extranonce2}:${nonce}` |
| `legacy` | Original Hashimon placeholder | UTF-8 `${dna}:${extranonce2}` |
| `bitcoin` | Real block-template header, issued when `HASHIMON_MINING_MODE=bitcoin` (never submitted to the network) | 80-byte LE header after coinbase + merkle |

Default for `GET /hashimons/:id/job` and client worker: **`bound`**.

## Algorithms

### doubleSha256

```
hash = SHA256(SHA256(input))
output = lowercase hex (64 chars)
```

Node: `crypto.createHash('sha256')` twice.

### leadingZeroBits(hex)

Count zero bits from the MSB of the first non-zero nibble (Hashimon progression metric).

### progressionOf(pow) / progressionFromBits(bits)

```
progressionOf:        tier = stars = floor(bestShareBits / 4)   (uncapped)
                      stage = min(33, max(1, tier))
progressionFromBits:  tier = stars = min(floor(bits / 4), 33)
                      stage = max(1, tier)
```

### Dna.derive(templateId, birthNonce, speciesKey)

```
dna = SHA256(`${templateId}:${birthNonce}:${speciesKey}`) → 64 hex lowercase
```

Genesis starters are `g2_<spirit>_<element>` species fixed by the player's date of birth, each with its own template; the V1 `genesis_*` keys are legacy and no longer emitted. The server generates `birthNonce`; clients cannot grind DNA before emission.

### deriveExtranonce1(dna)

```
extranonce1 = dna.replace(/[^0-9a-fA-F]/g, '').slice(0, 8).toLowerCase() || 'deadbeef'
```

Matches Rabbit `seed` constraint (max 8 hex chars).

### hashShareBound (primary)

```typescript
payload = `${dna}:${extranonce1}:${extranonce2}:${nonce}`  // UTF-8
hash = doubleSha256(payload)
validShare ⇔ leadingZeroBits(hash) >= shareTargetBits
```

### hashShareLegacy

```typescript
hash = doubleSha256(`${dna}:${extranonce2}`)
```

### Bitcoin header path (Spoon validateSubmit)

1. `coinbaseHex = coinbasePrefix + extranonce1 + extranonce2_padded + coinbaseSuffix`
2. `coinbaseHashLE = doubleSha256(coinbaseHex bytes)`
3. Merkle: `root = coinbaseHash`, then for each `merkleBranch` entry `root = doubleSha256(root || branch)` — Stratum order: branch entries and root are raw digest bytes, **nothing is reversed** (reversing either yields a header no pool accepts)
4. `merkleRootLE = root` (as-is)
5. Header LE hex concat (the other fields reversed from BE display; version-rolling bits applied under mask `0x1fffe000` when present):
   - `versionLE + reverseHex(prevHash) + merkleRootLE + reverseHex(nTime) + reverseHex(bits) + reverseHex(nonce)`
6. `hashBE = reverseHex(doubleSha256(headerHex))`
7. Share valid if `leadingZeroBits(hashBE) >= shareTargetBits` (`verifyJobShare`) — the same bits rule as bound mode, not a difficulty target

Reference implementation: [`server/src/modules/core/core/pow.ts`](../src/modules/core/core/pow.ts) `hashBitcoinJob()`.

## Dev targets (calibrated)

| Variable | Value | Rationale |
|----------|-------|-----------|
| `shareTargetBits` | **20** | ~1/1M per hash; kept high to bound write load on `POST /hashimons/:id/shares` |
| `blockTargetBits` | 64 | Not mined in browser |
| `jobTtlMs` | 900000 (15 min) | Matches Rabbit shot expiry |

Defaults live in `pow.ts` (`DEFAULT_SHARE_TARGET_BITS`), `config.ts` and `.env.example`
(`HASHIMON_SHARE_TARGET_BITS`). At a browser worker's ~100-300k H/s, expected time to a
20-bit share is a few seconds.

## Test vectors — bound mode

Fixed inputs:

```
dna = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
extranonce1 = "deadbeef"   // first 8 hex of dna
shareTargetBits = 12   // the vector's own floor, not the runtime default (20)
```

| extranonce2 | nonce | hash (expected) | bits |
|-------------|-------|-----------------|------|
| 9003 | 30 | `00087e63e1166acdfb2cb791769852b5ee1eaf87220458518c6e22dfee95e102` | 12 |

Verification (Node):

```javascript
const crypto = require('crypto');
function dbl(buf) {
  const h1 = crypto.createHash('sha256').update(buf).digest();
  return crypto.createHash('sha256').update(h1).digest('hex');
}
const dna = 'deadbeef'.repeat(8);
console.log(dbl(Buffer.from(`${dna}:deadbeef:9003:30`, 'utf8')));
// → 00087e63e1166acdfb2cb791769852b5ee1eaf87220458518c6e22dfee95e102
```

## Test vectors — legacy mode

```
dna = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
extranonce2 = 0
hash = "418a520170372cd56a31733512e329ce5a737a09fcf5c3254ede23468a59d3aa"
leadingZeroBits = 1
```

## Test vectors — Bitcoin header (Spoon reference)

From `Spoon.energy/private-mini-spoon/mp/test_validate_share.js` (version rolling may differ between implementations). Use the `hashBitcoinJob()` golden tests in `src/modules/core/core/core.test.ts` for regression.

Expected header fields (display BE):

- prevhash: `a801a7254383c846bfb93b84b556b84c71c3eb7ca85501000000000000000000`
- version: `20014000`
- bits: `1701cdfb`
- extranonce1: `34a72f0c`
- extranonce2: `55160000`
- nTime: `69124e82`
- nonce: `b57b1e91`

## Rabbit cross-reference

Rabbit share ID (not PoW): `SHA256(\`${engineRequestId}:${nonce}\`)` — see `api/src/modules/rabbit/models/rabbit-share.model.ts`.

Do **not** use Rabbit `deriveShareHash` for Hashimon verification.