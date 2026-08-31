import { config } from "@/config";
import { AppError } from "@/http/errors";
import { enrich } from "@/http/wide-event";

//The one outbound call this server makes to CaosEngine. Node's own fetch, no HTTP client
//library and no retry: a lot is a SINGLE POST, and everything after it arrives by webhook.
//A retry here would be actively wrong — a second POST that succeeds after a first one that
//only *looked* like it failed buys the player two batches for one charge.
//
//ponytail: if this server ever grows a second outbound integration, move both onto axios
//(interceptors, timeouts and error normalisation in one place) rather than repeating this.

//Long enough for CaosEngine to persist the batch and answer 202, short enough that a hung
//gateway fails the player's request instead of holding their browser open indefinitely.
const REQUEST_TIMEOUT_MS = 15_000;

export interface HighEnergyRequest {
  /** Where the coinbase pays. Always config.coinbaseAddress today (P19: to the house). */
  address: string;
  /** The star floor asked of the pool. Marks come back at this or better. */
  stars: number;
  shares: number;
  /** The creature's DNA, committed into the coinbase. Mutually exclusive with `seed`. */
  opReturn: string;
  /** Absolute and reachable FROM CaosEngine's host, not from ours. */
  webhook: string;
}

/** CaosEngine's 202. `requestId` is its batch id, and the only handle we get on the lot. */
export interface HighEnergyAccepted {
  requestId: string;
  shares: number;
  status: string;
  queuePosition: number;
  message?: string;
}

export function isConfigured(): boolean {
  return Boolean(config.caosEngineUrl && config.publicUrl && config.coinbaseAddress);
}

export async function requestHighEnergy(input: HighEnergyRequest): Promise<HighEnergyAccepted> {
  const url = `${config.caosEngineUrl.replace(/\/+$/, "")}/api/v1/mining/energy/high`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        //CaosEngine's apiKeyGuard is commented out today, so this is inert. Sending it
        //anyway means switching their guard on is an env change here, not a deploy.
        ...(config.caosApiKey ? { "x-api-key": config.caosApiKey } : {}),
      },
      body: JSON.stringify({
        address: input.address,
        stars: input.stars,
        shares: input.shares,
        //`seed` is deliberately absent: CaosEngine treats seed and op_return as mutually
        //exclusive, and only op_return puts the DNA where the merkle root commits to it.
        op_return: input.opReturn,
        webhook: input.webhook,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    enrich({ caos_error: err instanceof Error ? err.message : String(err) });
    throw new AppError(502, "requestHighEnergy: CaosEngine is unreachable", "caos_unavailable");
  }

  if (!res.ok) {
    //Their errors are `{ error: "..." }`; keep the text, it names the rejected field.
    const detail = await res.text().catch(() => "");
    enrich({ caos_status: res.status, caos_error: detail.slice(0, 300) });
    throw new AppError(502, "requestHighEnergy: CaosEngine rejected the batch", "caos_rejected");
  }

  const body = (await res.json().catch(() => null)) as Partial<HighEnergyAccepted> | null;
  if (!body?.requestId) {
    //Without a requestId the batch exists over there and is unreachable from here: no way
    //to match its marks to a lot. Treat it as a failure so the lot refunds rather than
    //leaving the player paying for entropy that can never be delivered.
    enrich({ caos_error: "missing requestId in 202" });
    throw new AppError(502, "requestHighEnergy: CaosEngine returned no batch id", "caos_rejected");
  }

  return {
    requestId: String(body.requestId),
    shares: Number(body.shares ?? input.shares),
    status: String(body.status ?? "assigned"),
    queuePosition: Number(body.queuePosition ?? 0),
    message: body.message,
  };
}
