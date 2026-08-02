import { Router } from "express";
import { requireSession } from "../auth";
import { countForOwner } from "../../domain/hashimons";
import { asyncHandler } from "../errors";

export const profileRouter = Router();

//GET /profile — who am I, how many creatures, how many credits. Authoritative
//account state; the frontend renders this but never decides it.
profileRouter.get(
  "/profile",
  requireSession,
  asyncHandler(async (req, res) => {
    const player = req.player!;
    const hashimonCount = await countForOwner(player.id);
    res.json({
      id: player.id,
      displayName: player.display_name,
      publicKey: player.public_key,
      credits: player.credits,
      hashimonCount,
      memberSince: player.created_at,
    });
  })
);
