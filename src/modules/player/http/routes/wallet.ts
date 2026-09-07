import { Router } from "express";
import { requireSession } from "@/modules/core/http/auth";
import { AppError, asyncHandler } from "@/modules/core/http/errors";
import { enrich } from "@/modules/core/http/wide-event";
import { canOwn, claimSelfCustody, presentPlayer } from "@/modules/player/domain/players";

export const walletRouter = Router();

/** Drop server-held encrypted private key; caller keeps self-custody going forward. */
walletRouter.post(
  "/wallet/claim-self-custody",
  requireSession,
  asyncHandler(async (req, res) => {
    const player = req.player!;
    if (!canOwn(player)) {
      throw new AppError(403, "cannot own without a public key", "cannot_own");
    }
    //Dropping the server-held key is irreversible: the transition must leave a trace
    //even when nothing goes wrong.
    const updated = await claimSelfCustody(player.id);
    enrich({ custody_before: player.custody, custody_after: updated.custody });
    res.json({ player: presentPlayer(updated) });
  })
);
