# Hashimon PoW Specification

Byte-exact reference for browser grinding + server verification. Derived from Spoon mini-PoW (`Spoon.energy/private-mini-spoon/mp/mining.service.js`) and the Hashimon DNA job adapter.

## Modes

| Mode | Use case | Dataset |
|------|----------|---------|
| `bound` | **Hashimon MVP** (browser + verify) | UTF-8 `${dna}:${extranonce1}:${extranonce2}:${nonce}` |
| `legacy` | Original Hashimon placeholder | UTF-8 `${dna}:${extranonce2}` |
| `bitcoin` | Full Stratum block header (future Spoon jobs) | 80-byte LE header after coinbase + merkle |

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

### progressionOf(bits)

```
tier = stars = stage = min(floor(bits / 4), 33)
```

### deriveDna(templateId, birthNonce, speciesKey)

```
dna = SHA256(`${templateId}:${birthNonce}:${speciesKey}`) → 64 hex lowercase
```

Genesis starters use species-specific templates (e.g. `template_genesis_fuego`) with `speciesKey` `genesis_*`. The server generates `birthNonce`; clients cannot grind DNA before emission.

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
3. Merkle: iterate `merkleBranch` (BE hex), reverse each branch to LE, `root = doubleSha256(root || branchLE)`
4. `merkleRootLE = reverseHex(rootBE)`
5. Header LE hex concat (each field reversed from BE display):
   - `versionLE + reverseHex(prevHash) + merkleRootLE + reverseHex(nTime) + reverseHex(bits) + reverseHex(nonce)`
6. `hashBE = reverseHex(doubleSha256(headerHex))`
7. Share valid if `hashBN <= shareTarget` where `shareTarget = 0xffff0000... / difficulty`

Reference implementation: [`server/src/core/pow.ts`](../server/src/core/pow.ts) `hashBitcoinJob()`.

## Dev targets (calibrated)

| Variable | Value | Rationale |
|----------|-------|-----------|
| `shareTargetBits` | **12** | ~1/4096 per hash; ~26k hashes/burst @260ms → ~6 bursts avg for share |
| `blockTargetBits` | 64 | Not mined in browser |
| `jobTtlMs` | 900000 (15 min) | Matches Rabbit shot expiry |

At ~100k H/s, expected time to 12-bit share ≈ 40ms; at ~50k H/s ≈ 80ms.

## Test vectors — bound mode

Fixed inputs:

```
dna = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
extranonce1 = "deadbeef"   // first 8 hex of dna
shareTargetBits = 12
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

From `Spoon.energy/private-mini-spoon/mp/test_validate_share.js` (version rolling may differ between implementations). Use `hashBitcoinJob()` golden tests in `server/tests/pow.test.ts` for regression.

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