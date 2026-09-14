import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import {
  WebhookEventType,
  type BTCPayInvoice,
  type BTCPayPaymentMethod,
  type BTCPayWebhookPayload,
} from "@taloon/btcpay-middleware";
import {
  activePaymentFor,
  applyWebhook,
  cancelPayment,
  createPayment,
  onChainMethod,
  paymentByOrderId,
  presentPayment,
  statusForWebhookEvent,
  type PaymentGateway,
  type PaymentRow,
} from "@/modules/payments/domain/payments";
import { listActivePlans, planFor } from "@/modules/payments/domain/credit-plans";
import { pool, query } from "@/modules/core/db/pool";
import { AppError } from "@/modules/core/http/errors";
import { uniqueId } from "@/test/support/db";
import { seedPlayer, deletePlayers } from "@/test/support/fixtures";

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

describe("presentPayment", () => {
  function row(overrides: Partial<PaymentRow> = {}): PaymentRow {
    return {
      order_id: "credits-abc",
      player_id: "player-1",
      gateway: "btcpay-server",
      invoice_id: "inv-1",
      status: "waiting",
      sku: "credits_500",
      credits: 500,
      amount_usd: "5.00",
      amount_btc: null,
      address: null,
      bip21: null,
      checkout_link: "https://pay/checkout/inv-1",
      expires_at: new Date("2026-01-01T00:20:00Z"),
      settled_at: null,
      created_at: new Date("2026-01-01T00:00:00Z"),
      updated_at: new Date("2026-01-01T00:00:00Z"),
      ...overrides,
    };
  }

  // Degenerate: no settlement yet — the null must survive the presentation, not become "".
  it("leaves settledAt null for a charge that has never settled", () => {
    const presented = presentPayment(row());
    assert.equal(presented.settledAt, null);
  });

  // amount_usd is numeric in Postgres, which pg hands back as a string — the client needs a number.
  it("turns the numeric-as-string amount into a real number", () => {
    const presented = presentPayment(row({ amount_usd: "25.00" }));
    assert.equal(presented.amountUsd, 25);
  });

  it("formats every timestamp as ISO 8601, including a settled charge", () => {
    const presented = presentPayment(row({ settled_at: new Date("2026-01-01T00:05:00Z") }));
    assert.equal(presented.createdAt, "2026-01-01T00:00:00.000Z");
    assert.equal(presented.expiresAt, "2026-01-01T00:20:00.000Z");
    assert.equal(presented.settledAt, "2026-01-01T00:05:00.000Z");
  });
});

