//Cliente de Anthropic. La única puerta por la que el juego habla con un modelo.
//
//Antes el navegador llamaba directo al proveedor con la clave en localStorage.
//Eso hacía imposible las tres cosas que la fase 1 necesita: medir el gasto,
//recordar lo que pasó y cobrar. El servidor no está aquí por la clave — está
//aquí porque es el único sitio donde esas tres cosas pueden ocurrir.
//
//El camino local (Ollama, en ihashima-website/src/lib/llm.ts) NO se retira: es
//la visión V3 y sigue disponible para quien ponga su propio modelo, sin memoria
//ni créditos.

import { config } from "@/config";

const API = "https://api.anthropic.com/v1/messages";

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type ModelReply = {
  text: string;
  inputTokens: number;
  outputTokens: number;
};

export class AnthropicError extends Error {
  constructor(message: string, readonly status: number, readonly retryable: boolean) {
    super(message);
    this.name = "AnthropicError";
  }
}

export function anthropicConfigured(): boolean {
  return Boolean(config.anthropicApiKey);
}

export async function askModel(
  system: string,
  messages: ChatMessage[],
  opts: {
    maxTokens?: number;
    signal?: AbortSignal;
    /** Optional JSON schema; keeps the full chat history (unlike askModelStructured). */
    schema?: Record<string, unknown>;
  } = {}
): Promise<ModelReply> {
  if (!config.anthropicApiKey) {
    throw new AnthropicError("ANTHROPIC_API_KEY no está configurada", 503, false);
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": config.anthropicApiKey,
    "anthropic-version": "2023-06-01",
  };
  // Identity-linked / multi-workspace keys require this; omit for single-workspace keys.
  if (config.anthropicWorkspaceId) {
    headers["anthropic-workspace-id"] = config.anthropicWorkspaceId;
  }

  const body: Record<string, unknown> = {
    model: config.anthropicModel,
    //Una mascota habla corto. El tope es también el techo de gasto por turno.
    max_tokens: opts.maxTokens ?? 300,
    system,
    messages,
  };
  if (opts.schema) {
    body.output_config = {
      format: { type: "json_schema", schema: opts.schema },
    };
  }

  let res: Response;
  try {
    res = await fetch(API, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    throw new AnthropicError(`no se pudo contactar al proveedor: ${String(err)}`, 502, true);
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    //429 y 5xx se pueden reintentar; 400 y 401 son culpa nuestra y no.
    throw new AnthropicError(
      `el proveedor respondió ${res.status}: ${bodyText.slice(0, 300)}`,
      res.status,
      res.status === 429 || res.status >= 500
    );
  }

  const data = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = (data.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("")
    .trim();

  return {
    text,
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
  };
}

//---------------------------------------------------------------------------
//Llamada con ESQUEMA y CACHÉ, para el planificador de Alen.
//
//Dos diferencias con askModel, y las dos son de dinero:
//
//1. `cache_control` sobre el prefijo estable. La persona de Alen, el manual de
//   verbos y las reglas del mundo son idénticos byte a byte en cada llamada y son
//   el grueso de la entrada. Cachearlos es la mayor palanca de coste que existe
//   aquí. El prefijo tiene que ir PRIMERO y no puede llevar nada volátil dentro:
//   una fecha, un id, un contador, y la caché se invalida entera en silencio.
//
//2. `output_config.format` con un json_schema. El plan vuelve validado por el
//   proveedor en vez de "casi JSON" dentro de prosa, así que no hace falta
//   arrancarlo de un bloque de markdown ni reintentar por comas de más.
//
//Devuelve además los tokens de caché, que son la única forma de saber si el
//ahorro está ocurriendo de verdad: si cacheRead sale 0 llamada tras llamada,
//algo volátil se coló en el prefijo.

export type StructuredReply<T> = {
  data: T | null;
  raw: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  model: string;
};

/** Los modelos Haiku y anteriores rechazan output_config.effort con un 400. */
function supportsEffort(model: string): boolean {
  return !/haiku|sonnet-4-5/.test(model);
}

export async function askModelStructured<T>(opts: {
  model: string;
  /** Prefijo estable y cacheable. Nada volátil aquí dentro. */
  cachedSystem: string;
  /** La parte que cambia en cada llamada. Va después del punto de caché. */
  userContent: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
  signal?: AbortSignal;
}): Promise<StructuredReply<T>> {
  if (!config.anthropicApiKey) {
    throw new AnthropicError("ANTHROPIC_API_KEY no está configurada", 503, false);
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": config.anthropicApiKey,
    "anthropic-version": "2023-06-01",
  };
  if (config.anthropicWorkspaceId) {
    headers["anthropic-workspace-id"] = config.anthropicWorkspaceId;
  }

  const outputConfig: Record<string, unknown> = {
    format: { type: "json_schema", schema: opts.schema },
  };
  //Un plan es una decisión corta sobre un estado ya resumido: no necesita
  //esfuerzo alto, y bajarlo es la segunda palanca de coste después de la caché.
  if (supportsEffort(opts.model)) {
    outputConfig.effort = "low";
  }

  let res: Response;
  try {
    res = await fetch(API, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens ?? 1500,
        system: [
          { type: "text", text: opts.cachedSystem, cache_control: { type: "ephemeral" } },
        ],
        messages: [{ role: "user", content: opts.userContent }],
        output_config: outputConfig,
      }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    throw new AnthropicError(`no se pudo contactar al proveedor: ${String(err)}`, 502, true);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new AnthropicError(
      `el proveedor respondió ${res.status}: ${body.slice(0, 300)}`,
      res.status,
      res.status === 429 || res.status >= 500
    );
  }

  const data = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  const raw = (data.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("")
    .trim();

  let parsed: T | null = null;
  try {
    parsed = JSON.parse(raw) as T;
  } catch {
    //El esquema hace esto muy improbable, pero un null aquí es un plan que no se
    //encola — nunca un plan a medias.
    parsed = null;
  }

  return {
    data: parsed,
    raw,
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
    cacheReadTokens: data.usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: data.usage?.cache_creation_input_tokens ?? 0,
    model: opts.model,
  };
}
