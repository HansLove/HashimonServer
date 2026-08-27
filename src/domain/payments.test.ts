import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { WebhookEventType, type BTCPayWebhookPayload } from "@taloon/btcpay-middleware";
import {
  activePaymentFor,
  applyWebhook,
  cancelPayment,
  onChainMethod,
  statusForWebhookEvent,
} from "@/domain/payments";
import { pool, query } from "@/db/pool";
import { AppError } from "@/http/errors";

function webhookPayload(
  type: BTCPayWebhookPayload["type"],
  invoiceId: string,
  isRedelivery = false
): BTCPayWebhookPayload {
  return {
    deliveryId: "delivery-1",
    webhookId: "webhook-1",
    originalDeliveryId: "delivery-1",
    isRedelivery,
    type,
    timestamp: 0,
    storeId: "store-1",
    invoiceId,
  };
}

describe("webhook event mapping", () => {
  it("maps every invoice event BTCPay can send", () => {
    assert.equal(statusForWebhookEvent(WebhookEventType.INVOICE_RECEIVED_PAYMENT), "confirming");
    assert.equal(statusForWebhookEvent(WebhookEventType.INVOICE_PROCESSING), "confirming");
    assert.equal(statusForWebhookEvent(WebhookEventType.INVOICE_SETTLED), "settled");
    assert.equal(statusForWebhookEvent(WebhookEventType.INVOICE_EXPIRED), "expired");
    assert.equal(statusForWebhookEvent(WebhookEventType.INVOICE_INVALID), "failed");
  });

  // Not oversights: the row is already `waiting` when InvoiceCreated arrives, and
  // InvoicePaymentSettled reports one payment of possibly several, which says nothing
  // about the invoice as a whole. Both must leave the ledger alone.
  it("treats InvoiceCreated and InvoicePaymentSettled as non-transitions", () => {
    assert.equal(statusForWebhookEvent(WebhookEventType.INVOICE_CREATED), null);
    assert.equal(statusForWebhookEvent(WebhookEventType.INVOICE_PAYMENT_SETTLED), null);
  });

  it("ignores payout events, which belong to another webhook", () => {
    assert.equal(statusForWebhookEvent(WebhookEventType.PAYOUT_CREATED), null);
    assert.equal(statusForWebhookEvent(WebhookEventType.PAYOUT_APPROVED), null);
    assert.equal(statusForWebhookEvent(WebhookEventType.PAYOUT_UPDATED), null);
  });
});

describe("payment method selection", () => {
  function method(paymentMethodId: string, paymentLink: string | null) {
    return { paymentMethodId, paymentLink, currency: "BTC", destination: "d", amount: "1", due: "1", rate: "1", activated: true };
  }

  it("picks the on-chain method under either Greenfield naming", () => {
    const chain = method("BTC-CHAIN", "bitcoin:bc1q…");
    assert.equal(onChainMethod([method("BTC-LN", "lightning:lnbc1…"), chain]), chain);
    const legacy = method("BTC", "bitcoin:bc1q…");
    assert.equal(onChainMethod([legacy, method("BTC-LightningNetwork", "lightning:lnbc1…")]), legacy);
  });

  // The dangerous case: a `?? methods[0]` fallback here would put a bolt11 invoice in
  // `address` and a lightning: URI in `bip21`, which the client renders as an on-chain QR.
  // Returning nothing leaves checkout_link to carry the payment instead.
  it("returns nothing rather than a Lightning method when there is no on-chain one", () => {
    assert.equal(onChainMethod([method("BTC-LN", "lightning:lnbc1…")]), undefined);
    assert.equal(onChainMethod([]), undefined);
  });
});

