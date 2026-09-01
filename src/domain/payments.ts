import { randomUUID } from "node:crypto";
import {
  BTCPayClient,
  BTCPayConfiguration,
  WebhookEventType,
  type BTCPayPaymentMethod,
  type BTCPayWebhookPayload,
} from "@taloon/btcpay-middleware";
import { config } from "@/config";
import { isUniqueViolation, query, withTransaction } from "@/db/pool";
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
  await insertWaitingCharge(orderId, playerId, plan);

  let invoice;
  try {
    invoice = await gateway().createInvoice({
      amount: plan.price_usd,
      currency: "USD",
      orderId,
      description: `${plan.credits} Hashimon credits`,
      metadata: { playerId, sku: plan.sku, credits: plan.credits },
      //A payment that lands a hair under the invoice is still the player paying: wallet
      //fee estimates and a BTC rate that moved between quote and broadcast routinely cost
      //a fraction of a percent. BTCPay applies the tolerance itself — inside it the
      //invoice goes Settled like any other and settleAndCredit runs unchanged; outside it
      //nothing changes either. No shortfall is ever measured or reconciled here.
      checkout: { paymentTolerance: config.btcpayPaymentTolerance },
    });
  } catch (err: unknown) {
    //Safe to write off precisely because no invoice exists: nothing at BTCPay can ever
    //be paid against this row. Leaving it `waiting` would hold the partial index and
    //lock the player out of retrying.
    await query(
      `UPDATE payments SET status = 'failed', updated_at = now()
        WHERE order_id = $1 AND status = 'waiting'`,
      [orderId]
    );
    enrich({ payment_gateway_error: err instanceof Error ? err.message : String(err) });
    throw new AppError(502, "createPayment: the payment gateway rejected the invoice", "gateway_error");
  }

  //invoice_id lands before anything else can fail. It is the only handle the webhook has
  //on this row, and the invoice is payable from the moment BTCPay returns it — a row
  //without it would mean coins arriving that applyWebhook can never match to anyone.
  await query(
    `UPDATE payments
        SET invoice_id = $2, checkout_link = $3, expires_at = $4, updated_at = now()
      WHERE order_id = $1`,
    //Greenfield reports expirationTime in unix seconds.
    [orderId, invoice.id, invoice.checkoutLink, new Date(invoice.expirationTime * 1000).toISOString()]
  );

  const method = await onChainMethodFor(invoice.id);
  const res = await query<PaymentRow>(
    `UPDATE payments
        SET amount_btc = $2, address = $3, bip21 = $4, updated_at = now()
      WHERE order_id = $1
      RETURNING *`,
    [orderId, method?.amount ?? null, method?.destination ?? null, bip21From(method)]
  );
  const payment = res.rows[0];
  if (!payment) {
    throw new AppError(500, `createPayment: charge ${orderId} vanished while being opened`, "internal");
  }
  return payment;
}

/**
 * The player's live charge, if any. Terminal ones are history, not state.
 *
 * Sweeps first: without it a `waiting` charge whose BTCPay invoice expired long ago is
 * still handed back as the one to resume, the client re-renders its QR, and coins sent to
 * a dead invoice come back as `InvoiceInvalid` — paid, never credited.
 */
export async function activePaymentFor(playerId: string): Promise<PaymentRow | null> {
  await expireStaleCharges(playerId);
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

/**
 * Give up on a charge — only while it is still `waiting`.
 *
 * `confirming` means BTCPay has already seen coins on the wire, so cancelling there is
 * a mistake every time: the player is about to pay for something they just told us to
 * throw away. Refusing is a better safety net than a warning in the modal copy.
 *
 * It is not the *last* net, though — see settleAndCredit, whose guard is
 * `status <> 'settled'` and not "not terminal". Money that actually arrives is credited
 * even to a charge the player cancelled or that BTCPay let expire. Refusing to honour a
 * real payment because of our own bookkeeping would be the worse bug.
 */
export async function cancelPayment(orderId: string, playerId: string): Promise<PaymentRow> {
  const res = await query<PaymentRow>(
    `UPDATE payments
        SET status = 'cancelled', updated_at = now()
      WHERE order_id = $1 AND player_id = $2 AND status = 'waiting'
      RETURNING *`,
    [orderId, playerId]
  );
  if (res.rows[0]) { return res.rows[0]; }

  //No row can mean two very different things, and a bare 404 would hide the one that
  //matters: coins already in flight.
  const existing = await paymentByOrderId(orderId, playerId);
  if (!existing) {
    throw new AppError(404, "cancelPayment: no charge with that order id", "not_found");
  }
  if (existing.status === "confirming") {
    throw new AppError(
      409,
      "cancelPayment: this charge is already being paid — wait for it to settle",
      "payment_in_flight"
    );
  }
  throw new AppError(409, `cancelPayment: charge is already ${existing.status}`, "payment_terminal");
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
    payment_status_target: target,
    //The only signal support ever gets that coins arrived but the charge did not settle.
    //Without these an underpaid invoice is indistinguishable from one never paid at all.
    payment_partially_paid: payload.partiallyPaid ?? false,
    payment_over_paid: payload.overPaid ?? false,
  });
  const applied = await applyTransition(target, payload.invoiceId);
  //The status that actually landed, not the one we intended: a redelivery or an unknown
  //invoice moves nothing, and logging the target would over-count settlements in exactly
  //the queries this event exists to answer.
  enrich({ payment_status: applied?.status ?? null, payment_applied: Boolean(applied) });
  if (applied) { enrich({ payment_order_id: applied.order_id, sku: applied.sku }); }
  return applied;
}

