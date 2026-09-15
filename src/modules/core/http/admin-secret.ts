import { timingSafeEqual } from "node:crypto";
import { config } from "@/modules/core/config";
import { AppError } from "@/modules/core/http/errors";
import { enrich } from "@/modules/core/http/wide-event";

/** Gate for the read-only admin surface a back office calls server-to-server.
 *
 *  Its own secret, not LUANTI_SERVER_SECRET: that one mints sessions and moves MAGI,
 *  and a back office that only needs to *read* the roster must not be able to do
 *  either. Leaking this one exposes a list; leaking that one exposes the economy.
 *
 *  Constant-time for the same reason as the Luanti gate, and an empty secret is a
 *  503 rather than an open door — an unset variable must never mean "no auth". */
export function requireAdminSecret(req: { header: (n: string) => string | undefined }): void {
  const secret = config.adminApiSecret;
  if (!secret) {
    throw new AppError(503, "ADMIN_API_SECRET not configured", "misconfigured");
  }
  const providedBuf = Buffer.from(req.header("x-admin-secret") ?? "");
  const secretBuf = Buffer.from(secret);
  const matches = providedBuf.length === secretBuf.length && timingSafeEqual(providedBuf, secretBuf);
  if (!matches) {
    throw new AppError(401, "invalid admin secret", "unauthorized");
  }
  enrich({ auth_source: "admin" });
}
