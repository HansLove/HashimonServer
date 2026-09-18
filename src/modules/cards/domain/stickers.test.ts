import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { sha256 } from "@/modules/core/core/sha256";
import { pool, query, withTransaction } from "@/modules/core/db/pool";
import { FOODS } from "@/modules/mining/domain/foods";
import { MATURATION_BANDS } from "@/modules/cards/data/maturation";
import { MATURATION_RULES } from "@/modules/cards/domain/rules-version";
import {
  advanceCocoon,
  cocoonsFor,
  matureCocoon,
  maturedItem,
  mintFromMark,
  sealedHashOf,
  stickerOf,
  type CocoonRow,
} from "@/modules/cards/domain/stickers";
import { composeOracle, type BlockSource } from "@/modules/payments/domain/block-oracle";
import type { YieldTier } from "@/modules/core/core/pow";

//Estampas que maduran (docs/ESTAMPAS_V1.md §4.5). Lo que se protege: que las
//probabilidades publicadas no cambien por madurar, que un capullo madure UNA vez y
//con el bloque h (el siguiente al que se minó la marca), y que ningún explorador
//caído o mentiroso decida nada. Ninguna fuente sale a la red.

const GENESIS = "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f";

//Si falla, cambió qué madura o cómo: es una versión nueva, no un número que pegar.
const GOLDEN_MATURATION = "maturation:73de5752d04cf11e2247513ed646b214982414a0f1049d13f6937e78d02bdaa0";

const TIERS: YieldTier[] = ["consumable", "durable", "capital"];

// ── Las reglas (puro) ────────────────────────────────────────────────────────

describe("estampas — las bandas", () => {
  it("la versión de maduración vigente es la publicada (golden)", () => {
    assert.equal(MATURATION_RULES.version, GOLDEN_MATURATION);
  });

  it("el mutágeno madura entero", () => {
    const capital = FOODS.filter((f) => f.tier === "capital").map((f) => f.key).sort();
    assert.deepEqual([...MATURATION_BANDS.capital].sort(), capital);
  });

  it("cada banda fuera del mutágeno contiene una épica, y algo más con qué dudar", () => {
    for (const tier of ["consumable", "durable"] as const) {
      const band = FOODS.filter((f) => f.tier === tier && MATURATION_BANDS[tier].includes(f.key));
      if (band.length === 0) { continue; }
      assert.ok(band.some((f) => f.weight <= 2), `${tier}: la banda no tiene épica`);
      //Una banda de un solo ítem haría que el bloque no decidiera nada: espera de teatro.
      assert.ok(band.length >= 2, `${tier}: una banda de un ítem no deja nada que decidir`);
    }
  });

  it("toda clave de banda existe en el catálogo y en su tier", () => {
    for (const tier of TIERS) {
      for (const key of MATURATION_BANDS[tier]) {
        const food = FOODS.find((f) => f.key === key);
        assert.ok(food, `${key} no está en foods.ts`);
        assert.equal(food!.tier, tier);
      }
    }
  });
});

