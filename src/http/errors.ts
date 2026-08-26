import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { enrich } from "@/http/wide-event";

//A thrown AppError becomes a clean JSON error with the right status. Anything
//else becomes a 500 without leaking internals.
export class AppError extends Error {
  constructor(public status: number, message: string, public code = "error") {
    super(message);
  }
}

//Wrap an async route so rejected promises reach the error middleware instead of
//hanging the request.
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

//Enriches, never emits: the wide-event middleware is the single writer, so the
//failure and the request it belongs to arrive as one line instead of two.
export function errorMiddleware(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    enrich({ error_code: err.code, error_message: err.message });
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof ZodError) {
    enrich({ error_code: "bad_request", error_message: err.message });
    res.status(400).json({ error: "invalid request body", code: "bad_request", issues: err.issues });
    return;
  }
  //The key must be `error` for pino's stdSerializers.err to unpack the stack.
  enrich({ error_code: "internal", error: err });
  res.status(500).json({ error: "internal error", code: "internal" });
}
