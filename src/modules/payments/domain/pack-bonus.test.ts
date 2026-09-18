import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { WebhookEventType, type BTCPayWebhookPayload } from "@taloon/btcpay-middleware";
import { pool, query } from "@/modules/core/db/pool";
import { applyWebhook } from "@/modules/payments/domain/payments";
import {
  advanceBonus,
  bonusRoll,
  commitBonus,
  resolveBonus,
  type PackBonusRow,
} from "@/modules/payments/domain/pack-bonus";
import {
  BlockOracleDisagreement,
  BlockOracleUnavailable,
  composeOracle,
  type BlockSource,
} from "@/modules/payments/domain/block-oracle";
import { BONUS_RULES, bonusRulesSpec, rulesVersionSpec, versionOf } from "@/modules/cards/domain/rules-version";

//El bono mueve créditos, así que lo que se protege aquí es dinero: que el piso
//nunca dependa del bono, que el extra se acredite UNA sola vez, que ningún
//explorador caído o mentiroso lo decida, y que la tirada sea la publicada.
//
//Ningún test sale a la red: las fuentes son falsas y controladas.

const GENESIS = "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f";

// Si falla, cambió la tabla del bono: es una versión nueva, no un número que pegar.
const GOLDEN_BONUS = "bonus:685b8a7ba8a84cd1dda88c2f4debf9eb782a57399b1313b2709dbee2d6fd7934";

function fakeHash(seed: number): string {
  return seed.toString(16).padStart(64, "0");
}

interface FakeState {
  tip: number;
  hashes: Map<number, string>;
  failTip?: boolean;
  failHash?: boolean;
}

function fakeSource(name: string, state: FakeState): BlockSource {
  return {
    name,
    async tipHeight() {
      if (state.failTip) { throw new Error(`${name} caído`); }
      return state.tip;
    },
    async hashAt(height) {
      if (state.failHash) { throw new Error(`${name} caído`); }
      if (height > state.tip) { return null; }
      return state.hashes.get(height) ?? null;
    },
    async heightOf() {
      return null;
    },
  };
}

// ── La tirada (pura) ─────────────────────────────────────────────────────────

describe("bono — la tirada", () => {
  //El ejemplo publicado en docs/BONO_VERIFICABLE_V1.md §4. Si esto cambia, el
  //documento miente y cualquiera que verifique con él obtendría otro resultado.
  it("reproduce el ejemplo publicado con el bloque génesis", () => {
    const r = bonusRoll(GENESIS, "credits-00000000-0000-4000-8000-000000000001", 3000);
    assert.equal(r.digest, "125595e39f8dca245b3d6e61ba67eb490a2f72ab88b768a000de7bef82a4353e");
    assert.equal(r.roll, 8819);
    assert.equal(r.pct, 5);
    assert.equal(r.credits, 150);
  });

  it("el extra siempre son marcas enteras y nunca pasa del 15 %", () => {
    for (let i = 0; i < 2000; i++) {
      for (const floor of [500, 1200, 3000]) {
        const r = bonusRoll(fakeHash(i), `order-${i}`, floor);
        assert.equal(r.credits % 10, 0, "múltiplo de 10 créditos");
        assert.ok(r.credits >= 0 && r.credits <= Math.round(floor * 0.15 / 10) * 10);
      }
    }
  });

  it("la distribución es la publicada: 70 / 20 / 8 / 2", () => {
    const n = 40_000;
    const count: Record<number, number> = { 0: 0, 5: 0, 10: 0, 15: 0 };
    for (let i = 0; i < n; i++) { count[bonusRoll(GENESIS, `o${i}`, 3000).pct]! += 1; }
    const share = (pct: number) => count[pct]! / n;
    assert.ok(Math.abs(share(0) - 0.70) < 0.01);
    assert.ok(Math.abs(share(5) - 0.20) < 0.01);
    assert.ok(Math.abs(share(10) - 0.08) < 0.006);
    assert.ok(Math.abs(share(15) - 0.02) < 0.004);
  });

  it("la tabla vigente es la publicada (golden) y cambiarla cambia la versión", () => {
    assert.equal(BONUS_RULES.version, GOLDEN_BONUS);
    const richer = [{ upto: 6000, pct: 0 }, { upto: 9000, pct: 5 }, { upto: 9800, pct: 10 }, { upto: 10000, pct: 15 }];
    assert.notEqual(versionOf("bonus", bonusRulesSpec(richer)), BONUS_RULES.version);
  });
});

