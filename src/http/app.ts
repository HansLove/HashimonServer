import express from "express";
import cors from "cors";
import type { Logger } from "pino";
import { config } from "@/config";
import { healthRouter } from "@/http/routes/health";
import { sessionRouter } from "@/http/routes/session";
import { profileRouter } from "@/http/routes/profile";
import { territoryRouter } from "@/http/routes/territory";
import { hashimonsRouter } from "@/http/routes/hashimons";
import { chatRouter } from "@/http/routes/chat";
import { authRouter } from "@/http/routes/auth";
import { internalRouter } from "@/http/routes/internal";
import { walletRouter } from "@/http/routes/wallet";
import { magiRouter } from "@/http/routes/magi";
import { paymentsRouter } from "@/http/routes/payments";
import { paymentsWebhookRouter } from "@/http/routes/payments-webhook";
import { incubationRouter } from "@/http/routes/incubation";
import { incubationWebhookRouter } from "@/http/routes/incubation-webhook";
import { errorMiddleware } from "@/http/errors";
import { wideEventMiddleware } from "@/http/wide-event";

export function createApp(logger?: Logger) {
  const app = express();
  //First in the chain: everything after it — CORS rejections, body parse failures,
  //404s — happens inside the event's store and lands in the event.
  app.use(wideEventMiddleware(logger));
  app.use(
    cors({
      origin: config.corsOrigin,
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      //Without this the browser hides X-Request-Id from cross-origin JS, so a
      //client-side report cannot name the event it belongs to.
      exposedHeaders: ["X-Request-Id"],
    })
  );
  //Before express.json() on purpose, and the only router that is: the BTCPay webhook
  //verifies an HMAC over the raw bytes, so a parsed body would fail every signature.
  //Swap these two lines and the symptom is an opaque 401 on every delivery.
  app.use(paymentsWebhookRouter);

  app.use(express.json());

  app.use(healthRouter);
  app.use(sessionRouter);
  app.use(authRouter);
  app.use(profileRouter);
  app.use(territoryRouter);
  app.use(hashimonsRouter);
  app.use(chatRouter);
  app.use(walletRouter);
  app.use(magiRouter);
  app.use(paymentsRouter);
  app.use(incubationRouter);
  //After express.json(), unlike the BTCPay one: CaosEngine does not sign its deliveries,
  //so there are no raw bytes to preserve — the lot secret in the URL is the credential.
  app.use(incubationWebhookRouter);
  app.use(internalRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: "not found", code: "not_found" });
  });

  app.use(errorMiddleware);
  return app;
}
