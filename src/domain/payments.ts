import { randomUUID } from "node:crypto";
import {
  BTCPayClient,
  WebhookEventType,
  type BTCPayPaymentMethod,
  type BTCPayWebhookPayload,
} from "@taloon/btcpay-middleware";
import { config } from "@/config";
import { isUniqueViolation, query, withTransaction, type Sql } from "@/db/pool";
import { AppError } from "@/http/errors";
import { enrich } from "@/http/wide-event";
import { audit } from "@/domain/audit";
import { planFor } from "@/domain/credit-plans";

//The payment book. Every transition here is decided by the server: the client's UI
//phase *is* the status column, so nothing a browser does can move a charge forward.
//The two guarantees that matter both live in SQL rather than in an `if`:
//  - one live charge per player  → payments_active_per_player_idx (23505 → 409)
//  - credits granted exactly once → UPDATE ... WHERE status <> 'settled' RETURNING *

export const GATEWAY = "btcpay-server";

export type PaymentStatus =
  | "waiting"
  | "confirming"
  | "settled"
  | "expired"
  | "failed"
  | "cancelled";

const TERMINAL_STATUSES: PaymentStatus[] = ["settled", "expired", "failed", "cancelled"];

export interface PaymentRow {
  order_id: string;
  player_id: string;
  gateway: string;
  invoice_id: string | null;
  status: PaymentStatus;
  sku: string;
  credits: number;
  amount_usd: string;
  amount_btc: string | null;
  address: string | null;
  bip21: string | null;
  checkout_link: string | null;
  expires_at: Date;
  settled_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** The shape the client sees. amount_usd is numeric, which pg hands back as a string. */
export function presentPayment(row: PaymentRow) {
  return {
    orderId: row.order_id,
    status: row.status,
    sku: row.sku,
    credits: row.credits,
    amountUsd: Number(row.amount_usd),
    amountBtc: row.amount_btc,
    address: row.address,
    bip21: row.bip21,
    checkoutLink: row.checkout_link,
    expiresAt: row.expires_at.toISOString(),
    settledAt: row.settled_at ? row.settled_at.toISOString() : null,
  };
}

/**
 * Open a charge for a plan. The price is read from the catalogue here and nowhere
 * else — the request carried a sku, never an amount.
 *
 * Order matters: the ledger row is written *before* the gateway is called, so a
 * duplicate charge is rejected by the partial unique index without leaving an
 * orphan invoice behind at BTCPay. If the gateway call then fails, the row is
 * marked failed, which also releases the index for a retry.
 */
export async function createPayment(playerId: string, sku: string): Promise<PaymentRow> {
  const plan = await planFor(sku);
  await expireStaleCharges(playerId);

  const orderId = `credits-${randomUUID()}`;
  const opened = await insertWaitingCharge(orderId, playerId, plan);

  try {
    const invoice = await gateway().createInvoice({
      amount: plan.price_usd,
      currency: "USD",
      orderId,
      description: `${plan.credits} Hashimon credits`,
      metadata: { playerId, sku: plan.sku, credits: plan.credits },
    });
    const method = onChainMethod(await gateway().getPaymentMethods(invoice.id));

    const res = await query<PaymentRow>(
      `UPDATE payments
          SET invoice_id = $2, amount_btc = $3, address = $4, bip21 = $5,
              checkout_link = $6, expires_at = $7, updated_at = now()
        WHERE order_id = $1
        RETURNING *`,
      [
        orderId,
        invoice.id,
        method?.amount ?? null,
        method?.destination ?? null,
        method?.paymentLink ?? null,
        invoice.checkoutLink,
        //Greenfield reports expirationTime in unix seconds.
        new Date(invoice.expirationTime * 1000).toISOString(),
      ]
    );
    return res.rows[0]!;
  } catch (err: unknown) {
    //Never leave the row in `waiting`: it would hold the partial index and lock the
    //player out of retrying a charge that no invoice will ever settle.
    await query(
      `UPDATE payments SET status = 'failed', updated_at = now()
        WHERE order_id = $1 AND status = 'waiting'`,
      [orderId]
    );
    enrich({ payment_gateway_error: err instanceof Error ? err.message : String(err) });
    throw new AppError(502, "createPayment: the payment gateway rejected the invoice", "gateway_error");
  }
}

/** The player's live charge, if any. Terminal ones are history, not state. */
export async function activePaymentFor(playerId: string): Promise<PaymentRow | null> {
  const res = await query<PaymentRow>(
    `SELECT * FROM payments
      WHERE player_id = $1 AND status IN ('waiting', 'confirming')
      ORDER BY created_at DESC
      LIMIT 1`,
    [playerId]
  );
  return res.rows[0] ?? null;
}

/** Scoped by player on purpose: an order id must not be readable by whoever guesses it. */
export async function paymentByOrderId(orderId: string, playerId: string): Promise<PaymentRow | null> {
  const res = await query<PaymentRow>(
    `SELECT * FROM payments WHERE order_id = $1 AND player_id = $2`,
    [orderId, playerId]
  );
  return res.rows[0] ?? null;
}

/** Give up on a charge. Only a live one can be cancelled — terminal is terminal. */
export async function cancelPayment(orderId: string, playerId: string): Promise<PaymentRow> {
  const res = await query<PaymentRow>(
    `UPDATE payments
        SET status = 'cancelled', updated_at = now()
      WHERE order_id = $1 AND player_id = $2 AND status IN ('waiting', 'confirming')
      RETURNING *`,
    [orderId, playerId]
  );
  if (!res.rows[0]) {
    throw new AppError(404, "cancelPayment: no live charge with that order id", "not_found");
  }
  return res.rows[0];
}

/**
 * Apply one webhook. Returns the updated row, or null when the event moves nothing —
 * an unknown invoice, an informational event, or a redelivery of one already applied.
 *
 * BTCPay redelivers (`isRedelivery` on the payload), so "already applied" is the
 * normal case, not the exception: crediting twice would be a silent gift. The guard
 * is the WHERE clause, not a check-then-act — only the first UPDATE returns a row.
 */
export async function applyWebhook(payload: BTCPayWebhookPayload): Promise<PaymentRow | null> {
  const target = statusForWebhookEvent(payload.type);
  enrich({
    gateway: GATEWAY,
    webhook_event: payload.type,
    webhook_redelivery: payload.isRedelivery,
    payment_status: target,
  });
  if (!target) { return null; }
  if (target === "settled") { return settleAndCredit(payload.invoiceId); }

  const res = await query<PaymentRow>(
    `UPDATE payments
        SET status = $2, updated_at = now()
      WHERE invoice_id = $1 AND status <> ALL($3::text[])
      RETURNING *`,
    [payload.invoiceId, target, TERMINAL_STATUSES]
  );
  return res.rows[0] ?? null;
}

/**
 * The event → status map. Exported because it is the whole contract with BTCPay and
 * the one part of this module worth testing without a database.
 *
 * `InvoiceCreated` is a no-op (the row is already `waiting`) and
 * `InvoicePaymentSettled` is informational — one payment of possibly several
 * settling says nothing about the invoice as a whole. Both return null.
 */
export function statusForWebhookEvent(type: BTCPayWebhookPayload["type"]): PaymentStatus | null {
  switch (type) {
    case WebhookEventType.INVOICE_RECEIVED_PAYMENT:
    case WebhookEventType.INVOICE_PROCESSING:
      return "confirming";
    case WebhookEventType.INVOICE_SETTLED:
      return "settled";
    case WebhookEventType.INVOICE_EXPIRED:
      return "expired";
    case WebhookEventType.INVOICE_INVALID:
      return "failed";
    default:
      return null;
  }
}

//Settling and crediting commit together or not at all: a settled row whose credits
//never landed is worse than an unapplied webhook, which BTCPay will simply redeliver.
async function settleAndCredit(invoiceId: string): Promise<PaymentRow | null> {
  return withTransaction(async (client) => {
    const res = await query<PaymentRow>(
      `UPDATE payments
          SET status = 'settled', settled_at = now(), updated_at = now()
        WHERE invoice_id = $1 AND status <> 'settled'
        RETURNING *`,
      [invoiceId],
      client
    );
    const payment = res.rows[0];
    if (!payment) { return null; }

    const credited = await query<{ credits: number }>(
      `UPDATE players SET credits = credits + $2 WHERE id = $1 RETURNING credits`,
      [payment.player_id, payment.credits],
      client
    );
    await audit(client, {
      playerId: payment.player_id,
      action: "credits.purchased",
      detail: {
        orderId: payment.order_id,
        gateway: payment.gateway,
        sku: payment.sku,
        credits: payment.credits,
        amountUsd: payment.amount_usd,
      },
    });
    enrich({ credits_granted: payment.credits, credits_after: credited.rows[0]?.credits });
    return payment;
  });
}

//A charge that never reached the gateway, or that BTCPay let lapse without telling us,
//would otherwise hold the partial index forever. One statement, no cron job.
async function expireStaleCharges(playerId: string): Promise<void> {
  await query(
    `UPDATE payments
        SET status = 'expired', updated_at = now()
      WHERE player_id = $1 AND status IN ('waiting', 'confirming') AND expires_at < now()`,
    [playerId]
  );
}

async function insertWaitingCharge(
  orderId: string,
  playerId: string,
  plan: { sku: string; credits: number; price_usd: string }
): Promise<PaymentRow> {
  try {
    const res = await query<PaymentRow>(
      `INSERT INTO payments (order_id, player_id, gateway, sku, credits, amount_usd)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [orderId, playerId, GATEWAY, plan.sku, plan.credits, plan.price_usd]
    );
    return res.rows[0]!;
  } catch (err: unknown) {
    //No pre-SELECT: the partial unique index is what makes this race-free against two
    //tabs pressing buy in the same tick. The route turns this into 409 + the live charge.
    if (isUniqueViolation(err, "payments_active_per_player_idx")) {
      throw new AppError(409, "a charge is already open for this player", "payment_pending");
    }
    throw err;
  }
}

//Prefer the on-chain BTC method: the checkout screen shows an address and a BIP21 QR,
//which a Lightning method would not supply (its paymentLink is a bolt11 invoice).
function onChainMethod(methods: BTCPayPaymentMethod[]): BTCPayPaymentMethod | undefined {
  return methods.find((m) => m.paymentMethodId?.startsWith("BTC-CHAIN")) ?? methods[0];
}

//Built on first use, not at import: config/BTCPayConfig throws when the credentials
//are missing, and db/migrate.ts plus the test suites import domain code with no
//gateway configured at all.
let client: BTCPayClient | null = null;

function gateway(): BTCPayClient {
  if (!client) {
    client = new BTCPayClient({
      baseURL: config.btcpayBaseUrl,
      apiKey: config.btcpayApiKey,
      storeId: config.btcpayStoreId,
    });
  }
  return client;
}