// ── El oráculo (puro) ────────────────────────────────────────────────────────

describe("bono — el oráculo de bloques", () => {
  const H = fakeHash(0xabc);

  it("exige al menos dos fuentes obligatorias", () => {
    assert.throws(() => composeOracle({ required: [fakeSource("a", { tip: 1, hashes: new Map() })] }));
  });

  //Una fuente atrasada no debe hacer comprometer un bloque que otra ya conoce: se
  //compromete sobre la punta MÁS ALTA, y se confirma sobre la MÁS BAJA.
  it("compromete sobre la punta más alta y confirma sobre la más baja", async () => {
    const oracle = composeOracle(
      {
        required: [fakeSource("a", { tip: 100, hashes: new Map() }), fakeSource("b", { tip: 98, hashes: new Map() })],
        optional: [fakeSource("nodo", { tip: 101, hashes: new Map() })],
      },
      { tipTtlMs: 0 }
    );
    assert.deepEqual(await oracle.tips(), { commitTip: 101, confirmedTip: 98 });
  });

  it("un explorador caído deja el bono sin decidir", async () => {
    const oracle = composeOracle(
      {
        required: [fakeSource("a", { tip: 100, hashes: new Map() }), fakeSource("b", { tip: 100, hashes: new Map(), failTip: true })],
      },
      { tipTtlMs: 0 }
    );
    await assert.rejects(() => oracle.tips(), BlockOracleUnavailable);
  });

  it("si los exploradores discrepan, no hay hash", async () => {
    const oracle = composeOracle(
      {
        required: [
          fakeSource("a", { tip: 10, hashes: new Map([[5, H]]) }),
          fakeSource("b", { tip: 10, hashes: new Map([[5, fakeHash(0xdef)]]) }),
        ],
      },
      { tipTtlMs: 0 }
    );
    await assert.rejects(() => oracle.hashAt(5), BlockOracleDisagreement);
  });

  it("el nodo bloquea si discrepa, pero no si está caído o atrasado", async () => {
    const both = (nodo: FakeState) =>
      composeOracle(
        {
          required: [fakeSource("a", { tip: 10, hashes: new Map([[5, H]]) }), fakeSource("b", { tip: 10, hashes: new Map([[5, H]]) })],
          optional: [fakeSource("nodo", nodo)],
        },
        { tipTtlMs: 0 }
      );
    await assert.rejects(() => both({ tip: 10, hashes: new Map([[5, fakeHash(1)]]) }).hashAt(5), BlockOracleDisagreement);
    assert.equal(await both({ tip: 10, hashes: new Map(), failHash: true }).hashAt(5), H);
    assert.equal(await both({ tip: 3, hashes: new Map() }).hashAt(5), H);
  });

  it("una altura que aún no existe no da hash", async () => {
    const oracle = composeOracle(
      { required: [fakeSource("a", { tip: 4, hashes: new Map() }), fakeSource("b", { tip: 10, hashes: new Map([[5, H]]) })] },
      { tipTtlMs: 0 }
    );
    assert.equal(await oracle.hashAt(5), null);
  });
});

// ── El flujo con dinero (against the local DB) ───────────────────────────────

