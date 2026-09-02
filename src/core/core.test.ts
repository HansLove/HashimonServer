import { createHash } from "node:crypto";
import { TEMPERAMENTS } from "@/domain/companion";
//Core verification — byte-identical with the browser client.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256, doubleSha256 } from "@/core/sha256";
import { Dna } from "@/core/dna";
import {
  leadingZeroBits,
  hashShare,
  hashShareLegacy,
  hashShareBound,
  deriveExtranonce1,
  progressionOf,
  progressionFromBits,
  verifyStoredPow,
  verifyJobShare,
  emptyPow,
  hashBitcoinJob,
  stratumPrevHashToBE,
  reverseHex,
  type PowRecord,
  type MiningJobRecord,
  type BitcoinShareSnapshot,
} from "@/core/pow";
import {
  lifeNumberOf,
  spiritOf,
  BIRTH_IDENTITY_FINGERPRINT,
  BIRTH_GOLDEN_VECTORS,
  birthIdentityOf,
  isPlausibleDob,
  genesisSpeciesKey,
  ELEMENT_BY_LIFE,
  SPIRITS,
} from "@/core/birth-identity";
import { Hashimons } from "@/data/species";

const TEST_DNA = "deadbeef".repeat(8);

test("sha256 matches the reference vector", () => {
  assert.equal(sha256(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("doubleSha256 is sha256 of the hex digest of sha256 (client hashOnce)", () => {
  assert.equal(doubleSha256("abc"), sha256(sha256("abc")));
});

test("DNA derivation is deterministic and format-exact", () => {
  const a = Dna.derive("template_solar_001", 481927, "solarCub");
  const b = Dna.derive("template_solar_001", 481927, "solarCub");
  assert.equal(a, b);
  assert.equal(a.length, 64);
  assert.equal(a, sha256("template_solar_001:481927:solarCub"));
  assert.notEqual(a, Dna.derive("template_solar_001", 481928, "solarCub"));
});

test("leadingZeroBits counts nibble and sub-nibble zeros", () => {
  assert.equal(leadingZeroBits("ffff"), 0);
  assert.equal(leadingZeroBits("0fff"), 4);
  assert.equal(leadingZeroBits("00ff"), 8);
  assert.equal(leadingZeroBits("1fff"), 3);
  assert.equal(leadingZeroBits("8fff"), 0);
});

test("progression maps best-share bits to tier/stars/stage", () => {
  assert.deepEqual(progressionOf({ bestShareBits: 0 }), {
    tier: 0, stars: 0, stage: 1, progress: 0, nextThreshold: 4, bits: 0,
  });
  assert.equal(progressionOf({ bestShareBits: 16 }).tier, 4);
  assert.equal(progressionOf({ bestShareBits: 18 }).stars, 4);
  assert.equal(progressionOf({ bestShareBits: 18 }).progress, 2);
});

test("progressionFromBits caps at 33", () => {
  assert.deepEqual(progressionFromBits(48), { tier: 12, stars: 12, stage: 12 });
  assert.deepEqual(progressionFromBits(200), { tier: 33, stars: 33, stage: 33 });
});

test("deriveExtranonce1 takes first 8 hex of dna", () => {
  assert.equal(deriveExtranonce1(TEST_DNA), "deadbeef");
});

test("legacy golden vector", () => {
  const dna = "a".repeat(64);
  const hash = hashShareLegacy(dna, 0);
  assert.equal(hash, "771af4b9e44eda9b10748e92dd00abff4a4006092b70f0a34c25470f748487e4");
  assert.equal(leadingZeroBits(hash), 1);
});

test("bound golden vector (12-bit share)", () => {
  const hash = hashShareBound(TEST_DNA, "deadbeef", 0, 364);
  assert.equal(hash, "0008709c9ea8a11062c9c8bde70efb243ed51d8d735c1b3cc746fbca23aaf890");
  assert.equal(leadingZeroBits(hash), 12);
});

test("verifyStoredPow accepts legacy share and rejects forgery", () => {
  const dna = Dna.derive("t", 1, "solarCub");
  let nonce = 0;
  let hash = "";
  let bits = 0;
  do {
    hash = hashShare(dna, nonce);
    bits = leadingZeroBits(hash);
    if (bits >= 8) { break; }
    nonce++;
  } while (nonce < 5_000_000);
  assert.ok(bits >= 8);

  const honest: PowRecord = { ...emptyPow(), bestShareBits: bits, bestShareHash: hash, bestShareNonce: nonce };
  assert.equal(verifyStoredPow(dna, honest).status, "ok");

  const forged: PowRecord = { ...honest, bestShareNonce: nonce + 1 };
  assert.equal(verifyStoredPow(dna, forged).status, "mismatch");

  const overclaim: PowRecord = { ...honest, bestShareBits: bits + 8 };
  assert.equal(verifyStoredPow(dna, overclaim).status, "underclaim");

  assert.equal(verifyStoredPow(dna, emptyPow()).status, "unmined");
});

test("verifyStoredPow accepts bound share", () => {
  const hash = hashShareBound(TEST_DNA, "deadbeef", 0, 364);
  const pow: PowRecord = {
    ...emptyPow(),
    bestShareBits: 12,
    bestShareHash: hash,
    bestShareNonce: 364,
    bestShareExtranonce2: 0,
  };
  assert.equal(verifyStoredPow(TEST_DNA, pow).status, "ok");
});

test("verifyStoredPow accepts bitcoin share and rejects a tampered template", () => {
  const snapshot: BitcoinShareSnapshot = {
    prevhashBE: "00".repeat(32),
    versionHex: "20000000",
    bits: "1d00ffff",
    //Deliberately not palindromic: a palindromic branch hides any byte-order slip in the fold.
    merkleBranch: ["0123456789abcdef".repeat(4), "fedcba9876543210".repeat(4)],
    coinbasePrefix: "01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff08",
    coinbaseSuffix: "ffffffff0100f2052a010000000000000000",
    extranonce2Size: 4,
    nTimeHex: "00000001",
  };
  const { hashBE } = hashBitcoinJob({
    ...snapshot,
    extranonce1: deriveExtranonce1(TEST_DNA),
    extranonce2: "00000000",
    nonceHex: "00000000",
  });

  const pow: PowRecord = {
    ...emptyPow(),
    bestShareBits: leadingZeroBits(hashBE),
    bestShareHash: hashBE,
    bestShareNonce: 0,
    bestShareExtranonce2: 0,
    bestShareBitcoin: snapshot,
  };
  assert.equal(verifyStoredPow(TEST_DNA, pow).status, "ok");

  const tampered: PowRecord = { ...pow, bestShareBitcoin: { ...snapshot, bits: "1d00fffe" } };
  assert.equal(verifyStoredPow(TEST_DNA, tampered).status, "mismatch");
});

//The share round-trip above can only prove hashBitcoinJob agrees with itself. This vector
//comes from OUTSIDE — spoon's own SharePayload, hash included — so it is the only thing that
//pins the header's byte order: merkle branch folded raw, root raw, prevhash word-swabbed.
const SPOON_GOLDEN_VECTOR = {
  version: "20000000",
  nonce: 0,
  hash: "1930020f0a37e2537eb27e480920ab83d111b577f98b4493bef3b100e7603ed5",
  merkleRoot: "dbbf6aff5612cae443b99cd8adc8ef8ffeea08e0c8ab4d9946d52cda630f0159",
  prevHash: "1c1d1e1f18191a1b14151617101112130c0d0e0f08090a0b0405060700010203",
  bits: "170e2632",
  timestamp: 1787944556,
  opReturn: "48415348494d4f4e2d444e412d474f4c44454e2d564543544f522d30303031",
  coinbasePrefix:
    "01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff1a0372c00d0553504f4f4e",
  coinbaseSuffix:
    "ffffffff03205fa01200000000160014751e76e8199196d454941c45d1b3a323f1433bd60000000000000000216a1f48415348494d4f4e2d444e412d474f4c44454e2d564543544f522d303030310000000000000000266a24aa21a9ed000000000000000000000000000000000000000000000000000000000000000000000000",
  extranonce1: "0000000000000001",
  extranonce2: "0000000000000042",
  extranonce2Size: 8,
  //The first branch is 30 bytes — a synthetic fixture. Nothing here may assume 32.
  merkleBranch: [
    "313131313131313131313131313131313131313131313131313173696231",
    "0e6085fc097e1e76eefeae3c5f88f0f8bfa629b40c6730bb2999cb4ede703e3e",
  ],
} as const;

//What domain/incubation.ts does to turn a spoon SharePayload into a snapshot. Kept here
//verbatim so the vector guards the adaptation, not just the hashing.
function spoonSnapshot(): BitcoinShareSnapshot {
  const v = SPOON_GOLDEN_VECTOR;
  return {
    prevhashBE: stratumPrevHashToBE(v.prevHash),
    versionHex: v.version,
    //Already version-rolled by spoon (BIP310) — rolling it again would corrupt the header.
    versionBits: null,
    bits: v.bits,
    merkleBranch: [...v.merkleBranch],
    coinbasePrefix: v.coinbasePrefix,
    coinbaseSuffix: v.coinbaseSuffix,
    extranonce2Size: v.extranonce2Size,
    extranonce1: v.extranonce1,
    extranonce2: v.extranonce2,
    nTimeHex: v.timestamp.toString(16).padStart(8, "0"),
  };
}

test("hashBitcoinJob reproduces spoon's own share hash (external golden vector)", () => {
  const v = SPOON_GOLDEN_VECTOR;
  const { hashBE } = hashBitcoinJob({
    ...spoonSnapshot(),
    extranonce1: v.extranonce1,
    extranonce2: v.extranonce2,
    nonceHex: v.nonce.toString(16).padStart(8, "0"),
  });
  assert.equal(hashBE, v.hash);
});

test("stratumPrevHashToBE undoes the word swab", () => {
  const swabbed = "1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100";
  //Round-trip: the header field is the swab of what spoon sends, and BE is its reverse.
  assert.equal(
    reverseHex(stratumPrevHashToBE(SPOON_GOLDEN_VECTOR.prevHash)),
    swabbed.slice(0, 64),
  );
  assert.equal(stratumPrevHashToBE(stratumPrevHashToBE(SPOON_GOLDEN_VECTOR.prevHash)), SPOON_GOLDEN_VECTOR.prevHash);
});

test("verifyStoredPow re-verifies an outside pool's share from its own extranonces", () => {
  const v = SPOON_GOLDEN_VECTOR;
  const pow: PowRecord = {
    ...emptyPow(),
    bestShareBits: leadingZeroBits(v.hash),
    bestShareHash: v.hash,
    bestShareNonce: v.nonce,
    //No bestShareExtranonce2: a caos share's extranonces live on the snapshot, not on the DNA.
    bestShareExtranonce2: null,
    bestShareBitcoin: spoonSnapshot(),
  };
  assert.equal(verifyStoredPow(TEST_DNA, pow).status, "ok");

  //A forged hash must not survive, even though the snapshot is genuine.
  const forged: PowRecord = { ...pow, bestShareHash: "00".repeat(32) };
  assert.equal(verifyStoredPow(TEST_DNA, forged).status, "mismatch");

  //Nor may a snapshot be tampered with to claim a different template.
  const tampered: PowRecord = {
    ...pow,
    bestShareBitcoin: { ...spoonSnapshot(), merkleBranch: [v.merkleBranch[1]!, v.merkleBranch[0]!] },
  };
  assert.equal(verifyStoredPow(TEST_DNA, tampered).status, "mismatch");
});

test("the coinbase carries the OP_RETURN the lot asked for", () => {
  const v = SPOON_GOLDEN_VECTOR;
  //The DNA commitment lives in the coinbase, which is what the merkle root commits to — this
  //is the link that makes a bought share provably that creature's and no other's.
  const coinbase = v.coinbasePrefix + v.extranonce1 + v.extranonce2 + v.coinbaseSuffix;
  const pushed = `6a${(v.opReturn.length / 2).toString(16).padStart(2, "0")}${v.opReturn}`;
  assert.ok(coinbase.includes(pushed), "coinbase must contain OP_RETURN <len> <dna>");
});

function boundJob(): MiningJobRecord {
  return {
    id: "job-1",
    hashimonId: "h1",
    templateId: "tmpl",
    extranonce1: "deadbeef",
    shareTargetBits: 12,
    blockTargetBits: 64,
    expiresAt: new Date(Date.now() + 60_000),
    mode: "bound",
    header: {
      version: 1,
      prevHash: "00",
      merkleRoot: TEST_DNA,
      timestamp: 1,
      bits: "1d00ffff",
    },
  };
}

test("verifyJobShare rejects under target", () => {
  const result = verifyJobShare(boundJob(), TEST_DNA, { jobId: "job-1", extranonce2: 0, nonce: 0 }, new Set());
  assert.equal(result.accepted, false);
  assert.equal(result.error, "under_target");
});

test("verifyJobShare accepts golden vector", () => {
  const result = verifyJobShare(
    boundJob(),
    TEST_DNA,
    { jobId: "job-1", extranonce2: 0, nonce: 364 },
    new Set(),
  );
  assert.equal(result.accepted, true);
  assert.equal(result.bits, 12);
});

test("verifyJobShare rejects duplicate share hash", () => {
  const job = boundJob();
  const submit = { jobId: "job-1", extranonce2: 0, nonce: 364 };
  const seen = new Set<string>();
  const first = verifyJobShare(job, TEST_DNA, submit, seen);
  assert.equal(first.accepted, true);
  seen.add(first.hash);
  const dup = verifyJobShare(job, TEST_DNA, submit, seen);
  assert.equal(dup.error, "duplicate_share");
});

// --- Birth Identity (caos-core@2) -----------------------------------------

test("life number reduces digits and keeps 11/22/33 as masters", () => {
  //El ejemplo del diseño: 1+9+9+6+0+1+0+6 = 32 -> 3+2 = 5.
  assert.equal(lifeNumberOf("1996-01-06"), 5);
  assert.equal(lifeNumberOf("2000-01-08"), 11); //suma exacta 11
  assert.equal(lifeNumberOf("1979-12-29"), 4); //40 -> 4
  //Este es el caso que separa las dos reglas posibles: 47 -> 11. Comprobando el
  //maestro en cada paso se detiene en 11 (Eléctrico); comprobándolo sólo en el
  //primer total seguiría a 2 (Aire). Medido, esa diferencia mueve a Eléctrico
  //del 8.7% al 15.5% del padrón.
  assert.equal(lifeNumberOf("1998-09-29"), 11);
});

test("every life number maps to exactly one genesis element", () => {
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 22, 33]) {
    assert.ok(ELEMENT_BY_LIFE[n], `life number ${n} has no element`);
  }
  //El 5 es de Aire, no de Fuego: con el 5 en Fuego, Fuego se llevaba el 33.3%
  //de los nacimientos medidos contra el 13.7% de Aire.
  assert.equal(ELEMENT_BY_LIFE[5], "aire");
});

test("the solar window opens on the 21st and wraps across the year", () => {
  assert.equal(spiritOf("1996-01-20"), "bloom");   //último día de la ventana anterior
  assert.equal(spiritOf("1996-01-21"), "hearth");  //abre la primera ventana
  assert.equal(spiritOf("1996-02-20"), "hearth");  //sigue abierta
  assert.equal(spiritOf("1996-02-21"), "mirror");
  assert.equal(spiritOf("1995-12-21"), "bloom");   //envuelve al año siguiente
});

test("birth identity is deterministic and independent of when it is computed", () => {
  const a = birthIdentityOf("1996-01-06");
  const b = birthIdentityOf("1996-01-06");
  assert.deepEqual(a, b);
  assert.equal(a.spirit, "bloom");
  assert.equal(a.lifeNumber, 5);
  assert.equal(a.element, "aire");
  assert.equal(a.speciesKey, "g2_bloom_aire");
  assert.equal(a.templateId, "template_g2_bloom_aire");
});

test("the twelve spirit lines cover the family space without overlap", () => {
  const families = SPIRITS.flatMap((s) => s.line);
  assert.equal(new Set(families).size, families.length, "a family belongs to two spirits");
  //Un espíritu sin cuerpos instalables debe declarar pariente, o un mundo sin
  //los packs opcionales dejaría esa fecha sin criatura.
  for (const s of SPIRITS) { assert.ok(s.line.length > 0); }
});

test("the birth compiler is frozen: fingerprint over all 17,897 dates", () => {
  //El sello de la Capa A. Cubre las 17,897 fechas de 1970-2018 con su identidad
  //completa, así que cualquier cambio en la tabla de elementos, las ventanas
  //solares o la regla del número de vida mueve la huella y rompe aquí.
  //
  //Si este test falla, la pregunta NO es "cómo actualizo la huella": es si el
  //cambio justifica renacer a todo el padrón. speciesKey está en el preimagen
  //del ADN.
  const h = createHash("sha256");
  for (let y = 1970; y <= 2018; y++) {
    for (let m = 1; m <= 12; m++) {
      const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
      for (let d = 1; d <= dim; d++) {
        const dob = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        const b = birthIdentityOf(dob);
        h.update(`${dob}|${b.lifeNumber}|${b.element}|${b.spirit}|${b.speciesKey}\n`);
      }
    }
  }
  assert.equal(h.digest("hex"), BIRTH_IDENTITY_FINGERPRINT);
});

test("golden vectors resolve by hand", () => {
  for (const [dob, lifeNumber, element, spirit] of BIRTH_GOLDEN_VECTORS) {
    const b = birthIdentityOf(dob);
    assert.equal(b.lifeNumber, lifeNumber, `${dob} número de vida`);
    assert.equal(b.element, element, `${dob} elemento`);
    assert.equal(b.spirit, spirit, `${dob} espíritu`);
  }
});

test("every kin points at a spirit that exists", () => {
  //Un kin colgante no falla al compilar en Lua y sólo se nota en un mundo sin
  //los packs opcionales: la criatura se queda sin cuerpo al que caer. Pasó con
  //`wyrm`, un nombre animal anterior al renombrado arquetípico.
  const keys = new Set(SPIRITS.map((s) => s.key));
  for (const s of SPIRITS) {
    if (s.kin) assert.ok(keys.has(s.kin), `${s.key} apunta a un kin inexistente: ${s.kin}`);
  }
});

test("the solar windows cover the year with no gaps or overlaps", () => {
  //365 días, 12 signos, sin huecos. Bloom envuelve el cambio de año (12/21 ->
  //1/20), que es el caso que un rango ingenuo rompe.
  const seen = new Set<string>();
  let days = 0;
  for (let m = 1; m <= 12; m++) {
    const dim = new Date(Date.UTC(2001, m, 0)).getUTCDate();
    for (let d = 1; d <= dim; d++) {
      seen.add(spiritOf(`2001-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`));
      days++;
    }
  }
  assert.equal(days, 365);
  assert.equal(seen.size, 12, "algún signo no recibe ningún día");
});

test("the server and the browser agree on the temperament list", () => {
  //El nibble [47] indexa por POSICIÓN: si las dos listas se desordenan, cada
  //criatura viva cambia de carácter. El navegador tiene la suya en
  //ihashima-website/src/lib/compiler.ts y este es el único sitio que las ata.
  assert.deepEqual(
    [...TEMPERAMENTS],
    ["docile", "curious", "playful", "aggressive", "cautious", "aloof", "energetic", "serene"]
  );
});

test("dob validation rejects impossible and future dates", () => {
  const now = new Date("2026-08-29T00:00:00Z");
  assert.equal(isPlausibleDob("1996-01-06", now), true);
  assert.equal(isPlausibleDob("2001-02-30", now), false); //no existe
  assert.equal(isPlausibleDob("1996-1-6", now), false);   //formato
  assert.equal(isPlausibleDob("1899-12-31", now), false); //antes de 1900
  assert.equal(isPlausibleDob("2027-01-01", now), false); //futura
  assert.equal(isPlausibleDob("2000-02-29", now), true);  //bisiesto real
  assert.equal(isPlausibleDob("1900-02-29", now), false); //1900 no es bisiesto
});

test("a genesis species key round-trips to its spirit and element", () => {
  for (const s of SPIRITS) {
    const key = genesisSpeciesKey(s.key, "eléctrico");
    assert.equal(key, `g2_${s.key}_electrico`);
    assert.ok(Hashimons[key], `${key} is not in the emission allowlist`);
  }
});
