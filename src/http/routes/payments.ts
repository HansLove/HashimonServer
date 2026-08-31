import { Router } from "express";
import { z } from "zod";
import { requireSession } from "@/http/auth";
import { AppError, asyncHandler } from "@/http/errors";
import { enrich } from "@/http/wide-event";
import { listActivePlans } from "@/domain/credit-plans";
import {
  activePaymentFor,
  cancelPayment,
  createPayment,
  paymentByOrderId,
  presentPayment,
  GATEWAY,
  type PaymentRow,
} from "@/domain/payments";

export const paymentsRouter = Router();

//Everything a charge needs is derived from the sku: `.strict()` is what makes an
//`amount` or `price` smuggled into the body a 400 instead of a silently ignored field.
const createInvoiceSchema = z.object({ sku: z.string().min(1).max(60) }).strict();

/** The catalogue. Public: the prices are the same whoever is asking. */
paymentsRouter.get(
  "/payments/plans",
  asyncHandler(async (_req, res) => {
    const plans = await listActivePlans();
    enrich({ gateway: GATEWAY, plan_count: plans.length });
    res.json({ plans });
  })
);

paymentsRouter.post(
  "/payments/btcpay-server/invoice",
  requireSession,
  asyncHandler(async (req, res) => {
    const { sku } = createInvoiceSchema.parse(req.body ?? {});
    enrich({ gateway: GATEWAY, sku });
    try {
      const payment = await createPayment(req.player!.id, sku);
      enrichPayment(payment);
      res.status(201).json({ payment: presentPayment(payment) });
    } catch (err: unknown) {
      if (!(err instanceof AppError) || err.code !== "payment_pending") { throw err; }
      //The live charge travels with the 409 so the client can offer "resume or
      //discard" without a second round trip.
      const live = await activePaymentFor(req.player!.id);
      if (live) { enrichPayment(live); }
      //Responding here bypasses errorMiddleware, so the event has to be told about the
      //failure by hand or this request logs as a plain 409 with no error_code at all.
      enrich({ error_code: err.code, error_message: err.message });
      res.status(409).json({
        error: err.message,
        code: err.code,
        payment: live ? presentPayment(live) : null,
      });
    }
  })
);

/** 204, not an empty object: "no charge in flight" is the absence of a resource. */
paymentsRouter.get(
  "/payments/btcpay-server/active",
  requireSession,
  asyncHandler(async (req, res) => {
    const payment = await activePaymentFor(req.player!.id);
    enrich({ gateway: GATEWAY, found: Boolean(payment) });
    if (!payment) {
      res.status(204).end();
      return;
    }
    enrichPayment(payment);
    res.json({ payment: presentPayment(payment) });
  })
);

/** What the client polls. The status it returns is the client's UI phase, verbatim. */
paymentsRouter.get(
  "/payments/btcpay-server/invoice/:orderId",
  requireSession,
  asyncHandler(async (req, res) => {
    const payment = await paymentByOrderId(req.params.orderId!, req.player!.id);
    enrich({ gateway: GATEWAY, payment_order_id: req.params.orderId, found: Boolean(payment) });
    if (!payment) { throw new AppError(404, "no charge with that order id", "not_found"); }
    enrichPayment(payment);
    res.json({ payment: presentPayment(payment) });
  })
);

paymentsRouter.post(
  "/payments/btcpay-server/invoice/:orderId/cancel",
  requireSession,
  asyncHandler(async (req, res) => {
    const payment = await cancelPayment(req.params.orderId!, req.player!.id);
    enrichPayment(payment);
    res.json({ payment: presentPayment(payment) });
  })
);

//The address and the BTC amount are deliberately never both on the event: together
//they name a specific on-chain payment in a log line, the same reason dna_prefix
//exists instead of dna. The order id is the handle for support, and it is enough.
function enrichPayment(payment: PaymentRow): void {
  enrich({
    gateway: payment.gateway,
    payment_order_id: payment.order_id,
    payment_status: payment.status,
    sku: payment.sku,
    credits: payment.credits,
    amount_usd: payment.amount_usd,
  });
}
