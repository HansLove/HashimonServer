import { Router } from "express";
import { z } from "zod";
import { requireSession } from "@/http/auth";
import { AppError, asyncHandler } from "@/http/errors";
import { enrich } from "@/http/wide-event";
import { getForOwner, present } from "@/domain/hashimons";
import { anthropicConfigured, AnthropicError } from "@/domain/anthropic";
import { ChatDenied, care, loadState, speak } from "@/domain/chat";
import { elementOfSpeciesKey, spiritOfSpeciesKeyOrNull } from "@/domain/chat-helpers";
import { questForHashimon } from "@/domain/map-markers";

export const chatRouter = Router();

const speakBody = z.object({ message: z.string().trim().min(1).max(2000) });
const careBody = z.object({
  kind: z.enum(["hunger", "company", "exercise", "world"]),
  sector: z.string().trim().max(64).optional(),
});

//El estado del compañero: bienestar, lo que quiere y cuánto cupo le queda.
//Se puede leer sin gastar un turno.
chatRouter.get(
  "/hashimons/:id/companion",
  requireSession,
  asyncHandler(async (req, res) => {
    const row = await getForOwner(req.params.id!, req.player!.id);
    if (!row) throw new AppError(404, "not found", "not_found");
    const state = await loadState(row.id, req.player!.id);
    const worldQuest = await questForHashimon(req.player!.id, row.id, row.name);
    enrich({
      hashimon_id: row.id,
      wellbeing: state.wellbeing.overall,
      has_world_quest: Boolean(worldQuest),
    });
    res.json({
      wellbeing: state.wellbeing,
      keepsakes: state.keepsakes,
      freeTurnsLeft: state.freeTurnsLeft,
      credits: state.credits,
      provider: anthropicConfigured() ? "ready" : "unconfigured",
      worldQuest,
    });
  })
);

chatRouter.post(
  "/hashimons/:id/chat",
  requireSession,
  asyncHandler(async (req, res) => {
    const { message } = speakBody.parse(req.body);
    const row = await getForOwner(req.params.id!, req.player!.id);
    if (!row) throw new AppError(404, "not found", "not_found");

    try {
      const out = await speak({
        hashimonId: row.id,
        ownerId: req.player!.id,
        name: row.name || row.species_key,
        dna: row.dna,
        //`birth_spirit` está en la fila para los V2; para un V1 sale de la clave
        //o es null, y el prompt lo omite sin más.
        spirit: (row.birth_spirit as never) ?? spiritOfSpeciesKeyOrNull(row.species_key),
        element: elementOfSpeciesKey(row.species_key),
        //La etapa es DERIVADA del proof-of-work, nunca almacenada.
        stage: Math.max(1, present(row).stage ?? 1),
        message,
      });
      enrich({
        hashimon_id: row.id,
        wellbeing: out.wellbeing.overall,
        free_turns_left: out.freeTurnsLeft,
        kept_memory: Boolean(out.keepsake),
      });
      res.json(out);
    } catch (err) {
      //Un rechazo por créditos es 402 y explica cuánto falta; no es un 500.
      if (err instanceof ChatDenied) throw new AppError(402, err.message, err.code);
      if (err instanceof AnthropicError) {
        throw new AppError(err.status === 503 ? 503 : 502, err.message, "provider_error");
      }
      throw err;
    }
  })
);

//Atender un cuidado. Cierra el bucle: la criatura pide, el jugador actúa, sube.
chatRouter.post(
  "/hashimons/:id/care",
  requireSession,
  asyncHandler(async (req, res) => {
    const { kind, sector } = careBody.parse(req.body);
    const row = await getForOwner(req.params.id!, req.player!.id);
    if (!row) throw new AppError(404, "not found", "not_found");
    const wellbeing = await care(row.id, kind, sector);
    enrich({ hashimon_id: row.id, care_kind: kind, wellbeing: wellbeing.overall });
    res.json({ wellbeing });
  })
);