describe("webhook application (against the local DB)", () => {
  const playerIds: string[] = [];

  after(async () => {
    if (playerIds.length > 0) {
      // payments cascade with the player row.
      await query(`DELETE FROM players WHERE id = ANY($1)`, [playerIds]);
    }
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

/**
 * A `PaymentGateway` double — the exact two-method seam `createPayment` and
 * `onChainMethodFor` call. `calls` records every `createInvoice`/`getPaymentMethods`
 * invocation, so a test can assert the gateway was never reached (e.g. an unknown sku).
 */
function fakeGateway(
  overrides: Partial<{
    invoice: Partial<BTCPayInvoice>;
    methods: BTCPayPaymentMethod[];
    createInvoiceFails: boolean;
    getPaymentMethodsFails: boolean;
  }> = {}
): PaymentGateway & { calls: { createInvoice: number; getPaymentMethods: number } } {
  const calls = { createInvoice: 0, getPaymentMethods: 0 };
  return {
    calls,
    async createInvoice() {
      calls.createInvoice += 1;
      if (overrides.createInvoiceFails) {
        throw new Error("btcpay: could not create invoice");
      }
      return {
        id: `inv-${process.hrtime.bigint().toString(36)}`,
        storeId: "store-1",
        amount: "5.00",
        currency: "USD",
        status: "New",
        checkoutLink: "https://pay.example/checkout/1",
        monitoringExpiration: 0,
        expirationTime: Math.floor(Date.now() / 1000) + 1200,
        createdTime: Math.floor(Date.now() / 1000),
        ...overrides.invoice,
      } as BTCPayInvoice;
    },
    async getPaymentMethods() {
      calls.getPaymentMethods += 1;
      if (overrides.getPaymentMethodsFails) {
        throw new Error("btcpay: could not fetch payment methods");
      }
      return overrides.methods ?? [
        {
          paymentMethodId: "BTC-CHAIN",
          currency: "BTC",
          destination: "bc1qexample",
          paymentLink: "bitcoin:bc1qexample?amount=0.0001",
          amount: "0.0001",
          due: "0.0001",
          rate: "50000",
          activated: true,
        },
      ];
    },
  };
}

describe("createPayment (against the local DB, gateway stubbed)", () => {
  const playerIds: string[] = [];

  after(async () => {
    await deletePlayers(playerIds);
  });

  async function seedBuyer(): Promise<string> {
    const player = await seedPlayer({ displayName: uniqueId("PaymentsBuyer") });
    playerIds.push(player.id);
    return player.id;
  }

  // Simple/general: the sku's price and credits land on the row, the gateway's invoice
  // fields land on it too, and the on-chain method fills address/amount_btc/bip21.
  it("opens a waiting charge priced from the catalogue, never from a caller-supplied amount", async () => {
    const playerId = await seedBuyer();
    const gateway = fakeGateway();

    const payment = await createPayment(playerId, "credits_500", gateway);

    assert.equal(payment.status, "waiting");
    assert.equal(payment.sku, "credits_500");
    assert.equal(payment.credits, 500);
    assert.equal(payment.amount_usd, "5.00");
    assert.ok(payment.invoice_id);
    assert.ok(payment.checkout_link);
    assert.equal(payment.address, "bc1qexample");
    assert.equal(payment.amount_btc, "0.0001");
    assert.equal(payment.bip21, "bitcoin:bc1qexample?amount=0.0001");
    assert.equal(gateway.calls.createInvoice, 1);
  });

  // Edge: getPaymentMethods failing is survivable — checkout_link (BTCPay's own hosted
  // page) is the documented fallback, and only the QR fields are lost.
  it("keeps the checkout link but drops the QR fields when getPaymentMethods fails", async () => {
    const playerId = await seedBuyer();
    const gateway = fakeGateway({ getPaymentMethodsFails: true });

    const payment = await createPayment(playerId, "credits_500", gateway);

    assert.equal(payment.status, "waiting");
    assert.ok(payment.checkout_link);
    assert.equal(payment.address, null);
    assert.equal(payment.amount_btc, null);
    assert.equal(payment.bip21, null);
  });

  // Error: no invoice exists at BTCPay when createInvoice itself rejects, so the row is
  // safe to write off — leaving it `waiting` would hold the partial index forever.
  it("marks the charge failed and surfaces a 502 when the gateway rejects the invoice", async () => {
    const playerId = await seedBuyer();
    const gateway = fakeGateway({ createInvoiceFails: true });

    await assert.rejects(
      createPayment(playerId, "credits_500", gateway),
      (err: unknown) => err instanceof AppError && err.status === 502 && err.code === "gateway_error"
    );

    const row = await query<{ status: string }>(
      `SELECT status FROM payments WHERE player_id = $1`,
      [playerId]
    );
    assert.equal(row.rows[0]?.status, "failed");
  });

  // Edge: the SQL unique index, not an `if`, is what makes this race-free — a second
  // charge for the same player while one is still open must be rejected as 409.
  it("refuses a second charge while one is already open for the player", async () => {
    const playerId = await seedBuyer();
    await createPayment(playerId, "credits_500", fakeGateway());

    await assert.rejects(
      createPayment(playerId, "credits_1200", fakeGateway()),
      (err: unknown) => err instanceof AppError && err.status === 409 && err.code === "payment_pending"
    );
  });

  // Error: an unknown sku is rejected by planFor before the ledger row is even written,
  // so the gateway must never be reached.
  it("refuses an unknown sku without ever touching the gateway", async () => {
    const playerId = await seedBuyer();
    const gateway = fakeGateway();

    await assert.rejects(
      createPayment(playerId, "not-a-real-sku", gateway),
      (err: unknown) => err instanceof AppError && err.status === 400 && err.code === "bad_request"
    );
    assert.equal(gateway.calls.createInvoice, 0);
  });
});

describe("paymentByOrderId (against the local DB)", () => {
  const playerIds: string[] = [];

  after(async () => {
    await deletePlayers(playerIds);
  });

  it("finds a charge scoped to the player that opened it", async () => {
    const player = await seedPlayer({ displayName: uniqueId("PaymentsOwner") });
    playerIds.push(player.id);
    const payment = await createPayment(player.id, "credits_500", fakeGateway());

    const found = await paymentByOrderId(payment.order_id, player.id);
    assert.equal(found?.order_id, payment.order_id);
  });

  // Error/edge: an order id must not be readable by whoever guesses it — scoping by
  // player_id in the WHERE clause, not a post-hoc check, is what enforces that.
  it("returns nothing for the right order id under the wrong player", async () => {
    const owner = await seedPlayer({ displayName: uniqueId("PaymentsOwner") });
    const stranger = await seedPlayer({ displayName: uniqueId("PaymentsStranger") });
    playerIds.push(owner.id, stranger.id);
    const payment = await createPayment(owner.id, "credits_500", fakeGateway());

    assert.equal(await paymentByOrderId(payment.order_id, stranger.id), null);
  });

  // Degenerate: an order id that was never issued.
  it("returns nothing for an order id that was never issued", async () => {
    const player = await seedPlayer({ displayName: uniqueId("PaymentsOwner") });
    playerIds.push(player.id);

    assert.equal(await paymentByOrderId("credits-never-issued", player.id), null);
  });
});

describe("credit catalogue (against the local DB)", () => {
  // General: the seeded catalogue (schema.sql) — read-only here, never mutated, so
  // concurrent suites touching other rows never race with this one.
  it("lists only active plans, in display order", async () => {
    const plans = await listActivePlans();
    const skus = plans.map((p) => p.sku);
    assert.ok(skus.includes("credits_500"));
    assert.ok(skus.includes("credits_1200"));
    assert.ok(skus.includes("credits_3000"));
    assert.equal(skus.indexOf("credits_500") < skus.indexOf("credits_1200"), true);
    assert.equal(skus.indexOf("credits_1200") < skus.indexOf("credits_3000"), true);
  });

  it("presents price_usd as a number, not the numeric-as-string the row carries", async () => {
    const plans = await listActivePlans();
    const plan = plans.find((p) => p.sku === "credits_500");
    assert.equal(plan?.priceUsd, 5);
  });

  // Simple: resolving a known, active sku.
  it("resolves a known sku to its catalogue row", async () => {
    const plan = await planFor("credits_500");
    assert.equal(plan.credits, 500);
    assert.equal(plan.price_usd, "5.00");
  });

  // Error: an unknown sku is a malformed request (400), not a missing resource (404) —
  // the sku only ever comes from GET /payments/plans, so this path means tampering.
  it("refuses an unknown sku with a 400, not a 404", async () => {
    await assert.rejects(
      planFor("not-a-real-sku"),
      (err: unknown) => err instanceof AppError && err.status === 400 && err.code === "bad_request"
    );
  });

  // Degenerate: the empty string is just as unknown as a made-up sku.
  it("refuses the empty string as a sku", async () => {
    await assert.rejects(
      planFor(""),
      (err: unknown) => err instanceof AppError && err.status === 400 && err.code === "bad_request"
    );
  });
});

after(() => pool.end());
