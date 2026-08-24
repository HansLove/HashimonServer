import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { createApp } from "@/http/app";
import { createLogger } from "@/logger";

//The contract this guards: ONE line per request, carrying the envelope and what
//the handlers enriched. No database — both cases fail before any query, which is
//what keeps this a unit test instead of an integration one.

const lines: Record<string, unknown>[] = [];
const sink = { write: (line: string) => { lines.push(JSON.parse(line)); } };

async function request(path: string): Promise<Record<string, unknown>> {
  lines.length = 0;
  const app = createApp(createLogger(sink));
  const server = app.listen(0);
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    //Drain the body: fetch resolves on headers alone, which can beat the server's
    //own finish event. A fully read body means the response was already flushed.
    await (await fetch(`http://127.0.0.1:${port}${path}`)).text();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    server.close();
  }
  assert.equal(lines.length, 1, "a request must emit exactly one event");
  return lines[0]!;
}

test("an unmatched request emits one event with the raw path", async () => {
  const event = await request("/nope?q=1");

  assert.equal(event.event, "http_request");
  assert.equal(event.service, "hashimon-server");
  assert.equal(typeof event.request_id, "string");
  assert.equal(event.method, "GET");
  assert.equal(event.path, "unmatched");
  assert.equal(event.path_raw, "/nope");
  assert.equal(event.status_code, 404);
  assert.equal(event.outcome, "client_error");
  assert.equal(typeof event.duration_ms, "number");
  assert.equal(event.db_query_count, 0);
});

test("a rejected request carries the route template and the error code", async () => {
  const event = await request("/hashimons");

  assert.equal(event.path, "/hashimons");
  assert.equal(event.status_code, 401);
  assert.equal(event.outcome, "client_error");
  assert.equal(event.error_code, "unauthenticated");
});
