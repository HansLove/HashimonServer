import { Router } from "express";
import { z } from "zod";
import { requireSession } from "@/http/auth";
import { AppError, asyncHandler } from "@/http/errors";
import { enrich } from "@/http/wide-event";
import { config } from "@/config";
import { progressionFromBits } from "@/core/index";
import { getForOwner } from "@/domain/hashimons";
import { isConfigured, requestHighEnergy } from "@/domain/caos-client";
import {
  activeLotFor,
  createLot,
  lotForHashimon,
  markAssigned,
  markFailed,
  presentLot,
  pricingTiers,
  MAX_SHARES,
  MIN_SHARES,
  REQUESTED_STARS,
  type LotRow,
} from "@/domain/incubation";

export const incubationRouter = Router();

//A lot is priced from its SIZE, exactly as a charge is priced from its sku. `.strict()` is
//what turns a smuggled `credits` or `price` into a 400 rather than a field quietly ignored.
const openLotSchema = z.object({ shares: z.number().int().min(MIN_SHARES).max(MAX_SHARES) }).strict();

/**
 * Missing configuration must not become a charge. Without a reachable CaosEngine, a public
 * webhook URL and a coinbase address, a lot would take the player's credits and then have
 * nowhere to send the work — the same reason requireWebhookSecret answers 503 for payments.
 */
function requireGateway(): void {
  if (!isConfigured()) {
    throw new AppError(
      503,
      "incubation: the incubator is not configured on this server",
      "incubation_unavailable"
    );
  }
}

/** The ladder. Public, like /payments/plans: the price is the same whoever is asking. */
incubationRouter.get(
  "/incubation/pricing",
  asyncHandler(async (_req, res) => {
    const tiers = await pricingTiers();
    enrich({ pricing_tier_count: tiers.length });
    res.json({ tiers, minShares: MIN_SHARES, maxShares: MAX_SHARES });
  })
);

incubationRouter.post(
  "/hashimons/:id/incubation",
  requireSession,
  asyncHandler(async (req, res) => {
    requireGateway();
    const { shares } = openLotSchema.parse(req.body ?? {});
    const hashimonId = req.params.id!;
    enrich({ hashimon_id: hashimonId, lot_shares: shares });

    const creature = await getForOwner(hashimonId, req.player!.id);
    if (!creature) {
      throw new AppError(404, "no creature with that id", "not_found");
    }
    if (creature.archived_at) {
      //An archived creature's DNA still verifies, but it is nobody's active Genesis —
      //buying entropy for it would spend credits on a creature the player cannot play.
      throw new AppError(409, "this creature is archived", "hashimon_archived");
    }

    const starsBefore = progressionFromBits(creature.best_share_bits).stars;

    let lot: LotRow;
    try {
      lot = await createLot({
        playerId: req.player!.id,
        hashimonId,
        shares,
        starsBefore,
        btcAddress: config.coinbaseAddress,
      });
    } catch (err: unknown) {
      if (!(err instanceof AppError) || err.code !== "incubation_pending") { throw err; }
      //The live lot travels with the 409 so the client shows it instead of the modal,
      //without a second round trip. Responding here bypasses errorMiddleware, so the
      //event has to be told about the failure by hand.
      const live = await activeLotFor(req.player!.id);
      enrich({ error_code: err.code, error_message: err.message, lot_id: live?.id });
      res.status(409).json({
        error: err.message,
        code: err.code,
        lot: live ? presentLot(live) : null,
      });
      return;
    }

    //The ledger row exists and the player is charged, so a gateway failure from here on
    //must give the credits back rather than leave a lot nobody will ever mine.
    try {
      const accepted = await requestHighEnergy({
        address: lot.btc_address,
        stars: REQUESTED_STARS,
        shares,
        opReturn: creature.dna,
        webhook: `${config.publicUrl.replace(/\/+$/, "")}/incubation/webhook/${lot.webhook_secret}`,
      });
      const assigned = await markAssigned(lot.id, accepted.requestId);
      enrich({
        lot_id: lot.id,
        lot_status: assigned?.status ?? lot.status,
        caos_request_id: accepted.requestId,
        caos_queue_position: accepted.queuePosition,
      });
      res.status(201).json({ lot: presentLot(assigned ?? lot) });
    } catch (err: unknown) {
      const failed = await markFailed(lot.id, err instanceof AppError ? err.code : "caos_error");
      enrich({ lot_id: lot.id, lot_status: "failed", credits_refunded: failed?.credits_refunded ?? 0 });
      throw err;
    }
  })
);

/**
 * What the client polls while a lot is alive. 204, not an empty object: "nothing in the
 * incubator" is the absence of a resource.
 *
 * A lot that has just closed keeps answering here for a day — see CLOSED_LOT_VISIBLE_MS.
 * P15 promises the player who closed the tab finds the outcome when they come back, and a
 * terminal lot that vanished on close would make the result screens unreachable.
 */
incubationRouter.get(
  "/hashimons/:id/incubation",
  requireSession,
  asyncHandler(async (req, res) => {
    const lot = await lotForHashimon(req.params.id!, req.player!.id);
    enrich({ hashimon_id: req.params.id, found: Boolean(lot) });
    if (!lot) {
      res.status(204).end();
      return;
    }
    enrich({
      lot_id: lot.id,
      lot_status: lot.status,
      shares_delivered: lot.shares_delivered,
      lot_shares: lot.shares_requested,
    });
    res.json({ lot: presentLot(lot) });
  })
);
