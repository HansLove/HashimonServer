import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "@/http/errors";
import { enrich } from "@/http/wide-event";
import {
  applyShare,
  closeLotById,
  lotBySecret,
  statusForTermination,
  LIVE_STATUSES,
  type CaosSharePayload,
} from "@/domain/incubation";

export const incubationWebhookRouter = Router();

//CaosEngine's way in. Two things to be clear about:
//
//  1. IT DOES NOT SIGN ITS DELIVERIES. There is no HMAC to verify, so the lot's own secret
//     in the URL is the entire credential — 32 random bytes, unique per lot, never logged
//     (see REDACT_PATHS). That is weaker than the BTCPay webhook and deliberately so: the
//     worst a forged delivery can do is submit a mark, and a mark is re-hashed and checked
//     against the creature's DNA before it counts. Forging one means solving the proof of
//     work, which is the thing being sold. A forged CLOSE is the real exposure, and it is
//     bounded by refunding the player — never by charging them.
//  2. Unlike the BTCPay webhook, this router is mounted AFTER express.json(): there are no
//     raw bytes to preserve because there is no signature over them.

//Hex has to be validated HERE, not left to the recomputation. `Buffer.from("nothex", "hex")`
//returns an empty buffer instead of throwing, so a corrupt template would sail through and
//come out the other end as `hash_mismatch` — the one verdict that means "the pool lied about
//its work". Garbage in the wire format and a dishonest pool are different accusations.
const hex = (bytes?: number) => {
  const base = z.string().regex(/^(?:[0-9a-fA-F]{2})*$/, "expected an even-length hex string");
  return bytes === undefined ? base : base.length(bytes * 2);
};

//Bitcoin's extranonce2 is a handful of bytes (spoon uses 8). The bound matters because the
//value reaches `padStart(extranonce2Size * 2)`, which will happily try to build a string of
//whatever length it is handed before anything else gets a chance to reject it.
const MAX_EXTRANONCE2_BYTES = 32;

//A mark. Every field the Caos Core needs to rebuild the header, and nothing optional about
//them — a missing one means a template that cannot be recomputed, which is a 400, not a
//silently dropped mark.
const shareSchema = z.object({
  requestId: z.string().min(1),
  version: hex(4),
  nonce: z.number().int().nonnegative(),
  hash: hex(32),
  prevHash: hex(32),
  bits: hex(4),
  timestamp: z.number().int().nonnegative(),
  //Not length(32): a merkle branch entry is a digest, but the fold only concatenates, so a
  //short one is the pool's problem to explain — via hash_mismatch, which is exactly right.
  merkleBranch: z.array(hex()),
  coinbasePrefix: hex().min(2),
  coinbaseSuffix: hex().min(2),
  extranonce1: hex(),
  extranonce2: hex(),
  extranonce2Size: z.number().int().positive().max(MAX_EXTRANONCE2_BYTES),
  shareIndex: z.number().int().nonnegative(),
  opReturn: z.string().optional(),
  sharesTotal: z.number().int().optional(),
  stars: z.number().int().optional(),
  leadingZeros: z.number().int().optional(),
  isBlock: z.boolean().optional(),
});

//The closing event. `status` is CaosEngine's vocabulary (completed | partial | failed);
//sharesDelivered is advisory — the ledger's own count is what the refund is computed from.
const closeSchema = z.object({
  requestId: z.string().min(1),
  status: z.string().min(1),
  sharesDelivered: z.number().int().nonnegative().optional(),
  sharesTotal: z.number().int().nonnegative().optional(),
  //CaosEngine sends explicit `null` for a completed batch, not omission — `.optional()`
  //alone rejects that and turns every completed-batch closure into a 400.
  terminationReason: z.string().nullable().optional(),
});

incubationWebhookRouter.post(
  "/incubation/webhook/:lotSecret",
  asyncHandler(async (req, res) => {
    const lot = await lotBySecret(req.params.lotSecret!);
    if (!lot) {
      //Never echo the secret back, not even to say it was wrong.
      enrich({ error_code: "unknown_lot" });
      res.status(404).json({ error: "unknown lot", code: "unknown_lot" });
      return;
    }
    enrich({ lot_id: lot.id, hashimon_id: lot.hashimon_id, player_id: lot.owner_id });

    const body = (req.body ?? {}) as Record<string, unknown>;

    //Discriminate on shape, not on a type field: CaosEngine forwards spoon's payload
    //verbatim and adds nothing that names which of the two it is.
    //
    //`shareIndex` and `hash` are the discriminator, decided BEFORE either schema runs. A
    //mark that fails validation must never be retried as a close: closeSchema asks only for
    //requestId and a status string, so the day spoon adds a `status` field to its payload,
    //one renamed key would turn every mark into a close — terminating the lot mid-batch,
    //refunding the player, and making every mark after it a `lot_closed`.
    if ("shareIndex" in body || "hash" in body) {
      const share = shareSchema.safeParse(body);
      if (!share.success) {
        enrich({
          error_code: "malformed_share",
          //The failing field names, never the values: this body is a template, and one of
          //its fields is the lot's own coinbase.
          invalid_fields: share.error.issues.map((issue) => issue.path.join(".")).join(","),
        });
        res.status(400).json({ error: "unreadable mark", code: "malformed_share" });
        return;
      }
      const result = await applyShare(lot, share.data as CaosSharePayload);
      if (!result.ok) {
        //A rejected mark is a decision, not a delivery failure. Answering 200 stops
        //CaosEngine from re-sending something that can never be accepted; the reason is
        //on the wide event, which is where a dispute gets settled.
        enrich({ share_accepted: false, share_reject_reason: result.error });
        res.status(200).json({ received: true, accepted: false, reason: result.error });
        return;
      }
      enrich({ share_accepted: true, share_redelivery: result.duplicate });
      res.status(200).json({ received: true, accepted: true, duplicate: result.duplicate });
      return;
    }

    const close = closeSchema.safeParse(body);
    if (close.success) {
      if (close.data.requestId !== lot.caos_request_id && lot.caos_request_id) {
        enrich({ error_code: "request_mismatch" });
        res.status(200).json({ received: true, accepted: false, reason: "request_mismatch" });
        return;
      }
      //Delivery is counted from the ledger, never from the number the pool reports: the
      //refund is money, and the marks we actually verified are the only honest basis for it.
      const status = statusForTermination(close.data.status, lot.shares_delivered, lot.shares_requested);
      const closed = await closeLotById(lot.id, status, close.data.terminationReason ?? undefined);
      enrich({
        lot_status: closed?.status ?? lot.status,
        lot_close_reason: close.data.terminationReason ?? null,
        //A close for an already-closed lot is a redelivery, which is the normal case.
        lot_close_redelivery: closed === null,
        caos_reported_delivered: close.data.sharesDelivered ?? null,
      });
      res.status(200).json({ received: true, closed: closed !== null });
      return;
    }

    //Neither shape. Say so with a 400 rather than swallowing it: a payload we cannot read
    //is a contract change on CaosEngine's side, and a silent 200 would hide it.
    enrich({
      error_code: "unrecognised_payload",
      lot_live: LIVE_STATUSES.includes(lot.status),
      payload_keys: Object.keys(body).slice(0, 20).join(","),
    });
    res.status(400).json({ error: "unrecognised payload", code: "unrecognised_payload" });
  })
);
