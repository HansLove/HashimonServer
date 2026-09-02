//La conversación con tu compañero: cupo, créditos, memoria y estado.
//
//Todo lo que el navegador no puede hacer por sí solo. Ver docs/COMPANION_V1.md.

import { config } from "@/config";
import { query, withTransaction, type DbClient } from "@/db/pool";
import { askModel, type ChatMessage } from "@/domain/anthropic";
import {
  buildSystemPrompt, memoryPrompt, temperamentOf, wellbeingOf,
  MEMORY_PROFILE, type CareKind, type CompanionRow, type Wellbeing,
} from "@/domain/companion";
import type { SpiritKey } from "@/core/birth-identity";

//Cuántos turnos anteriores se le pasan al modelo. Corto a propósito: la
//continuidad larga es trabajo de la memoria, no del historial. Un animal no
//recuerda la conversación de hace tres semanas palabra por palabra.
const CONTEXT_TURNS = 8;

//Cada cuántos turnos se le pide un recuerdo. Ver el comentario en speak().
const MEMORY_EVERY = 3;

//Salida temprana del bloque de memoria sin ensuciar el flujo con condicionales.
class SkipMemory extends Error {}

export type ChatState = {
  wellbeing: Wellbeing;
  keepsakes: string[];
  turnsUsed: number;
  freeTurnsLeft: number;
  credits: number;
};

async function ensureState(hashimonId: string): Promise<CompanionRow> {
  const r = await query<CompanionRow>(
    `INSERT INTO companion_state (hashimon_id) VALUES ($1)
       ON CONFLICT (hashimon_id) DO UPDATE SET hashimon_id = EXCLUDED.hashimon_id
     RETURNING fed_at, talked_at, mined_at, world_at, last_sector`,
    [hashimonId]
  );
  return r.rows[0]!;
}

