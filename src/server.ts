import { createApp } from "@/modules/core/http/app";
import { config } from "@/modules/core/config";
import { pool, waitForDb } from "@/modules/core/db/pool";
import { logger } from "@/modules/core/logger";

const app = createApp();
const startedAt = Date.now();

try {
  await waitForDb(logger);
} catch {
  process.exit(1);
}

const server = app.listen(config.port, () => {
  logger.info({ event: "server_start", port: config.port });
});

//Close cleanly so nodemon/tsx restarts and container shutdowns don't leak
//connections.
async function shutdown(signal: string) {
  logger.info({ event: "shutdown", signal, uptime_ms: Date.now() - startedAt });
  server.close();
  await pool.end();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
