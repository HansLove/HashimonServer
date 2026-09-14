import { timingSafeEqual } from "node:crypto";
import { config } from "@/modules/core/config";
import { AppError } from "@/modules/core/http/errors";
import { enrich } from "@/modules/core/http/wide-event";

/** Gate for routes the Luanti world calls on a player's behalf. Constant-time: this
 *  secret discloses password hashes, mints sessions and moves MAGI, so a timing
 *  side-channel matters. Length must match before timingSafeEqual (it throws).
 *
 *  `secret` defaults to the real config value so every existing caller keeps its
 *  exact current behavior; a test passes its own value here to exercise the
 *  misconfigured (empty) and invalid-secret (mismatched) branches independently,
 *  without mutating the shared `config` singleton or resetting the module cache. */
export function requireLuantiSecret(
  req: { header: (n: string) => string | undefined },
  secret: string = config.luantiServerSecret
): void {
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
