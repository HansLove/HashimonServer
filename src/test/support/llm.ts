/**
 * One canonical Anthropic double for the three modules whose adapter-added
 * seam swaps the LLM call: companion/domain/chat.ts (`ChatDeps.askModel`),
 * alen-planner.ts and alen-chat.ts (`deps.askModel`, both typed against
 * `askModelStructured`). No network call, no `config.anthropicApiKey` needed.
 */
import type { askModel, askModelStructured, ModelReply, StructuredReply } from "@/modules/companion/domain/anthropic";

/** Matches `typeof askModel` (companion/domain/chat.ts's `ChatDeps.askModel`). */
export function fakeAskModel(reply: Partial<ModelReply> = {}): typeof askModel {
  return async function askModel(): Promise<ModelReply> {
    return {
      text: reply.text ?? "",
      inputTokens: reply.inputTokens ?? 0,
      outputTokens: reply.outputTokens ?? 0,
    };
  };
}

/**
 * Matches `typeof askModelStructured` (alen-planner.ts / alen-chat.ts's
 * `deps.askModel`). Declared as an actual generic function so it stays
 * assignable at the call site's own `askModel<PlannerOutput>({...})` /
 * `askModel<ReplyOutput>({...})` type argument, whatever the caller's T is —
 * `data` is handed back as-is via that generic, only unwrapped through
 * `unknown` since this double does not know T ahead of time.
 */
export function fakeAskModelStructured(
  data: unknown,
  overrides: Partial<Omit<StructuredReply<unknown>, "data">> = {}
): typeof askModelStructured {
  return async function askModel<T>(): Promise<StructuredReply<T>> {
    return {
      data: data as T | null,
      raw: overrides.raw ?? JSON.stringify(data),
      inputTokens: overrides.inputTokens ?? 0,
      outputTokens: overrides.outputTokens ?? 0,
      cacheReadTokens: overrides.cacheReadTokens ?? 0,
      cacheWriteTokens: overrides.cacheWriteTokens ?? 0,
      model: overrides.model ?? "fake-model",
    };
  };
}

/** A `StructuredReply` whose model call failed to produce parseable output. */
export function fakeAskModelStructuredNull(
  raw = "not json",
  overrides: Partial<Omit<StructuredReply<unknown>, "data" | "raw">> = {}
): typeof askModelStructured {
  return fakeAskModelStructured(null, { ...overrides, raw });
}
