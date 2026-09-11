// Connection probe for the db-tests skill. Resolves DATABASE_URL exactly as the server
// and the test suites do (dotenv from the cwd, then config.ts's fallback), and prints
// only user@host:port/db — never the password, never the rest of .env.
//
// Run from the repo root: node .claude/skills/db-tests/probe-db.mjs [--wait <seconds>]
// --wait retries once per second, because a foreground `sleep` is blocked in the Bash tool.
import "dotenv/config";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import pg from "pg";

// Keep in sync with config.databaseUrl in src/modules/core/config.ts.
const connectionString = process.env.DATABASE_URL ?? "postgres://localhost:5432/hashimon";
const target = describe(connectionString);
const { values } = parseArgs({ options: { wait: { type: "string", default: "0" } } });
const deadline = Date.now() + (Number(values.wait) || 0) * 1000;

for (;;) {
  const error = await tryConnect();
  if (!error) {
    console.log(`db: reachable ${target}`);
    process.exit(0);
  }
  if (Date.now() >= deadline) {
    // A connection timeout carries no code, only its message.
    console.log(`probe-db: ${error.code ?? "TIMEOUT"} ${error.message} target=${target}`);
    process.exit(1);
  }
  await sleep(1000);
}

async function tryConnect() {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return null;
  } catch (error) {
    return error;
  } finally {
    await client.end().catch(() => {});
  }
}

function describe(raw) {
  try {
    const url = new URL(raw);
    const user = decodeURIComponent(url.username) || "(default user)";
    return `${user}@${url.hostname}:${url.port || 5432}/${url.pathname.slice(1)}`;
  } catch {
    return "(DATABASE_URL is not a parseable URL)";
  }
}
