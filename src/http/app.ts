import express from "express";
import cors from "cors";
import { config } from "../config";
import { healthRouter } from "./routes/health";
import { sessionRouter } from "./routes/session";
import { profileRouter } from "./routes/profile";
import { hashimonsRouter } from "./routes/hashimons";
import { errorMiddleware } from "./errors";

export function createApp() {
  const app = express();
  app.use(cors({ origin: config.corsOrigin, credentials: true }));
  app.use(express.json());

  app.use(healthRouter);
  app.use(sessionRouter);
  app.use(profileRouter);
  app.use(hashimonsRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: "not found", code: "not_found" });
  });

  app.use(errorMiddleware);
  return app;
}