export async function loadState(hashimonId: string, ownerId: string): Promise<ChatState> {
  const row = await ensureState(hashimonId);
  const mem = await query<{ text: string }>(
    `SELECT text FROM companion_memory WHERE hashimon_id = $1 ORDER BY created_at DESC LIMIT 12`,
    [hashimonId]
  );
  const used = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM chat_turns WHERE hashimon_id = $1 AND role = 'user'`,
    [hashimonId]
  );
  const player = await query<{ credits: string }>(
    `SELECT credits::text AS credits FROM players WHERE id = $1`, [ownerId]
  );
  const turnsUsed = Number(used.rows[0]?.n ?? 0);
  return {
    wellbeing: wellbeingOf(row),
    //De más viejo a más reciente: así el prompt los lee como se acumularon.
    keepsakes: mem.rows.map((r) => r.text).reverse(),
    turnsUsed,
    freeTurnsLeft: Math.max(0, config.chatFreeTurns - turnsUsed),
    credits: Number(player.rows[0]?.credits ?? 0),
  };
}

export class ChatDenied extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "ChatDenied";
  }
}

export type SpeakInput = {
  hashimonId: string;
  ownerId: string;
  name: string;
  dna: string;
  spirit: SpiritKey | null;
  element: string | null;
  stage: number;
  message: string;
};

export async function speak(input: SpeakInput): Promise<{
  reply: string; wellbeing: Wellbeing; freeTurnsLeft: number; credits: number; keepsake: string | null;
}> {
  const state = await loadState(input.hashimonId, input.ownerId);

  //EL COBRO SE COMPRUEBA ANTES DE LLAMAR AL PROVEEDOR, nunca después. Es la
  //única barrera entre una factura y una sorpresa: si se comprobara al volver,
  //un jugador sin créditos ya habría gastado el token.
  const needsCredits = state.freeTurnsLeft <= 0;
  if (needsCredits && state.credits < config.chatCreditsPerTurn) {
    throw new ChatDenied(
      `sin créditos: este turno cuesta ${config.chatCreditsPerTurn} y tienes ${state.credits}`,
      "insufficient_credits"
    );
  }

  const history = await query<{ role: "user" | "assistant"; content: string }>(
    `SELECT role, content FROM (
       SELECT role, content, created_at FROM chat_turns
        WHERE hashimon_id = $1 ORDER BY created_at DESC LIMIT $2
     ) t ORDER BY created_at ASC`,
    [input.hashimonId, CONTEXT_TURNS]
  );

  const system = buildSystemPrompt({
    name: input.name, dna: input.dna, spirit: input.spirit,
    element: input.element, stage: input.stage,
    wellbeing: state.wellbeing, keepsakes: state.keepsakes,
  });

  const messages: ChatMessage[] = [...history.rows, { role: "user", content: input.message }];
  const reply = await askModel(system, messages);

  //El recuerdo NO se pide cada turno. Un animal no se queda con algo nuevo en
  //cada frase, y la segunda llamada cuesta casi tanto como la primera —medido:
  //$0.00120 de $0.00251 por turno—. Pedirlo cada MEMORY_EVERY turnos es a la vez
  //más barato (−32%) y más creíble.
  //
  //Va DESPUÉS de tener la respuesta: si falla, el jugador ya tiene su
  //conversación y sólo pierde el recuerdo.
  let keepsake: string | null = null;
  const turnNumber = state.turnsUsed + 1;
  try {
    if (turnNumber % MEMORY_EVERY !== 0) throw new SkipMemory();
    const t = temperamentOf(input.dna);
    const k = await askModel(system, [...messages, { role: "assistant", content: reply.text },
      { role: "user", content: memoryPrompt(t) }], { maxTokens: 80 });
    const line = k.text.trim().replace(/^["'\s]+|["'\s]+$/g, "");
    if (line && line.toUpperCase() !== "NADA" && line.length <= 240) keepsake = line;
  } catch (err) {
    //Un recuerdo perdido no es un error del turno.
    void err;
  }

  const spent = needsCredits ? config.chatCreditsPerTurn : 0;
  const cap = MEMORY_PROFILE[temperamentOf(input.dna)].capacity;

  await withTransaction(async (c: DbClient) => {
    await c.query(
      `INSERT INTO chat_turns (hashimon_id, role, content) VALUES ($1,'user',$2)`,
      [input.hashimonId, input.message]
    );
    await c.query(
      `INSERT INTO chat_turns (hashimon_id, role, content, input_tokens, output_tokens, credits_spent)
       VALUES ($1,'assistant',$2,$3,$4,$5)`,
      [input.hashimonId, reply.text, reply.inputTokens, reply.outputTokens, spent]
    );
    if (spent > 0) {
      await c.query(`UPDATE players SET credits = credits - $2 WHERE id = $1`, [input.ownerId, spent]);
    }
    if (keepsake) {
      await c.query(`INSERT INTO companion_memory (hashimon_id, text) VALUES ($1,$2)`,
        [input.hashimonId, keepsake]);
      //La capacidad la dicta el temperamento: un `aloof` conserva dos.
      await c.query(
        `DELETE FROM companion_memory WHERE id IN (
           SELECT id FROM companion_memory WHERE hashimon_id = $1
            ORDER BY created_at DESC OFFSET $2)`,
        [input.hashimonId, cap]
      );
    }
    //Hablar es compañía: atiende ese cuidado y sólo ese.
    await c.query(
      `UPDATE companion_state SET talked_at = now(), updated_at = now() WHERE hashimon_id = $1`,
      [input.hashimonId]
    );
  });

  const after = await loadState(input.hashimonId, input.ownerId);
  return {
    reply: reply.text, wellbeing: after.wellbeing,
    freeTurnsLeft: after.freeTurnsLeft, credits: after.credits, keepsake,
  };
}

//Atender un cuidado concreto. Es lo que cierra el bucle: la criatura pide, el
//jugador hace algo en el mundo, y el cuidado sube.
export async function care(hashimonId: string, kind: CareKind, sector?: string): Promise<Wellbeing> {
  const column = { hunger: "fed_at", company: "talked_at", exercise: "mined_at", world: "world_at" }[kind];
  await ensureState(hashimonId);
  const r = await query<CompanionRow>(
    `UPDATE companion_state
        SET ${column} = now(), updated_at = now(),
            last_sector = COALESCE($2, last_sector)
      WHERE hashimon_id = $1
      RETURNING fed_at, talked_at, mined_at, world_at, last_sector`,
    [hashimonId, sector ?? null]
  );
  return wellbeingOf(r.rows[0]!);
}
