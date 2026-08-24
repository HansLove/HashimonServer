import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Logger } from "pino";
import { logger as defaultLogger } from "@/logger";

//One structured event per request, emitted once when the response finishes. Every
//layer that learns something worth knowing calls enrich() and adds a field to the
//event already in flight — nobody else logs. Scattered log lines answer "what did
//this line print"; a wide event answers "what happened to this request".

export type WideEvent = Record<string, unknown>;

//AsyncLocalStorage instead of req.event: db/pool.ts and domain/block-template.ts
//never receive a req, and domain/players.ts::loginOwner would need a signature
//change to report why a login failed. This costs no dependency and no signature.
const store = new AsyncLocalStorage<WideEvent>();

//A no-op outside a request is the point, not an oversight: db/migrate.ts and the
//node:test suites call domain code with no event in flight.
export function enrich(fields: WideEvent): void {
  Object.assign(store.getStore() ?? {}, fields);
}

//Queries accumulate rather than overwrite — the event carries the request's total,
//never one line per query. BEGIN/COMMIT/ROLLBACK go through the pg client directly
//and are deliberately not counted.
export function trackDbQuery(durationMs: number): void {
  const event = store.getStore();
  if (!event) { return; }
  event.db_query_count = (event.db_query_count as number) + 1;
  event.db_duration_ms = round((event.db_duration_ms as number) + durationMs);
}

//The logger is a parameter so the smoke test can point it at a sink instead of
//spawning a process. Production takes the default.
export function wideEventMiddleware(logger: Logger = defaultLogger) {
  return (req: Request, res: Response, next: NextFunction) => {
    const event: WideEvent = {
      event: "http_request",
      request_id: randomUUID(),
      method: req.method,
      //Overwritten by whatever actually proves identity: requireSession, the
      //Luanti secret gate, or POST /session. "none" is the truthful default for a
      //request that proved nothing.
      auth_source: "none",
      db_query_count: 0,
      db_duration_ms: 0,
    };
    const startedAt = process.hrtime.bigint();
    res.setHeader("X-Request-Id", event.request_id as string);

    //Inside als.run() so the finish listener — and everything it reads — sees the
    //same store the handlers enriched.
    store.run(event, () => {
      res.on("finish", () => {
        //req.route only exists once routing matched; a 404 has none, so it falls
        //back to the raw URL. Never req.url on a matched route: /hashimons/:id
        //resolved to real ids would blow up the cardinality of every query.
        event.path = req.route ? `${req.baseUrl}${req.route.path}` : "unmatched";
        if (!req.route) { event.path_raw = req.originalUrl; }
        event.status_code = res.statusCode;
        event.outcome = outcomeFor(res.statusCode);
        event.duration_ms = elapsedMs(startedAt);
        if (res.statusCode >= 500) {
          logger.error(event);
          return;
        }
        logger.info(event);
      });
      next();
    });
  };
}

//Shared so every duration that lands in an event is measured and rounded alike.
export function elapsedMs(startedAt: bigint): number {
  return round(Number(process.hrtime.bigint() - startedAt) / 1e6);
}

function outcomeFor(status: number): string {
  if (status >= 500) { return "error"; }
  if (status >= 400) { return "client_error"; }
  return "success";
}

function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}
