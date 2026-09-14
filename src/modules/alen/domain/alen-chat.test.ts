//alen-chat.ts, la parte pura: `clamp` y `buildChatPrompt` no tocan el Postgres
//real. Las pruebas contra la base de datos real de este mismo módulo
//(`chatsToday`, `replyTo`) viven en alen-planner.test.ts a propósito —
//alen_events se comparte entre los tres archivos del dominio de Alen, y este
//archivo corre en paralelo con ellos vía `node --test`, así que aquí sólo
//entra lo que nunca toca esa tabla de verdad.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clamp, buildChatPrompt, type ChatContext } from "@/modules/alen/domain/alen-chat";

describe("clamp — el tope que el esquema no puede aplicar", () => {
  it("un valor no numérico cae a 0 (degenerado)", () => {
    assert.equal(clamp(Number.NaN, -100, 100), 0);
    assert.equal(clamp(undefined, -100, 100), 0);
    assert.equal(clamp("42" as unknown as number, -100, 100), 0);
  });

  it("un valor dentro de rango se redondea tal cual (simple)", () => {
    assert.equal(clamp(12.6, -100, 100), 13);
  });

  it("valores fuera de rango se recortan a cada extremo (edge)", () => {
    assert.equal(clamp(-500, -100, 100), -100);
    assert.equal(clamp(500, -100, 100), 100);
  });

  it("Infinity no es finito y también cae a 0 (edge)", () => {
    assert.equal(clamp(Number.POSITIVE_INFINITY, -50, 50), 0);
  });
});

function baseCtx(overrides: Partial<ChatContext> = {}): ChatContext {
  return { player: "diego", message: "¿por qué me odias?", ...overrides };
}

describe("buildChatPrompt — el prompt de una conversación", () => {
  it("con un contexto mínimo, produce las secciones fijas (degenerado)", () => {
    const prompt = buildChatPrompt(baseCtx());
    assert.match(prompt, /nombre: diego/);
    assert.match(prompt, /cómo lo ves: UNKNOWN/);
    assert.match(prompt, /LO QUE ACABA DE DECIRTE/);
    assert.match(prompt, /¿por qué me odias\?/);
    assert.doesNotMatch(prompt, /LO QUE OS HABÉIS DICHO YA/, "sin historial no debe aparecer la sección");
  });

  it("con historial, lista hasta 8 turnos y recorta cada línea a 200 caracteres (general)", () => {
    const hist = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 === 0 ? "alen" : "diego", text: `turno_${i}` }));
    const prompt = buildChatPrompt(baseCtx({ history: hist }));
    assert.match(prompt, /LO QUE OS HABÉIS DICHO YA/);
    assert.match(prompt, /tú: turno_0/);
    assert.match(prompt, /diego: turno_1/);
    assert.doesNotMatch(prompt, /turno_9/, "el historial se corta a los primeros 8");
  });

  it("con exchangesLeft <= 1 cierra como la última respuesta (edge)", () => {
    const prompt = buildChatPrompt(baseCtx({ exchangesLeft: 1 }));
    assert.match(prompt, /ÚLTIMA respuesta/);
  });

  it("con exchangesLeft == 2 avisa que queda poco interés, sin ser la última (edge)", () => {
    const prompt = buildChatPrompt(baseCtx({ exchangesLeft: 2 }));
    assert.match(prompt, /Te queda poco interés/);
    assert.doesNotMatch(prompt, /ÚLTIMA respuesta/);
  });

  it("con exchangesLeft holgado, no menciona el cierre (simple)", () => {
    const prompt = buildChatPrompt(baseCtx({ exchangesLeft: 10 }));
    assert.doesNotMatch(prompt, /Te queda poco interés/);
    assert.doesNotMatch(prompt, /ÚLTIMA respuesta/);
  });
});
