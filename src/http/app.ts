import express from "express";
import cors from "cors";
import { config } from "@/config";
import { healthRouter } from "@/http/routes/health";
import { sessionRouter } from "@/http/routes/session";
import { profileRouter } from "@/http/routes/profile";
import { hashimonsRouter } from "@/http/routes/hashimons";
import { authRouter } from "@/http/routes/auth";
import { internalRouter } from "@/http/routes/internal";
import { walletRouter } from "@/http/routes/wallet";
import { errorMiddleware } from "@/http/errors";

export function createApp() {
  const app = express();
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
