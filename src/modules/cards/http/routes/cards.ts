import { Router } from "express";
import { requireSession } from "@/modules/core/http/auth";
import { asyncHandler } from "@/modules/core/http/errors";
import { enrich } from "@/modules/core/http/wide-event";
import { cocoonsFor, presentCocoon } from "@/modules/cards/domain/stickers";

export const cardsRouter = Router();

/** Los capullos del jugador (docs/ESTAMPAS_V1.md §4.5). LEERLOS LOS MADURA: los que ya
 *  tienen su bloque se abren aquí, igual que /payments/bonuses. El cliente debe llamarlo
 *  mientras enseña un sobre con capullos, y al volver a la pantalla del álbum. */
cardsRouter.get(
  "/cards/cocoons",
  requireSession,
  asyncHandler(async (req, res) => {
    const rows = await cocoonsFor(req.player!.id);
    enrich({ cocoon_count: rows.length, cocoon_open: rows.filter((r) => r.status === "cocoon").length });
    res.json({ cocoons: rows.map(presentCocoon) });
  })
);
