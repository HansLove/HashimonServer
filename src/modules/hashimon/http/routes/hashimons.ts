import { Router } from "express";
import { z } from "zod";
import { requireSession } from "@/modules/core/http/auth";
import { AppError, asyncHandler } from "@/modules/core/http/errors";
import { enrich } from "@/modules/core/http/wide-event";
import { canOwn } from "@/modules/player/domain/players";
import { emit, getForOwner, listByOwner, present, isGenesisSpecies } from "@/modules/hashimon/domain/hashimons";
import { issueJob, jobResponse, submitShare, submitYield, yieldSummary, foodInventory } from "@/modules/mining/domain/mining";
import { FOODS } from "@/modules/mining/domain/foods";
import { Hashimons } from "@/modules/hashimon/data/species";

export const hashimonsRouter = Router();

hashimonsRouter.get(
  "/hashimons",
  requireSession,
  asyncHandler(async (req, res) => {
    const rows = await listByOwner(req.player!.id);
    enrich({ inventory_size: rows.length });
    res.json({ hashimons: rows.map(present) });
  })
);

hashimonsRouter.get(
  "/hashimons/:id",
  requireSession,
  asyncHandler(async (req, res) => {
    const row = await getForOwner(req.params.id!, req.player!.id);
    enrich({ hashimon_id: req.params.id, found: Boolean(row) });
    if (!row) { throw new AppError(404, "not found", "not_found"); }
    res.json(present(row));
  })
);

const emitSchema = z.object({
  speciesKey: z.string().min(1).max(60),
  provenance: z.enum(["wild", "starter"]).optional(),
  name: z.string().min(1).max(40).optional(),
});

hashimonsRouter.post(
  "/hashimons",
  requireSession,
  asyncHandler(async (req, res) => {
    if (!canOwn(req.player!)) {
      throw new AppError(403, "cannot own without a public key — register on the web", "cannot_own");
    }
    const input = emitSchema.parse(req.body ?? {});
    if (!Hashimons[input.speciesKey]) {
      throw new AppError(422, `unknown species: ${input.speciesKey}`, "unknown_species");
    }
    const provenance = input.provenance ?? "wild";
    const isGenesis = isGenesisSpecies(input.speciesKey);
    enrich({ species_key: input.speciesKey, provenance, is_genesis: isGenesis });
    if (isGenesis) {
      //Desde caos-core@2 un Genesis NO se pide: lo fija la fecha de nacimiento
      //en el registro (domain/players.ts::registerOwner). Aceptar una
      //speciesKey Genesis por el cuerpo de la petición sería devolverle al
      //cliente exactamente la elección que el sistema le quitó — y además le
      //dejaría escoger espíritu y elemento sin pasar por su fecha.
      throw new AppError(
        422,
        "a genesis is issued by your birth date at registration, not requested",
        "genesis_not_requestable"
      );
    }
    const row = await emit({
      ownerId: req.player!.id,
      speciesKey: input.speciesKey,
      provenance,
      name: input.name,
    });
    //A prefix, never the full dna: it is the permanent identifier of a creature and
    //8 hex chars are already enough to correlate this birth with a later share.
    enrich({
      hashimon_id: row.id,
      dna_prefix: row.dna.slice(0, 8),
      birth_nonce: row.birth_nonce,
    });
    res.status(201).json(present(row));
  })
);

hashimonsRouter.get(
  "/hashimons/:id/job",
  requireSession,
  asyncHandler(async (req, res) => {
    const row = await getForOwner(req.params.id!, req.player!.id);
    if (!row) { throw new AppError(404, "not found", "not_found"); }
    enrich({ hashimon_id: row.id });
    const job = await issueJob(row);
    res.json(jobResponse(job, Number(row.extranonce2)));
  })
);

const shareSchema = z.object({
  jobId: z.string().uuid(),
  extranonce2: z.number().int().min(0).max(0xffffffff),
  nonce: z.number().int().min(0).max(0xffffffff),
  hash: z.string().optional(),
  totalHashesAttempted: z.number().int().min(0).optional(),
});