async function applyTransition(
  target: PaymentStatus | null,
  invoiceId: string
): Promise<PaymentRow | null> {
  if (!target) { return null; }
  if (target === "settled") { return settleAndCredit(invoiceId); }

  const res = await query<PaymentRow>(
    `UPDATE payments
        SET status = $2, updated_at = now()
      WHERE invoice_id = $1 AND status <> ALL($3::text[])
      RETURNING *`,
    [invoiceId, target, TERMINAL_STATUSES]
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

/**
 * A charge that never reached the gateway, or that BTCPay let lapse without telling us,
 * would otherwise hold the partial index forever. One statement, no cron job.
 *
 * `waiting` only — never `confirming`. A confirming charge has coins on the wire and
 * BTCPay keeps watching it well past `expirationTime` (that is what `monitoringMinutes`
 * is for), so expiring it here would free the index, let a second invoice open, and leave
 * the player with two payable addresses for one plan. It is the same transition
 * cancelPayment refuses with 409 `payment_in_flight`; doing it silently on another path
 * would make that guard theatre.
 */
export async function expireStaleCharges(playerId: string): Promise<void> {
  await query(
    `UPDATE payments
        SET status = 'expired', updated_at = now()
      WHERE player_id = $1 AND status = 'waiting' AND expires_at < now()`,
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

//Losing the QR is not fatal: the invoice exists and is payable, and checkout_link (BTCPay's
//own hosted page) is the documented fallback. Failing the whole charge here would 502 a
//charge the gateway has already opened.
async function onChainMethodFor(invoiceId: string): Promise<BTCPayPaymentMethod | undefined> {
  try {
    return onChainMethod(await gateway().getPaymentMethods(invoiceId));
  } catch (err: unknown) {
    enrich({ payment_methods_error: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}

//Deliberately no `?? methods[0]` fallback. On a Lightning-enabled store that would put a
//bolt11 invoice in `address` and a `lightning:` URI in `bip21`, which the client renders as
//an on-chain QR — wrong data is worse than no data, and checkout_link still works.
//"BTC" is the older Greenfield id for on-chain, "BTC-CHAIN" the current one.
export function onChainMethod(methods: BTCPayPaymentMethod[]): BTCPayPaymentMethod | undefined {
  return methods.find((m) => m.paymentMethodId === "BTC-CHAIN" || m.paymentMethodId === "BTC");
}

//Second guard on the same contract: whatever the method id claimed, only a real BIP21 URI
//reaches the client as one.
function bip21From(method: BTCPayPaymentMethod | undefined): string | null {
  const link = method?.paymentLink;
  return link?.startsWith("bitcoin:") ? link : null;
}

//One source of truth for the credentials: http/routes/payments-webhook.ts hands them to
//BTCPayConfiguration at wiring time and this reads them back, instead of both building a
//client from `config` and drifting apart when a key rotates. getConfig() also validates the
//three required fields for free.
//
//Built on first use, not at import: getConfig() throws when the credentials are missing,
//and db/migrate.ts plus the test suites import domain code with no gateway configured.
let client: BTCPayClient | null = null;

function gateway(): BTCPayClient {
  if (!client) {
    client = BTCPayClient.fromConfig(BTCPayConfiguration.getConfig());
  }
  return client;
}
