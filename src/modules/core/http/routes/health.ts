import { Router } from "express";
import { query } from "@/modules/core/db/pool";
import { CORE_VERSION } from "@/modules/core/core/index";
import { asyncHandler } from "@/modules/core/http/errors";
import { enrich } from "@/modules/core/http/wide-event";

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
