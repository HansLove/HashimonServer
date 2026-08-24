import { Router } from "express";
import { query } from "@/db/pool";
import { CORE_VERSION } from "@/core/index";
import { asyncHandler } from "@/http/errors";
import { enrich } from "@/http/wide-event";

export const healthRouter = Router();

//Liveness + a DB round-trip, so a green check means the whole path is up.
healthRouter.get(
  "/health",
  asyncHandler(async (_req, res) => {
    await query("SELECT 1");
    enrich({ db_ok: true });
    res.json({ ok: true, core: CORE_VERSION });
  })
);