describe("bono — liquidación, compromiso y resolución (against the local DB)", () => {
  const playerIds: string[] = [];

  after(async () => {
    if (playerIds.length > 0) {
      await query(`DELETE FROM players WHERE id = ANY($1)`, [playerIds]);
    }
    await pool.end();
  });

  function settled(invoiceId: string, isRedelivery = false): BTCPayWebhookPayload {
    return {
      deliveryId: "d", webhookId: "w", originalDeliveryId: "d", isRedelivery,
      type: WebhookEventType.INVOICE_SETTLED, timestamp: 0, storeId: "s", invoiceId,
    };
  }

  /** Un jugador con un paquete de 3.000 créditos ya liquidado por el webhook real. */
  async function settledPurchase(): Promise<{ playerId: string; orderId: string }> {
    const invoiceId = `bonus-test-${process.hrtime.bigint().toString(36)}`;
    const player = await query<{ id: string }>(`INSERT INTO players (display_name) VALUES ('BonusTest') RETURNING id`);
    const playerId = player.rows[0]!.id;
    playerIds.push(playerId);
    const orderId = `credits-${invoiceId}`;
    await query(
      `INSERT INTO payments (order_id, player_id, invoice_id, sku, credits, amount_usd)
       VALUES ($1, $2, $3, 'credits_3000', 3000, 25.00)`,
      [orderId, playerId, invoiceId]
    );
    await applyWebhook(settled(invoiceId));
    return { playerId, orderId };
  }

  async function row(orderId: string): Promise<PackBonusRow> {
    return (await query<PackBonusRow>(`SELECT * FROM pack_bonuses WHERE order_id = $1`, [orderId])).rows[0]!;
  }

  async function creditsOf(playerId: string): Promise<number> {
    return (await query<{ credits: number }>(`SELECT credits FROM players WHERE id = $1`, [playerId])).rows[0]!.credits;
  }

  /** Un hash de bloque cuya tirada, para este order_id, cae en el tramo pedido. */
  function hashGiving(orderId: string, wantPositive: boolean): string {
    for (let i = 1; ; i++) {
      const h = fakeHash(i * 7919);
      const pct = bonusRoll(h, orderId, 3000).pct;
      if ((pct > 0) === wantPositive) { return h; }
    }
  }

  function chain(tip: number, hashes: Map<number, string>, nodo?: FakeState) {
    const a: FakeState = { tip, hashes };
    const b: FakeState = { tip, hashes };
    return {
      a, b,
      oracle: composeOracle(
        { required: [fakeSource("a", a), fakeSource("b", b)], optional: nodo ? [fakeSource("nodo", nodo)] : [] },
        { tipTtlMs: 0 }
      ),
    };
  }

  //LA REGLA DE ORO: el piso llega en la liquidación, sin esperar a ningún bloque.
  it("la liquidación acredita el piso y deja el bono pendiente", async () => {
    const { playerId, orderId } = await settledPurchase();
    assert.equal(await creditsOf(playerId), 3000, "el piso ya está pagado");
    const b = await row(orderId);
    assert.equal(b.status, "pending");
    assert.equal(Number(b.floor_credits), 3000);
    assert.equal(b.rules_version, BONUS_RULES.version);
    assert.deepEqual(await rulesVersionSpec(b.rules_version), BONUS_RULES.spec, "la tabla quedó publicada");
  });

  it("una reentrega del webhook no crea un segundo bono", async () => {
    const { orderId } = await settledPurchase();
    const invoiceId = orderId.replace(/^credits-/, "");
    await applyWebhook(settled(invoiceId, true));
    const n = await query(`SELECT 1 FROM pack_bonuses WHERE order_id = $1`, [orderId]);
    assert.equal(n.rowCount, 1);
  });

  //Si la altura se pudiera volver a fijar, se podría esperar a un bloque favorable.
  it("la altura se compromete UNA vez, sobre la punta más alta", async () => {
    const { orderId } = await settledPurchase();
    const c = chain(900, new Map());
    const committed = await commitBonus(orderId, c.oracle);
    assert.equal(committed!.target_height, 901);

    c.a.tip = 950; c.b.tip = 950;
    assert.equal(await commitBonus(orderId, c.oracle), null, "no se recompromete");
    assert.equal((await row(orderId)).target_height, 901);
  });

  it("no se resuelve sin 3 confirmaciones", async () => {
    const { playerId, orderId } = await settledPurchase();
    const c = chain(500, new Map());
    await commitBonus(orderId, c.oracle); // target 501
    c.a.tip = 502; c.b.tip = 502;         // 2 confirmaciones
    c.a.hashes.set(501, hashGiving(orderId, true));
    assert.equal(await resolveBonus(await row(orderId), c.oracle), null);
    assert.equal(await creditsOf(playerId), 3000);
  });

  it("con 3 confirmaciones acredita el extra exacto de la tirada", async () => {
    const { playerId, orderId } = await settledPurchase();
    const c = chain(700, new Map());
    await commitBonus(orderId, c.oracle); // target 701
    const h = hashGiving(orderId, true);
    c.a.hashes.set(701, h);
    c.a.tip = 703; c.b.tip = 703;

    const resolved = await resolveBonus(await row(orderId), c.oracle);
    const expected = bonusRoll(h, orderId, 3000);
    assert.equal(resolved!.status, "resolved");
    assert.equal(resolved!.block_hash, h);
    assert.equal(resolved!.roll, expected.roll);
    assert.equal(Number(resolved!.bonus_credits), expected.credits);
    assert.ok(expected.credits > 0);
    assert.equal(await creditsOf(playerId), 3000 + expected.credits);

    const audit = await query(
      `SELECT 1 FROM audit_log WHERE player_id = $1 AND action = 'credits.pack_bonus'`,
      [playerId]
    );
    assert.equal(audit.rowCount, 1);
  });

  //LA GARANTÍA DEL DINERO: dos lecturas simultáneas calculan lo mismo, pero sólo una acredita.
  it("dos resoluciones simultáneas acreditan el extra una sola vez", async () => {
    const { playerId, orderId } = await settledPurchase();
    const c = chain(300, new Map());
    await commitBonus(orderId, c.oracle); // target 301
    const h = hashGiving(orderId, true);
    c.a.hashes.set(301, h);
    c.a.tip = 303; c.b.tip = 303;

    const committed = await row(orderId);
    const results = await Promise.all([resolveBonus(committed, c.oracle), resolveBonus(committed, c.oracle)]);
    assert.equal(results.filter(Boolean).length, 1, "sólo una resolución gana");
    assert.equal(await creditsOf(playerId), 3000 + bonusRoll(h, orderId, 3000).credits);
  });

  it("un +0 % también se resuelve y se audita, sin tocar créditos", async () => {
    const { playerId, orderId } = await settledPurchase();
    const c = chain(400, new Map());
    await commitBonus(orderId, c.oracle);
    c.a.hashes.set(401, hashGiving(orderId, false));
    c.a.tip = 403; c.b.tip = 403;

    const resolved = await resolveBonus(await row(orderId), c.oracle);
    assert.equal(resolved!.status, "resolved");
    assert.equal(Number(resolved!.bonus_credits), 0);
    assert.equal(await creditsOf(playerId), 3000);
    const audit = await query(`SELECT 1 FROM audit_log WHERE player_id = $1 AND action = 'credits.pack_bonus'`, [playerId]);
    assert.equal(audit.rowCount, 1, "un auditor ve también las tiradas sin premio");
  });

  it("si los exploradores discrepan, el bono espera y no se acredita nada", async () => {
    const { playerId, orderId } = await settledPurchase();
    const a: FakeState = { tip: 600, hashes: new Map() };
    const b: FakeState = { tip: 600, hashes: new Map() };
    const oracle = composeOracle({ required: [fakeSource("a", a), fakeSource("b", b)] }, { tipTtlMs: 0 });
    await advanceBonus(orderId, oracle); // compromete 601
    a.hashes.set(601, fakeHash(1)); b.hashes.set(601, fakeHash(2));
    a.tip = 603; b.tip = 603;

    const after = await advanceBonus(orderId, oracle);
    assert.equal(after!.status, "committed");
    assert.equal(await creditsOf(playerId), 3000);
  });

  it("con un explorador caído el bono sigue pendiente y el piso intacto", async () => {
    const { playerId, orderId } = await settledPurchase();
    const oracle = composeOracle(
      { required: [fakeSource("a", { tip: 10, hashes: new Map() }), fakeSource("b", { tip: 10, hashes: new Map(), failTip: true })] },
      { tipTtlMs: 0 }
    );
    const after = await advanceBonus(orderId, oracle);
    assert.equal(after!.status, "pending");
    assert.equal(await creditsOf(playerId), 3000);
  });

  it("un nodo caído no retiene un bono que dos exploradores confirman", async () => {
    const { playerId, orderId } = await settledPurchase();
    const nodo: FakeState = { tip: 0, hashes: new Map(), failTip: true, failHash: true };
    const c = chain(800, new Map(), nodo);
    await advanceBonus(orderId, c.oracle); // compromete 801
    const h = hashGiving(orderId, true);
    c.a.hashes.set(801, h);
    c.a.tip = 803; c.b.tip = 803;

    const after = await advanceBonus(orderId, c.oracle);
    assert.equal(after!.status, "resolved");
    assert.equal(await creditsOf(playerId), 3000 + bonusRoll(h, orderId, 3000).credits);
  });
});
