import { timingSafeEqual } from "node:crypto";
import { config } from "@/config";
import { AppError } from "@/http/errors";
import { enrich } from "@/http/wide-event";

/** Gate for routes the Luanti world calls on a player's behalf. Constant-time: this
 *  secret discloses password hashes, mints sessions and moves MAGI, so a timing
 *  side-channel matters. Length must match before timingSafeEqual (it throws). */
export function requireLuantiSecret(req: { header: (n: string) => string | undefined }): void {
  const secret = config.luantiServerSecret;
  if (!secret) {
    throw new AppError(503, "LUANTI_SERVER_SECRET not configured", "misconfigured");
  }
  const providedBuf = Buffer.from(req.header("x-luanti-secret") ?? "");
  const secretBuf = Buffer.from(secret);
  const matches = providedBuf.length === secretBuf.length && timingSafeEqual(providedBuf, secretBuf);
  if (!matches) {
    throw new AppError(401, "invalid luanti server secret", "unauthorized");
  }
  enrich({ auth_source: "luanti" });
}
