import express from "express";
import cors from "cors";
import type { Logger } from "pino";
import { config } from "@/config";
import { healthRouter } from "@/http/routes/health";
import { sessionRouter } from "@/http/routes/session";
import { profileRouter } from "@/http/routes/profile";
import { hashimonsRouter } from "@/http/routes/hashimons";
import { authRouter } from "@/http/routes/auth";
import { internalRouter } from "@/http/routes/internal";
import { walletRouter } from "@/http/routes/wallet";
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
    })
  );
  app.use(express.json());

  app.use(healthRouter);
  app.use(sessionRouter);
  app.use(authRouter);
  app.use(profileRouter);
  app.use(hashimonsRouter);
  app.use(walletRouter);
  app.use(internalRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: "not found", code: "not_found" });
  });

  app.use(errorMiddleware);
  return app;
}
