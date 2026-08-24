import { Router } from "express";
import { requireSession } from "@/http/auth";
import { countForOwner } from "@/domain/hashimons";
import { canOwn } from "@/domain/players";
import { asyncHandler } from "@/http/errors";
import { enrich } from "@/http/wide-event";

export const profileRouter = Router();

//GET /profile — who am I, how many creatures, how many credits. Authoritative
//account state; the frontend renders this but never decides it.
profileRouter.get(
  "/profile",
  requireSession,
  asyncHandler(async (req, res) => {
    const player = req.player!;
    const hashimonCount = await countForOwner(player.id);
    enrich({ hashimon_count: hashimonCount, credits: player.credits });
    res.json({
      id: player.id,
      displayName: player.display_name,
      username: player.username,
      publicKey: player.public_key,
      credits: player.credits,
      custody: player.custody,
      canOwn: canOwn(player),
      hashimonCount,
      memberSince: player.created_at,
    });
  })
);
