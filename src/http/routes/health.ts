import { Router } from "express";
import { query } from "../../db/pool";
import { CORE_VERSION } from "../../core";
import { asyncHandler } from "../errors";

export const healthRouter = Router();

//Liveness + a DB round-trip, so a green check means the whole path is up.
healthRouter.get(
  "/health",
  asyncHandler(async (_req, res) => {
    await query("SELECT 1");
    res.json({ ok: true, core: CORE_VERSION });
  })
);
