import { createApp } from "./http/app";
import { config } from "./config";
import { pool } from "./db/pool";

const app = createApp();

const server = app.listen(config.port, () => {
  console.log(`Hashimon server (referee) listening on :${config.port} [${config.env}]`);
});

//Close cleanly so nodemon/tsx restarts and container shutdowns don't leak
//connections.
async function shutdown(signal: string) {
  console.log(`\n${signal} received, shutting down`);
  server.close();
  await pool.end();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
