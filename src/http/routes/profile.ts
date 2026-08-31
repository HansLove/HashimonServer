import { Router } from "express";
import { z } from "zod";
import { requireSession } from "@/http/auth";
import { countForOwner } from "@/domain/hashimons";
import { canOwn, rebirthWithBirthDate } from "@/domain/players";
import { getPlayerTerritory, presentTerritory } from "@/domain/territory";
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
    const territory = presentTerritory(await getPlayerTerritory(player.id));
    enrich({ hashimon_count: hashimonCount, credits: player.credits, has_town: territory.hasTown });
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
      territory,
      //Birth Identity. birthSpirit/genesisElement son el destino compartido;
      //lifeNumber es más revelador (con el año conocido deja la fecha en ~3
      //candidatos, contra ~31 con sólo el espíritu) y por eso vive aquí, en la
      //vista autenticada del dueño, y no en la tarjeta pública de la criatura.
      birthSpirit: player.birth_spirit,
      genesisElement: player.genesis_element,
      lifeNumber: player.life_number,
      birthVersion: player.birth_version,
    });
  })
);

const birthSchema = z.object({
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "dob must be YYYY-MM-DD"),
});

//POST /profile/birth — el camino de migración V1 -> V2. Una cuenta que se
//registró eligiendo especie a mano entrega su fecha UNA sola vez; a partir de
//ahí su identidad es irrevocable y su Genesis V1 queda archivado.
//
//La fecha no se persiste ni se registra en el log: sólo sus derivados.
profileRouter.post(
  "/profile/birth",
  requireSession,
  asyncHandler(async (req, res) => {
    const input = birthSchema.parse(req.body ?? {});
    const result = await rebirthWithBirthDate(req.player!, input.dob);
    res.status(201).json({
      hashimon: result.hashimon,
      archived: result.archived,
      birthSpirit: result.identity.spirit,
      spiritName: result.identity.spiritName,
      lifeNumber: result.identity.lifeNumber,
      element: result.identity.element,
      undertone: result.identity.undertone,
      speciesKey: result.identity.speciesKey,
    });
  })
);
