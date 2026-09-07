import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { WebhookEventType, type BTCPayWebhookPayload } from "@taloon/btcpay-middleware";
import { applyWebhook } from "@/modules/payments/domain/payments";
import {
  affiliateSummary,
  createSubAffiliate,
  markPaid,
  pendingPayouts,
  resolveAffiliateCode,
  subAffiliatesOf,
  type AffiliateRow,
} from "@/modules/affiliate/domain/affiliates";
import { AppError } from "@/modules/core/http/errors";
import { pool, query } from "@/modules/core/db/pool";

//El devengo va dentro de la transacción de settleAndCredit, así que se prueba
//por donde entra de verdad: un webhook de BTCPay. Probar accrueCommission
//aislada verificaría el INSERT, no la garantía que importa — que una reentrega
//no pague dos veces.

function settledPayload(invoiceId: string, isRedelivery = false): BTCPayWebhookPayload {
  return {
    deliveryId: "delivery-1",
    webhookId: "webhook-1",
    originalDeliveryId: "delivery-1",
    isRedelivery,
    type: WebhookEventType.INVOICE_SETTLED,
    timestamp: 0,
    storeId: "store-1",
    invoiceId,
  };
}

describe("afiliación energética (against the local DB)", () => {
  const playerIds: string[] = [];
  const codes: string[] = [];

  after(async () => {
    //Orden obligatorio: players.referred_by referencia affiliates sin cascade,
    //así que los afiliados sólo se pueden borrar cuando ya no queda quien los cite.
    if (playerIds.length > 0) {
      await query(`DELETE FROM players WHERE id = ANY($1)`, [playerIds]);
    }
    if (codes.length > 0) {
      await query(`DELETE FROM affiliates WHERE code = ANY($1)`, [codes]);
    }
    await pool.end();
  });

  function unique(prefix: string): string {
    return `${prefix}-${process.hrtime.bigint().toString(36)}`;
  }

  async function seedAffiliate(opts: { rateBps?: number; active?: boolean; playerId?: string } = {}) {
    const code = unique("AFF");
    codes.push(code);
    await query(
      `INSERT INTO affiliates (code, btc_address, rate_bps, active, player_id)
       VALUES ($1, 'bc1qtestaddress', $2, $3, $4)`,
      [code, opts.rateBps ?? 1500, opts.active ?? true, opts.playerId ?? null]
    );
    return code;
  }

  /** Un comprador con un cobro de $5 abierto, referido (o no) por `code`. */
  async function seedBuyerWithCharge(code: string | null, amountUsd = "5.00") {
    const invoiceId = unique("test-invoice");
    const player = await query<{ id: string }>(
      `INSERT INTO players (display_name, referred_by, referred_at)
       VALUES ('AffiliateTest', $1, CASE WHEN $1::text IS NULL THEN NULL ELSE now() END)
       RETURNING id`,
      [code]
    );
    const playerId = player.rows[0]!.id;
    playerIds.push(playerId);
    await query(
      `INSERT INTO payments (order_id, player_id, invoice_id, sku, credits, amount_usd)
       VALUES ($1, $2, $3, 'credits_500', 500, $4)`,
      [`credits-${invoiceId}`, playerId, invoiceId, amountUsd]
    );
    return { playerId, invoiceId };
  }

  async function commissionsFor(code: string) {
    const res = await query<{ amount_usd: string; rate_bps: number; status: string }>(
      `SELECT amount_usd, rate_bps, status FROM commissions WHERE code = $1`,
      [code]
    );
    return res.rows;
  }

  it("devenga el 15% cuando el comprador llegó por un afiliado", async () => {
    const code = await seedAffiliate();
    const { invoiceId } = await seedBuyerWithCharge(code);

    await applyWebhook(settledPayload(invoiceId));

    const rows = await commissionsFor(code);
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0]!.amount_usd), 0.75); // 15% de $5.00
    assert.equal(rows[0]!.status, "accrued");
  });

  //La garantía que protege dinero: BTCPay reentrega, y devengar dos veces es
  //regalar comisión. Es el mismo caso que "credits exactly once" en payments.
  it("devenga una sola vez aunque el webhook se reentregue", async () => {
    const code = await seedAffiliate();
    const { invoiceId } = await seedBuyerWithCharge(code);

    await applyWebhook(settledPayload(invoiceId));
    await applyWebhook(settledPayload(invoiceId, true));
    await applyWebhook(settledPayload(invoiceId, true));

    const rows = await commissionsFor(code);
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0]!.amount_usd), 0.75);
  });

  it("no devenga nada cuando el comprador llegó solo", async () => {
    const { invoiceId, playerId } = await seedBuyerWithCharge(null);

    const settled = await applyWebhook(settledPayload(invoiceId));

    //El pago se acredita igual: la ausencia de afiliado no es un error.
    assert.equal(settled?.status, "settled");
    const res = await query<{ credits: number }>(`SELECT credits FROM players WHERE id = $1`, [playerId]);
    assert.equal(res.rows[0]!.credits, 500);
  });

  it("no devenga para un afiliado desactivado", async () => {
    const code = await seedAffiliate({ active: false });
    const { invoiceId } = await seedBuyerWithCharge(code);

    await applyWebhook(settledPayload(invoiceId));

    assert.equal((await commissionsFor(code)).length, 0);
  });

  //Un afiliado que se auto-refiere se estaría dando un 15% de descuento
  //permanente pagado por la casa.
  it("no deja que un afiliado cobre de su propia compra", async () => {
    const code = await seedAffiliate();
    const { playerId, invoiceId } = await seedBuyerWithCharge(code);
    await query(`UPDATE affiliates SET player_id = $1 WHERE code = $2`, [playerId, code]);

    await applyWebhook(settledPayload(invoiceId));

    assert.equal((await commissionsFor(code)).length, 0);
  });

  //Congelar rate_bps es lo que hace que bajar la tasa mañana no revalúe lo que
  //alguien ya ganó — mismo principio que payments congelando sku/credits/amount.
  it("congela la tasa en la comisión: cambiarla después no revalúa lo devengado", async () => {
    const code = await seedAffiliate({ rateBps: 1500 });
    const { invoiceId } = await seedBuyerWithCharge(code);
    await applyWebhook(settledPayload(invoiceId));

    await query(`UPDATE affiliates SET rate_bps = 500 WHERE code = $1`, [code]);

    const rows = await commissionsFor(code);
    assert.equal(rows[0]!.rate_bps, 1500);
    assert.equal(Number(rows[0]!.amount_usd), 0.75);
  });

  it("resuelve el código sin importar cómo lo teclearon, y devuelve el canónico", async () => {
    const code = await seedAffiliate();

    assert.equal(await resolveAffiliateCode(code.toLowerCase()), code);
    assert.equal(await resolveAffiliateCode(`  ${code.toUpperCase()}  `), code);
    assert.equal(await resolveAffiliateCode("no-existe-este-codigo"), null);
    assert.equal(await resolveAffiliateCode(undefined), null);
    assert.equal(await resolveAffiliateCode(""), null);
  });

  it("el corte suma lo pendiente y marcarlo pagado lo saca de la lista", async () => {
    const code = await seedAffiliate();
    const first = await seedBuyerWithCharge(code);
    const second = await seedBuyerWithCharge(code, "20.00");
    await applyWebhook(settledPayload(first.invoiceId));
    await applyWebhook(settledPayload(second.invoiceId));

    const line = (await pendingPayouts()).find((l) => l.code === code);
    assert.equal(line?.commission_count, 2);
    assert.equal(Number(line?.total_usd), 3.75); // 0.75 + 3.00

    const txid = "a".repeat(64);
    const paid = await markPaid(code, txid);
    assert.equal(paid.count, 2);
    assert.equal(paid.totalUsd, "3.75");

    assert.equal((await pendingPayouts()).find((l) => l.code === code), undefined);

    //Correrlo dos veces no re-marca un corte ya pagado.
    assert.equal((await markPaid(code, txid)).count, 0);
  });

  // ─── Dos niveles ───────────────────────────────────────────────────────────

  async function seedRoot(rateBps = 1500): Promise<AffiliateRow> {
    const code = unique("ROOT");
    codes.push(code);
    const res = await query<AffiliateRow>(
      `INSERT INTO affiliates (code, btc_address, rate_bps, can_recruit)
       VALUES ($1, 'bc1qroot', $2, true) RETURNING *`,
      [code, rateBps]
    );
    return res.rows[0]!;
  }

  //El caso central del modelo de introducing broker: una sola compra paga a dos
  //personas, y la suma de las dos es exactamente la tasa del padre.
  it("reparte entre el sub y su padre: el padre cobra el diferencial", async () => {
    const root = await seedRoot(1500);                       // 15%
    const sub = await createSubAffiliate(root, { code: unique("SUB"), rateBps: 1000 }); // 10%
    codes.push(sub.code);

    const { invoiceId } = await seedBuyerWithCharge(sub.code, "20.00");
    await applyWebhook(settledPayload(invoiceId));

    const subRows = await commissionsFor(sub.code);
    const rootRows = await commissionsFor(root.code);

    assert.equal(Number(subRows[0]!.amount_usd), 2.00);   // 10% de 20
    assert.equal(Number(rootRows[0]!.amount_usd), 1.00);  // 15% - 10% = 5% de 20
    //La casa paga exactamente la tasa del padre, ni un céntimo más.
    assert.equal(Number(subRows[0]!.amount_usd) + Number(rootRows[0]!.amount_usd), 3.00);
  });

  it("no duplica el reparto cuando el webhook se reentrega", async () => {
    const root = await seedRoot(1500);
    const sub = await createSubAffiliate(root, { code: unique("SUB"), rateBps: 1000 });
    codes.push(sub.code);

    const { invoiceId } = await seedBuyerWithCharge(sub.code, "20.00");
    await applyWebhook(settledPayload(invoiceId));
    await applyWebhook(settledPayload(invoiceId, true));
    await applyWebhook(settledPayload(invoiceId, true));

    assert.equal((await commissionsFor(sub.code)).length, 1);
    assert.equal((await commissionsFor(root.code)).length, 1);
  });

  //Ceder la tasa entera está permitido — es una decisión de negocio del padre.
  //Lo que no debe pasar es que se escriba una comisión de importe cero.
  it("si el padre cede toda su tasa, no se le escribe una comisión de cero", async () => {
    const root = await seedRoot(1500);
    const sub = await createSubAffiliate(root, { code: unique("SUB"), rateBps: 1500 });
    codes.push(sub.code);

    const { invoiceId } = await seedBuyerWithCharge(sub.code, "20.00");
    await applyWebhook(settledPayload(invoiceId));

    assert.equal(Number((await commissionsFor(sub.code))[0]!.amount_usd), 3.00);
    assert.equal((await commissionsFor(root.code)).length, 0);
  });

  //El trato del sub es con la casa, no con su padre: que desactiven al padre no
  //puede costarle su comisión.
  it("el sub cobra igual aunque su padre esté desactivado", async () => {
    const root = await seedRoot(1500);
    const sub = await createSubAffiliate(root, { code: unique("SUB"), rateBps: 1000 });
    codes.push(sub.code);
    await query(`UPDATE affiliates SET active = false WHERE code = $1`, [root.code]);

    const { invoiceId } = await seedBuyerWithCharge(sub.code, "20.00");
    await applyWebhook(settledPayload(invoiceId));

    assert.equal(Number((await commissionsFor(sub.code))[0]!.amount_usd), 2.00);
    assert.equal((await commissionsFor(root.code)).length, 0);
  });

  it("no deja ceder más tasa de la que uno tiene", async () => {
    const root = await seedRoot(1500);
    await assert.rejects(
      () => createSubAffiliate(root, { code: unique("SUB"), rateBps: 2000 }),
      (err: AppError) => err.code === "rate_above_parent"
    );
  });

  //Lo que mantiene el árbol en dos niveles.
  it("un sub-afiliado no puede reclutar a su vez", async () => {
    const root = await seedRoot(1500);
    const sub = await createSubAffiliate(root, { code: unique("SUB"), rateBps: 1000 });
    codes.push(sub.code);

    await assert.rejects(
      () => createSubAffiliate(sub, { code: unique("SUB2"), rateBps: 500 }),
      (err: AppError) => err.code === "cannot_recruit" || err.code === "depth_limit"
    );
  });

  it("el resumen del portal cuenta altas, compradores y su equipo", async () => {
    const root = await seedRoot(1500);
    const sub = await createSubAffiliate(root, { code: unique("SUB"), rateBps: 1000 });
    codes.push(sub.code);

    //Uno que compra y otro que sólo se registra.
    const buyer = await seedBuyerWithCharge(root.code, "5.00");
    await applyWebhook(settledPayload(buyer.invoiceId));
    await seedBuyerWithCharge(root.code, "5.00"); // sin liquidar

    const summary = (await affiliateSummary(root.code))!;
    assert.equal(summary.signups, 2);
    assert.equal(summary.buyers, 1);
    assert.equal(summary.pendingUsd, "0.75");
    assert.equal(summary.subAffiliates, 1);
    assert.ok(summary.link.includes(`ref=${root.code}`));

    const team = await subAffiliatesOf(root.code);
    assert.equal(team.length, 1);
    assert.equal(team[0]!.code, sub.code);
  });

});
