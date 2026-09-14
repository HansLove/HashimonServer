//alen.ts, la parte que no toca el Postgres real: el reenvío del parámetro
//`client` inyectado y los cortos-circuitos degenerados. Las pruebas contra la
//base de datos real de este mismo módulo (encolar, resolver, el estado
//singleton, la cola de novedades) viven en alen-planner.test.ts a propósito —
//alen_state/alen_orders/alen_events se comparten entre los tres archivos del
//dominio, y este archivo corre en paralelo con ellos vía `node --test`, así
//que aquí sólo entra lo que nunca toca esas tablas de verdad.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fakeSql } from "@/test/support/db";
import { enqueueOrder, consumeEvents } from "@/modules/alen/domain/alen";

describe("alen.ts — el parámetro client reenvía a un Sql inyectado", () => {
  it("enqueueOrder usa el client dado en vez del pool por defecto", async () => {
    const client = fakeSql((text) => (text.startsWith("INSERT") ? [{ id: 42 }] : []));
    const id = await enqueueOrder({ plan: { ttl: 60, verbs: [{ op: "wait" }] } }, client);
    assert.equal(id, 42);
    assert.equal(client.calls.length, 1);
    assert.match(client.calls[0]!.text, /INSERT INTO alen_orders/);
  });

  it("enqueueOrder lanza si el INSERT no devuelve fila (error)", async () => {
    const client = fakeSql(() => []);
    await assert.rejects(
      () => enqueueOrder({ plan: { ttl: 60, verbs: [{ op: "wait" }] } }, client),
      /alen_order_insert_returned_nothing/
    );
  });

  it("consumeEvents con un array vacío es un no-op (degenerado — nunca construye la query)", async () => {
    const client = fakeSql();
    await consumeEvents([], client);
    assert.equal(client.calls.length, 0, "un array vacío debe cortar antes de tocar la BD");
  });
});
