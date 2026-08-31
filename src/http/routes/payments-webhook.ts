import express, { Router, type NextFunction, type Request, type Response } from "express";
import {
  BTCPayMiddleware,
  BTCPayWebhookSignatureError,
  type BTCPayWebhookPayload,
} from "@taloon/btcpay-middleware";
import { config } from "@/config";
import { AppError, asyncHandler } from "@/http/errors";
import { enrich } from "@/http/wide-event";
import { applyWebhook, GATEWAY } from "@/domain/payments";

//A router of its own for one reason: this route needs the unparsed body. HMAC is
//computed over the exact bytes BTCPay sent, so it must be mounted ahead of the
//app-wide express.json() — parse first and every signature fails, with a 401 that
//says nothing about why. See the mount order in http/app.ts.
export const paymentsWebhookRouter = Router();

//The middleware reads these env names on its own, but config stays the single source.
//Only webhookSecret is actually used here — domain/payments.ts builds its own client
//for the outbound calls.
BTCPayMiddleware.configure({
  baseURL: config.btcpayBaseUrl,
  apiKey: config.btcpayApiKey,
  storeId: config.btcpayStoreId,
  webhookSecret: config.btcpayWebhookSecret,
});

async function apply(payload: BTCPayWebhookPayload): Promise<void> {
  //The bearer of authority here is the HMAC the library just verified, not a session.
  enrich({ auth_source: "btcpay-hmac", gateway: GATEWAY });
  await applyWebhook(payload);
}

//Every event is registered, including the two that transition nothing: applyWebhook
//owns the mapping, and routing the no-ops through it too puts them on the wide event
//rather than dropping them silently.
/**
 * Refuse to serve the route at all without a secret. This is the whole security of the
 * endpoint: `invoiceWebhook` verifies the HMAC only `if (config.webhookSecret)` — a blank
 * BTCPAY_WEBHOOK_SECRET makes it accept any unsigned body, and since InvoiceSettled grants
 * credits, that is an anonymous credit-minting endpoint. Nothing else fails when the
 * variable is missing, so without this guard the hole is completely silent.
 */
const requireWebhookSecret = asyncHandler(async (_req, _res, next) => {
  if (!config.btcpayWebhookSecret) {
    throw new AppError(503, "BTCPAY_WEBHOOK_SECRET not configured", "misconfigured");
  }
  next();
});

paymentsWebhookRouter.post(
  "/payments/btcpay-server/webhook",
  requireWebhookSecret,
  express.raw({ type: "application/json" }),
  BTCPayMiddleware.invoiceWebhook({
    onCreated: apply,
    onReceivedPayment: apply,
    onProcessing: apply,
    onSettled: apply,
    onPaymentSettled: apply,
    onExpired: apply,
    onInvalid: apply,
    onError: webhookError,
  })
);

//A bad signature is an authentication failure, not a server fault: without this it
//would reach errorMiddleware as an unknown error and be reported as a 500, which
//tells BTCPay to keep retrying a delivery that can never be accepted.
function webhookError(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (err instanceof BTCPayWebhookSignatureError) {
    enrich({ error_code: "invalid_signature", error_message: err.message });
    res.status(401).json({ error: "invalid webhook signature", code: "invalid_signature" });
    return;
  }
  next(err);
}
