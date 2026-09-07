import express from "express";
import cors from "cors";
import type { Logger } from "pino";
import { config } from "@/modules/core/config";
import { healthRouter } from "@/modules/core/http/routes/health";
import { sessionRouter } from "@/modules/player/http/routes/session";
import { profileRouter } from "@/modules/core/http/routes/profile";
import { territoryRouter } from "@/modules/core/http/routes/territory";
import { armiesRouter } from "@/modules/territory/http/routes/armies";
import { hashimonsRouter } from "@/modules/core/http/routes/hashimons";
import { chatRouter } from "@/modules/core/http/routes/chat";
import { authRouter } from "@/modules/player/http/routes/auth";
import { internalRouter } from "@/modules/core/http/routes/internal";
import { walletRouter } from "@/modules/player/http/routes/wallet";
import { magiRouter } from "@/modules/magi/http/routes/magi";
import { paymentsRouter } from "@/modules/payments/http/routes/payments";
import { affiliateRouter } from "@/modules/affiliate/http/routes/affiliate";
import { paymentsWebhookRouter } from "@/modules/payments/http/routes/payments-webhook";
import { incubationRouter } from "@/modules/incubation/http/routes/incubation";
import { incubationWebhookRouter } from "@/modules/incubation/http/routes/incubation-webhook";
import { mapMarkersRouter } from "@/modules/map/http/routes/map-markers";
import { errorMiddleware } from "@/modules/core/http/errors";
import { wideEventMiddleware } from "@/modules/core/http/wide-event";

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

  // 2mb: discovery_maps tiles arrive as base64 PNG (~128×128) on the internal route.
  app.use(express.json({ limit: "2mb" }));

  app.use(healthRouter);
  app.use(sessionRouter);
  app.use(authRouter);
  app.use(profileRouter);
  app.use(territoryRouter);
  app.use(armiesRouter);
  app.use(mapMarkersRouter);
  app.use(hashimonsRouter);
  app.use(chatRouter);
  app.use(walletRouter);
  app.use(affiliateRouter);
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