hashimonsRouter.post(
  "/hashimons/:id/shares",
  requireSession,
  asyncHandler(async (req, res) => {
    const row = await getForOwner(req.params.id!, req.player!.id);
    if (!row) { throw new AppError(404, "not found", "not_found"); }

    const body = shareSchema.parse(req.body ?? {});
    enrich({ hashimon_id: row.id, job_id: body.jobId });
    const outcome = await submitShare(row, body);
    enrich({ accepted: outcome.ok });

    if (!outcome.ok) {
      const err = outcome.error;
      if (err === "stale_job") { throw new AppError(409, err, err); }
      if (err === "duplicate_share") { throw new AppError(409, err, err); }
      if (err === "under_target") {
        throw new AppError(422, err, err);
      }
      if (err === "dna_mismatch") { throw new AppError(400, err, err); }
      throw new AppError(422, err ?? "rejected", err ?? "rejected");
    }

    const presented = present(outcome.row);
    enrich({ tier: presented.tier, stars: presented.stars, stage: presented.stage });
    res.json({
      verified: true,
      accepted: true,
      bits: outcome.bits,
      hash: outcome.hash,
      bestShareHash: outcome.row.best_share_hash,
      bestShareBits: outcome.row.best_share_bits,
      progression: {
        tier: presented.tier,
        stars: presented.stars,
        stage: presented.stage,
      },
      hashimon: presented,
    });
  })
);

const yieldSchema = z.object({
  jobId: z.string().uuid(),
  extranonce2: z.number().int().min(0).max(0xffffffff),
  nonce: z.number().int().min(0).max(0xffffffff),
});

// POST /hashimons/:id/yield — the SECOND harvest (docs/POW_YIELD_V1). Same body as a
// share, but the floor is the yield window, not the share target — most yield hashes are
// below the share threshold. The server recomputes and re-derives the drop.
hashimonsRouter.post(
  "/hashimons/:id/yield",
  requireSession,
  asyncHandler(async (req, res) => {
    const row = await getForOwner(req.params.id!, req.player!.id);
    if (!row) { throw new AppError(404, "not found", "not_found"); }

    const body = yieldSchema.parse(req.body ?? {});
    enrich({ hashimon_id: row.id, job_id: body.jobId });
    const outcome = await submitYield(row, body);

    if (!outcome.ok) {
      const err = outcome.error;
      if (err === "stale_job" || err === "duplicate_yield") { throw new AppError(409, err, err); }
      if (err === "dna_mismatch") { throw new AppError(400, err, err); }
      // no_yield / invalid_nonce: the hash simply cleared no threshold.
      throw new AppError(422, err, err);
    }

    res.json({
      harvested: true,
      tier: outcome.tier,
      materialKey: outcome.materialKey,
      yieldBits: outcome.yieldBits,
      hash: outcome.hash,
      food: { key: outcome.foodKey, name: outcome.foodName },
    });
  })
);

// GET /hashimons/:id/yield — what this creature has harvested so far, per tier.
hashimonsRouter.get(
  "/hashimons/:id/yield",
  requireSession,
  asyncHandler(async (req, res) => {
    const row = await getForOwner(req.params.id!, req.player!.id);
    if (!row) { throw new AppError(404, "not found", "not_found"); }
    res.json(await yieldSummary(row.id));
  })
);

// GET /hashimons/:id/foods — the creature's larder grouped by named food (the food graph
// inventory the UI draws). Unspent only.
hashimonsRouter.get(
  "/hashimons/:id/foods",
  requireSession,
  asyncHandler(async (req, res) => {
    const row = await getForOwner(req.params.id!, req.player!.id);
    if (!row) { throw new AppError(404, "not found", "not_found"); }
    res.json({ foods: await foodInventory(row.id) });
  })
);

// GET /foods/catalog — public: the whole food graph (nodes + weights + edges) so the web
// can render the tree without hardcoding it. Content, not per-player state.
hashimonsRouter.get(
  "/foods/catalog",
  asyncHandler(async (_req, res) => {
    res.json({ foods: FOODS });
  })
);
