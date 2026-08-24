import { Router } from "express";
import { z } from "zod";
import { requireSession } from "@/http/auth";
import { AppError, asyncHandler } from "@/http/errors";
import { enrich } from "@/http/wide-event";
import { canOwn } from "@/domain/players";
import { emit, getForOwner, listByOwner, present, isGenesisSpecies, countStarterEmissions } from "@/domain/hashimons";
import { issueJob, jobResponse, submitShare } from "@/domain/mining";
import { Hashimons } from "@/data/species";

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
      if (provenance !== "starter") {
        throw new AppError(422, "genesis species require starter provenance", "genesis_provenance");
      }
      const starters = await countStarterEmissions(req.player!.id);
      enrich({ starter_count: starters });
      if (starters >= 1) {
        throw new AppError(409, "starter already issued", "starter_limit");
      }
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
    const outcome = await submitShare(row, body);

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