describe("estampas — la tirada (puro)", () => {
  //El ejemplo que cualquiera puede rehacer con el bloque génesis y sha256.
  it("reproduce el ejemplo del capullo con el bloque génesis", () => {
    const mark = sha256("estampa-18");
    assert.equal(stickerOf(mark).tier, "capital");
    assert.equal(stickerOf(mark).maturing, true);
    const sealed = sealedHashOf(mark, GENESIS);
    assert.equal(sealed, "881d589caff95d44690864faeac2582e9c0312b61dab78df884e341fe2df321d");
    assert.equal(maturedItem("capital", sealed).key, "roca_mutagena");
  });

  it("una marca común no madura y su ítem sale al instante", () => {
    const r = stickerOf(sha256("estampa-0"));
    assert.equal(r.maturing, false);
    assert.equal(r.item.key, "croqueta_basica");
  });

  it("madurar no cambia las probabilidades publicadas", () => {
    //Dos etapas (¿cae en la banda? + ¿cuál dentro de la banda?) tienen que dar lo mismo
    //que la tirada de una etapa. Se mide con hashes y bloques de verdad (sha256), no con
    //Math.random, porque eso es lo que va a pasar en producción.
    const N = 120_000;
    const counts = new Map<string, number>();
    const tierCount: Record<YieldTier, number> = { consumable: 0, durable: 0, capital: 0 };
    for (let i = 0; i < N; i++) {
      const mark = sha256(`odds-${i}`);
      const r = stickerOf(mark);
      const item = r.maturing ? maturedItem(r.tier, sealedHashOf(mark, sha256(`block-${i % 97}`))) : r.item;
      tierCount[r.tier] += 1;
      counts.set(item.key, (counts.get(item.key) ?? 0) + 1);
    }
    for (const tier of TIERS) {
      const pool = FOODS.filter((f) => f.tier === tier);
      const total = pool.reduce((s, f) => s + f.weight, 0);
      for (const f of pool) {
        const expected = tierCount[tier] * (f.weight / total);
        const got = counts.get(f.key) ?? 0;
        //5 desviaciones típicas: un fallo aquí es un sesgo, no mala suerte.
        const sd = Math.sqrt(expected * (1 - f.weight / total));
        assert.ok(Math.abs(got - expected) <= 5 * sd + 1, `${f.key}: ${got} vs ${expected.toFixed(1)} esperadas`);
      }
    }
  });
});

// ── El ciclo completo (against the local DB) ─────────────────────────────────

interface FakeChain {
  tip: number;
  byHeight: Map<number, string>;
  down?: boolean;
}

function fakeSource(name: string, chain: FakeChain): BlockSource {
  return {
    name,
    async tipHeight() {
      if (chain.down) { throw new Error(`${name} caído`); }
      return chain.tip;
    },
    async hashAt(height) {
      if (chain.down) { throw new Error(`${name} caído`); }
      if (height > chain.tip) { return null; }
      return chain.byHeight.get(height) ?? null;
    },
    async heightOf(blockHash) {
      if (chain.down) { throw new Error(`${name} caído`); }
      for (const [h, hash] of chain.byHeight) {
        if (hash === blockHash.toLowerCase() && h <= chain.tip) { return h; }
      }
      return null;
    },
  };
}

function chainWith(prevHash: string, prevHeight: number): FakeChain {
  return { tip: prevHeight, byHeight: new Map([[prevHeight, prevHash]]) };
}

