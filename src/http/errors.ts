import type { NextFunction, Request, Response } from "express";

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

export function errorMiddleware(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  console.error("unhandled error:", err);
  res.status(500).json({ error: "internal error", code: "internal" });
}
