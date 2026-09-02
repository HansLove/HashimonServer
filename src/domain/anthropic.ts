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
  opts: { maxTokens?: number; signal?: AbortSignal } = {}
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

  let res: Response;
  try {
    res = await fetch(API, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.anthropicModel,
        //Una mascota habla corto. El tope es también el techo de gasto por turno.
        max_tokens: opts.maxTokens ?? 300,
        system,
        messages,
      }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    throw new AnthropicError(`no se pudo contactar al proveedor: ${String(err)}`, 502, true);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    //429 y 5xx se pueden reintentar; 400 y 401 son culpa nuestra y no.
    throw new AnthropicError(
      `el proveedor respondió ${res.status}: ${body.slice(0, 300)}`,
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