describe("estampas — maduración (against the local DB)", () => {
  const playerIds: string[] = [];
  const markHashes: string[] = [];
  //Salado por ejecución: cards.hash y sticker_cocoons.mark_hash son claves globales.
  const salt = randomBytes(6).toString("hex");
  let seq = 0;

  after(async () => {
    if (markHashes.length > 0) {
      await query(`DELETE FROM sticker_cocoons WHERE mark_hash = ANY($1)`, [markHashes]);
      await query(`DELETE FROM cards WHERE hash = ANY($1)`, [markHashes]);
    }
    if (playerIds.length > 0) {
      await query(`DELETE FROM players WHERE id = ANY($1)`, [playerIds]);
    }
    await pool.end();
  });

  const creatureOf = new Map<string, string>();

  async function seedPlayer(): Promise<string> {
    const res = await query<{ id: string }>(`INSERT INTO players (display_name) VALUES ('StickersTest') RETURNING id`);
    const id = res.rows[0]!.id;
    playerIds.push(id);
    //La despensa es por criatura (pow_yield.hashimon_id), así que cada jugador lleva una.
    const creature = await query<{ id: string }>(
      `INSERT INTO hashimons (owner_id, dna, species_key, template_id, birth_nonce, algo_version)
       VALUES ($1, $2, 'test-species', 'test-template', 'nonce', 'caos-core@2') RETURNING id`,
      [id, sha256(`dna-${salt}-${id}`)]
    );
    creatureOf.set(id, creature.rows[0]!.id);
    return id;
  }

  /** Una marca cuya tirada instantánea madura (o no), buscada, no inventada. */
  function markThat(maturing: boolean, tier?: YieldTier): string {
    for (;;) {
      const h = sha256(`mark-${salt}-${seq++}`);
      const r = stickerOf(h);
      if (r.maturing === maturing && (!tier || r.tier === tier)) {
        markHashes.push(h);
        return h;
      }
    }
  }

  async function mint(ownerId: string, hash: string, prevHash: string) {
    return withTransaction((client) =>
      mintFromMark(client, {
        hash,
        ownerId,
        hashimonId: creatureOf.get(ownerId)!,
        prevHash,
        bits: 48,
        nonce: 7,
        place: "incubation:test",
      })
    );
  }

  async function cocoon(hash: string): Promise<CocoonRow | null> {
    const res = await query<CocoonRow>(`SELECT * FROM sticker_cocoons WHERE mark_hash = $1`, [hash]);
    return res.rows[0] ?? null;
  }

  async function pantryOf(hash: string) {
    const res = await query<{ tier: string; food_key: string | null; place: string }>(
      `SELECT tier, food_key, place FROM pow_yield WHERE hash = $1`,
      [hash]
    );
    return res.rows[0] ?? null;
  }

  async function cardOf(hash: string) {
    const res = await query<{ item_key: string; matured_with: string | null; rules_version: string }>(
      `SELECT item_key, matured_with, rules_version FROM cards WHERE hash = $1`,
      [hash]
    );
    return res.rows[0] ?? null;
  }

  it("una marca común da su estampa al instante, sin capullo", async () => {
    const owner = await seedPlayer();
    const mark = markThat(false);
    await mint(owner, mark, sha256(`prev-${salt}-a`));
    const card = await cardOf(mark);
    assert.ok(card);
    assert.equal(card.item_key, stickerOf(mark).item.key);
    assert.equal(card.matured_with, null);
    assert.equal(await cocoon(mark), null);
    //La despensa recibe lo mismo que dice la estampa, no una croqueta fija.
    const pantry = await pantryOf(mark);
    assert.equal(pantry?.tier, stickerOf(mark).tier);
    assert.equal(pantry?.food_key, card.item_key);
    assert.equal(pantry?.place, "incubation:test");
  });

  it("una marca de la banda deja un capullo y ninguna carta todavía", async () => {
    const owner = await seedPlayer();
    const mark = markThat(true, "capital");
    await mint(owner, mark, sha256(`prev-${salt}-b`));
    assert.equal(await cardOf(mark), null);
    //Hasta madurar no se sabe qué es: la despensa espera.
    assert.equal(await pantryOf(mark), null);
    const row = await cocoon(mark);
    assert.equal(row?.status, "cocoon");
    assert.equal(row?.tier, "capital");
    assert.equal(row?.rules_version, MATURATION_RULES.version);
    //Reentregar la marca no crea otro capullo.
    await mint(owner, mark, sha256(`prev-${salt}-b`));
    const count = await query(`SELECT 1 FROM sticker_cocoons WHERE mark_hash = $1`, [mark]);
    assert.equal(count.rows.length, 1);
  });

  it("madura con el bloque h = altura(prevHash) + 1, y sólo cuando ese bloque existe", async () => {
    const owner = await seedPlayer();
    const prev = sha256(`prev-${salt}-c`);
    const mark = markThat(true);
    await mint(owner, mark, prev);

    const chain = chainWith(prev, 900_000);
    const oracle = composeOracle({ required: [fakeSource("a", chain), fakeSource("b", chain)] }, { tipTtlMs: 0 });

    //El bloque h todavía no existe: el capullo sigue cerrado.
    assert.equal(await matureCocoon((await cocoon(mark))!, oracle), null);
    assert.equal((await cocoon(mark))!.status, "cocoon");

    const blockH = sha256(`block-${salt}-c`);
    chain.byHeight.set(900_001, blockH);
    chain.tip = 900_001;
    const matured = await matureCocoon((await cocoon(mark))!, oracle);
    assert.equal(matured?.status, "matured");
    assert.equal(matured?.target_height, 900_001);
    assert.equal(matured?.block_hash, blockH);

    //La carta dice con qué bloque y con qué reglas nació, y el ítem es el recalculable.
    const expected = maturedItem(stickerOf(mark).tier, sealedHashOf(mark, blockH)).key;
    const card = await cardOf(mark);
    assert.equal(card?.item_key, expected);
    assert.equal(card?.matured_with, blockH);
    assert.equal(card?.rules_version, MATURATION_RULES.version);
    assert.ok(MATURATION_BANDS[stickerOf(mark).tier].includes(card!.item_key));
    //Y la despensa recibe lo que el bloque decidió.
    const pantry = await pantryOf(mark);
    assert.equal(pantry?.food_key, expected);
    assert.equal(pantry?.tier, stickerOf(mark).tier);
  });

  it("dos lectores a la vez maduran el capullo una sola vez", async () => {
    const owner = await seedPlayer();
    const prev = sha256(`prev-${salt}-d`);
    const mark = markThat(true);
    await mint(owner, mark, prev);
    const chain = chainWith(prev, 800_000);
    chain.byHeight.set(800_001, sha256(`block-${salt}-d`));
    chain.tip = 800_001;
    const oracle = composeOracle({ required: [fakeSource("a", chain), fakeSource("b", chain)] }, { tipTtlMs: 0 });

    const row = (await cocoon(mark))!;
    const results = await Promise.all([matureCocoon(row, oracle), matureCocoon(row, oracle), matureCocoon(row, oracle)]);
    assert.equal(results.filter((r) => r !== null).length, 1);
    const cards = await query(`SELECT 1 FROM cards WHERE hash = $1`, [mark]);
    assert.equal(cards.rows.length, 1);
    const audits = await query(
      `SELECT 1 FROM audit_log WHERE action = 'sticker.matured' AND detail->>'markHash' = $1`,
      [mark]
    );
    assert.equal(audits.rows.length, 1);
  });

  it("si los exploradores no conocen el bloque de la marca, no se inventa nada", async () => {
    const owner = await seedPlayer();
    const mark = markThat(true);
    await mint(owner, mark, sha256(`prev-${salt}-huerfano`));
    const chain: FakeChain = { tip: 700_010, byHeight: new Map() };
    const oracle = composeOracle({ required: [fakeSource("a", chain), fakeSource("b", chain)] }, { tipTtlMs: 0 });
    assert.equal(await matureCocoon((await cocoon(mark))!, oracle), null);
    assert.equal(await cardOf(mark), null);
  });

  it("exploradores que discrepan o caídos dejan el capullo cerrado, sin error", async () => {
    const owner = await seedPlayer();
    const prev = sha256(`prev-${salt}-e`);
    const mark = markThat(true);
    await mint(owner, mark, prev);

    const a = chainWith(prev, 600_000);
    const b = chainWith(prev, 600_000);
    a.byHeight.set(600_001, sha256(`block-${salt}-e-a`));
    b.byHeight.set(600_001, sha256(`block-${salt}-e-b`));
    a.tip = b.tip = 600_001;
    const liar = composeOracle({ required: [fakeSource("a", a), fakeSource("b", b)] }, { tipTtlMs: 0 });
    assert.equal((await advanceCocoon(mark, liar))?.status, "cocoon");

    const down: FakeChain = { ...chainWith(prev, 600_000), down: true };
    const dead = composeOracle({ required: [fakeSource("a", down), fakeSource("b", a)] }, { tipTtlMs: 0 });
    assert.equal((await advanceCocoon(mark, dead))?.status, "cocoon");
    assert.equal(await cardOf(mark), null);
  });

  it("leer los capullos de un jugador madura los que ya tienen bloque", async () => {
    const owner = await seedPlayer();
    const prev = sha256(`prev-${salt}-f`);
    const ready = markThat(true);
    const waiting = markThat(true);
    await mint(owner, ready, prev);
    await mint(owner, waiting, sha256(`prev-${salt}-f-futuro`));

    const chain = chainWith(prev, 500_000);
    chain.byHeight.set(500_001, sha256(`block-${salt}-f`));
    chain.tip = 500_001;
    const oracle = composeOracle({ required: [fakeSource("a", chain), fakeSource("b", chain)] }, { tipTtlMs: 0 });

    const rows = await cocoonsFor(owner, oracle);
    const byMark = new Map(rows.map((r) => [r.mark_hash, r.status]));
    assert.equal(byMark.get(ready), "matured");
    assert.equal(byMark.get(waiting), "cocoon");
  });
});