describe("webhook application (against the local DB)", () => {
  const playerIds: string[] = [];

  after(async () => {
    if (playerIds.length > 0) {
      // payments cascade with the player row.
      await query(`DELETE FROM players WHERE id = ANY($1)`, [playerIds]);
    }
    await pool.end();
  });

  function uniqueInvoiceId(): string {
    return `test-invoice-${process.hrtime.bigint().toString(36)}`;
  }

  async function seedWaitingCharge(invoiceId: string, credits = 500): Promise<string> {
    const player = await query<{ id: string }>(
      `INSERT INTO players (display_name) VALUES ('PaymentsTest') RETURNING id`
    );
    const playerId = player.rows[0]!.id;
    playerIds.push(playerId);
    await query(
      `INSERT INTO payments (order_id, player_id, invoice_id, sku, credits, amount_usd)
       VALUES ($1, $2, $3, 'credits_500', $4, 5.00)`,
      [`credits-${invoiceId}`, playerId, invoiceId, credits]
    );
    return playerId;
  }

  async function creditsOf(playerId: string): Promise<number> {
    const res = await query<{ credits: number }>(`SELECT credits FROM players WHERE id = $1`, [playerId]);
    return res.rows[0]!.credits;
  }

  // The one that matters: BTCPay redelivers, and crediting twice would be a silent gift.
  it("credits exactly once however often InvoiceSettled is redelivered", async () => {
    const invoiceId = uniqueInvoiceId();
    const playerId = await seedWaitingCharge(invoiceId);

    const settled = await applyWebhook(webhookPayload(WebhookEventType.INVOICE_SETTLED, invoiceId));
    assert.equal(settled?.status, "settled");
    assert.equal(await creditsOf(playerId), 500);

    const redelivered = await applyWebhook(webhookPayload(WebhookEventType.INVOICE_SETTLED, invoiceId, true));
    assert.equal(redelivered, null);
    assert.equal(await creditsOf(playerId), 500);
  });

  it("never walks a settled charge backwards when a late InvoiceProcessing lands", async () => {
    const invoiceId = uniqueInvoiceId();
    const playerId = await seedWaitingCharge(invoiceId);
    await applyWebhook(webhookPayload(WebhookEventType.INVOICE_SETTLED, invoiceId));

    assert.equal(await applyWebhook(webhookPayload(WebhookEventType.INVOICE_PROCESSING, invoiceId)), null);

    const row = await query<{ status: string }>(`SELECT status FROM payments WHERE invoice_id = $1`, [invoiceId]);
    assert.equal(row.rows[0]?.status, "settled");
    assert.equal(await creditsOf(playerId), 500);
  });

  it("moves a waiting charge to confirming, and grants nothing yet", async () => {
    const invoiceId = uniqueInvoiceId();
    const playerId = await seedWaitingCharge(invoiceId);

    const confirming = await applyWebhook(
      webhookPayload(WebhookEventType.INVOICE_RECEIVED_PAYMENT, invoiceId)
    );
    assert.equal(confirming?.status, "confirming");
    assert.equal(await creditsOf(playerId), 0);
  });

  // Cancelling a charge BTCPay is already collecting is a mistake every time: refusing
  // it is a safety net the modal copy cannot be.
  it("refuses to cancel a charge that is already confirming", async () => {
    const invoiceId = uniqueInvoiceId();
    const playerId = await seedWaitingCharge(invoiceId);
    await applyWebhook(webhookPayload(WebhookEventType.INVOICE_RECEIVED_PAYMENT, invoiceId));

    await assert.rejects(
      cancelPayment(`credits-${invoiceId}`, playerId),
      (err: unknown) => err instanceof AppError && err.code === "payment_in_flight"
    );

    const row = await query<{ status: string }>(`SELECT status FROM payments WHERE invoice_id = $1`, [invoiceId]);
    assert.equal(row.rows[0]?.status, "confirming");
  });

  // The last net: bookkeeping must never be the reason real money goes uncredited.
  it("still credits a cancelled charge if the coins land anyway", async () => {
    const invoiceId = uniqueInvoiceId();
    const playerId = await seedWaitingCharge(invoiceId);

    const cancelled = await cancelPayment(`credits-${invoiceId}`, playerId);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(await creditsOf(playerId), 0);

    const settled = await applyWebhook(webhookPayload(WebhookEventType.INVOICE_SETTLED, invoiceId));
    assert.equal(settled?.status, "settled");
    assert.equal(await creditsOf(playerId), 500);
  });

  it("refuses a second cancel once the charge is terminal", async () => {
    const invoiceId = uniqueInvoiceId();
    const playerId = await seedWaitingCharge(invoiceId);
    await cancelPayment(`credits-${invoiceId}`, playerId);

    await assert.rejects(
      cancelPayment(`credits-${invoiceId}`, playerId),
      (err: unknown) => err instanceof AppError && err.code === "payment_terminal"
    );
  });

  // The other half of the payment_in_flight guard: expiring a confirming charge on any
  // path would free the partial index, let a second invoice open, and leave the player
  // with two payable addresses for one plan.
  it("never expires a confirming charge, however far past expires_at it is", async () => {
    const invoiceId = uniqueInvoiceId();
    const playerId = await seedWaitingCharge(invoiceId);
    await applyWebhook(webhookPayload(WebhookEventType.INVOICE_RECEIVED_PAYMENT, invoiceId));
    await query(`UPDATE payments SET expires_at = now() - interval '1 hour' WHERE invoice_id = $1`, [invoiceId]);

    const active = await activePaymentFor(playerId);
    assert.equal(active?.status, "confirming");
  });

  it("sweeps a waiting charge whose invoice has expired instead of offering it to resume", async () => {
    const invoiceId = uniqueInvoiceId();
    const playerId = await seedWaitingCharge(invoiceId);
    await query(`UPDATE payments SET expires_at = now() - interval '1 hour' WHERE invoice_id = $1`, [invoiceId]);

    assert.equal(await activePaymentFor(playerId), null);
    const row = await query<{ status: string }>(`SELECT status FROM payments WHERE invoice_id = $1`, [invoiceId]);
    assert.equal(row.rows[0]?.status, "expired");
  });

  it("does nothing for an invoice the ledger has never heard of", async () => {
    assert.equal(await applyWebhook(webhookPayload(WebhookEventType.INVOICE_SETTLED, uniqueInvoiceId())), null);
    assert.equal(await applyWebhook(webhookPayload(WebhookEventType.INVOICE_EXPIRED, uniqueInvoiceId())), null);
  });
});
