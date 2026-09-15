import { Router } from "express";
import { z } from "zod";
import { requireAdminSecret } from "@/modules/core/http/admin-secret";
import { asyncHandler } from "@/modules/core/http/errors";
import { enrich } from "@/modules/core/http/wide-event";
import { listRoster } from "@/modules/player/domain/player-roster";

export const adminRouter = Router();

const rosterQuery = z.object({
  search: z.string().max(40).optional(),
  sort: z.enum(["joined", "credits", "best_share"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

//GET /admin/players — the roster a back office reads server-to-server. Never called
//from a browser: the secret would have to ship to the client to do that, which is
//why the header is not in the CORS allowlist.
adminRouter.get(
  "/admin/players",
  asyncHandler(async (req, res) => {
    requireAdminSecret(req);
    const input = rosterQuery.parse(req.query);
    const result = await listRoster(input);
    enrich({ roster_returned: result.players.length, roster_total: result.totals.players, roster_sort: input.sort ?? "joined" });
    res.json({ ...result, limit: input.limit, offset: input.offset });
  })
);
