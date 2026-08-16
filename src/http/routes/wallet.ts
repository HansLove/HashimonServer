import { Router } from "express";
import { requireSession } from "@/http/auth";
import { AppError, asyncHandler } from "@/http/errors";
import { canOwn, claimSelfCustody, presentPlayer } from "@/domain/players";

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
    const updated = await claimSelfCustody(player.id);
    res.json({ player: presentPlayer(updated) });
  })
);
