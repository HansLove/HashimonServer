import { config } from "@/modules/core/config";
import { query, type Sql } from "@/modules/core/db/pool";
import { anthropicConfigured, askModelStructured, AnthropicError } from "@/modules/companion/domain/anthropic";
import { ALEN_SYSTEM_PROMPT } from "@/modules/alen/domain/alen-planner";
import { recordEvent } from "@/modules/alen/domain/alen";

// Hablar con Alen. Es la respuesta a la queja de la segunda partida: "si él usa mi
// nombre, yo debería poder responderle, y la IA se siente tonta".
//
// El reparto es el mismo de siempre y por las mismas razones: el mundo resuelve
// solo lo formulaico (saludos, despedidas) con su banco de frases y cero tokens, y
// aquí llega únicamente lo que merece una respuesta de verdad. Un dragón que
// contesta "hola" con un modelo es dinero tirado; uno que no sabe qué responder a
// "¿por qué me odias?" es el NPC de los 2000 que queremos dejar atrás.
//
// Sobre la caché, MEDIDO y no supuesto: chat con chat sí comparte (segunda llamada
// leyó 1538 tokens cacheados), pero chat con PLANIFICADOR **no** — una llamada del
// planificador justo después de dos de chat dio cache_read = 0. Usan el mismo
// `ALEN_SYSTEM_PROMPT` byte por byte, así que la causa no es el texto: es que cada
// ruta manda un `output_config.format` distinto y el esquema participa en el
// prefijo cacheado.
//
// La consecuencia práctica es pequeña —cada ruta mantiene su propia caché del
// mismo texto, así que se paga una escritura extra por ruta y por expiración— y no
// vale la pena unificar los esquemas para evitarla: chat y plan devuelven cosas
// distintas. Se comparte la constante por coherencia del personaje, no por coste.

// El modelo no devuelve sólo texto: devuelve una LECTURA de la interacción que el
// mundo aplica al estado de Alen. Es lo que permite que una frase que no suena
// agresiva le hiera el ego igualmente, suba una métrica y acabe en un ataque — un
// juicio que ninguna lista de palabras clave puede hacer.
//
// Sin `minimum`/`maximum`: los esquemas de salida estructurada no los admiten. Los
// rangos van en la descripción y se acotan en código.
export const REPLY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "ego", "interest", "respect", "intent"],
  properties: {
    reply: {
      type: "string",
      description:
        "Lo que Alen responde. UNA o dos frases, en español, en su voz: antiguo, " +
        "superior, breve. Sin comillas, sin narrar acciones entre asteriscos, sin emoji. " +
        "Cadena VACÍA si decide no dignarse a contestar — el silencio también es una respuesta.",
    },
    ego: {
      type: "integer",
      description:
        "De -100 a 100. Cuánto le ha tocado el ego lo que le han dicho. Negativo si " +
        "lo han humillado, tratado como a un igual o como a una posesión; positivo si " +
        "lo han reconocido como lo que es. ANCLAS, respétalas: insulto directo -60 o " +
        "menos; llamarle 'mío' o hablar de poseerlo/domesticarlo -70 o menos, por " +
        "cortés que suene la frase; darle una orden o pedirle un favor -30; halago " +
        "vacío +10 como mucho, porque la adulación de un inferior no le engrandece. " +
        "No suavices: si la frase merece -60, escribe -60, no -40.",
    },
    interest: {
      type: "integer",
      description:
        "De -50 a 50. Cuánto le ha interesado esta persona. ANCLAS: casi nadie le " +
        "interesa, así que lo normal es 0..5 — un insulto o un halago son ruido " +
        "predecible y NO son interesantes. Por encima de 20 sólo lo imprevisible: " +
        "quien se le planta sin miedo, quien le dice una verdad que no esperaba, " +
        "quien sobrevivió y volvió.",
    },
    respect: {
      type: "integer",
      description:
        "De -50 a 50. Se gana con audacia y con verdad, NUNCA con halagos: adular a " +
        "Alen es confesarse súbdito, y eso RESTA respeto (de -5 a -15). Pedirle " +
        "favores o darle órdenes también resta. Lo normal es 0. Sube sólo ante " +
        "coraje real o una verdad incómoda.",
    },
    intent: {
      type: "string",
      enum: ["ignore", "speak", "warn", "attack", "leave"],
      description:
        "Qué hace Alen a continuación. 'speak' es sólo responder. 'warn' es responder " +
        "anunciando que la próxima vez habrá consecuencias. 'attack' es que esto ha " +
        "cruzado una línea y va a atacar — avisando primero, siempre. 'leave' es " +
        "perder el interés y marcharse. 'ignore' es no dignarse a contestar. " +
        "REGLA: si ego <= -40, el intent NO puede ser 'speak' — es 'warn' como mínimo; " +
        "si ego <= -70, es 'attack'.",
    },
  },
} as const;

export interface ChatContext {
  player: string;
  message: string;
  relation?: {
    label?: string;
    grudge?: number;
    respect?: number;
    sentiment?: number;
    interest?: number;
    timesSeen?: number;
    lastEvent?: string;
  };
  mood?: string;
  anger?: number;
  hp?: number;
  maxHp?: number;
  distance?: number;
  /** Las últimas idas y venidas. Sin esto cada respuesta es una isla, y ESA era la
   *  razón principal de que la conversación se sintiera tonta: contestaba sin
   *  recordar lo que él mismo acababa de decir. */
  history?: Array<{ role: string; text: string }>;
  /** Cuántas respuestas le quedan antes de aburrirse. Se le dice, para que pueda
   *  cerrar la conversación con intención en vez de que se corte de golpe. */
  exchangesLeft?: number;
}

export interface ChatAppraisal {
  ego: number;
  interest: number;
  respect: number;
  intent: "ignore" | "speak" | "warn" | "attack" | "leave";
}

export type ChatResult =
  | { replied: false; why: string }
  | {
      replied: true;
      reply: string;
      appraisal: ChatAppraisal;
      inTokens: number;
      outTokens: number;
      cacheRead: number;
    };

export const clamp = (v: unknown, lo: number, hi: number): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 0;
  return Math.max(lo, Math.min(hi, Math.round(n)));
};

/** Cuántas respuestas de chat lleva hoy. La compuerta es aparte de la del
 *  planificador: conversar y decidir campañas son dos presupuestos distintos. */
export async function chatsToday(client?: Sql): Promise<number> {
  const res = await query<{ n: string }>(
    `SELECT count(*) n FROM alen_events
      WHERE kind = 'chat_respondido' AND created_at > now() - interval '1 day'`,
    [],
    client
  );
  return Number(res.rows[0]?.n ?? 0);
}

/** El prompt de una conversación, aparte de la llamada. Exportado para poder
 *  medirlo: comparar dos modelos sobre el MISMO texto exige que el banco de
 *  pruebas no lo reescriba por su cuenta. Ver scripts/alen-appraisal-bench.mts. */
export function buildChatPrompt(ctx: ChatContext): string {
  const r = ctx.relation ?? {};
  const lines = [
    `ALGUIEN TE HABLA. Estás a ${Math.round(ctx.distance ?? 0)} nodos de él.`,
    ``,
    `QUIÉN`,
    `nombre: ${ctx.player}`,
    `cómo lo ves: ${r.label ?? "UNKNOWN"}`,
    `rencor ${Math.round(r.grudge ?? 0)} · respeto ${Math.round(r.respect ?? 0)} · ` +
      `aprecio ${Math.round(r.sentiment ?? 0)} · interés ${Math.round(r.interest ?? 0)}`,
    `veces visto: ${r.timesSeen ?? 0} · lo último entre vosotros: ${r.lastEvent ?? "nada"}`,
    ``,
    `CÓMO ESTÁS`,
    `humor: ${ctx.mood ?? "?"} · ira ${Math.round(ctx.anger ?? 0)} · ` +
      `vida ${Math.round(ctx.hp ?? 0)}/${Math.round(ctx.maxHp ?? 0)}`,
    ``,
  ];

  const hist = ctx.history ?? [];
  if (hist.length > 0) {
    lines.push(`LO QUE OS HABÉIS DICHO YA`);
    for (const t of hist.slice(0, 8)) {
      lines.push(`${t.role === "alen" ? "tú" : ctx.player}: ${t.text.slice(0, 200)}`);
    }
    lines.push(``);
  }

  lines.push(
    `LO QUE ACABA DE DECIRTE`,
    ctx.message,
    ``,
    `Respóndele. Una o dos frases, en su cara.`,
    ``,
    `CÓMO HABLAS`,
    `Tienes complejo de dios y lo tienes ganado. Hablas en absolutos. Mides el tiempo`,
    `en eras, no en días. Lo que te ofende de un golpe no es el daño: es la insolencia`,
    `de haber sido tocado por algo inferior. No haces chistes. No narras tus acciones`,
    `entre asteriscos. No te repites.`,
    ``,
    `SIEMPRE AVISAS ANTES DE ACTUAR. Si vas a destruirlo, se lo dices primero — eres`,
    `un dios, no un asesino a traición. Y puedes llegar a apreciar a alguien: si te`,
    `ha entretenido, si sobrevivió, si vuelve, dilo a tu manera, sin volverte amable.`,
    ``,
    `NO SIEMPRE HAY QUE CONTESTAR. Si lo que te han dicho no merece tu voz, devuelve`,
    `reply vacío e intent "ignore": mirar fijamente y no decir nada es una respuesta`,
    `más temible que cualquier frase.`,
    ``,
    `ADEMÁS DE RESPONDER, JUZGAS. Rellena ego, interest y respect con lo que esto te`,
    `ha hecho sentir de verdad, no con lo que suena. Una frase educada puede ser una`,
    `humillación; una insolencia puede resultarte divertida. Si te han tratado como a`,
    `una posesión, como a un igual, o te han dado órdenes, el ego va muy abajo y el`,
    `intent puede ser "attack" — pero incluso entonces avisas antes.`,
  );

  const left = ctx.exchangesLeft;
  if (typeof left === "number" && left <= 2) {
    lines.push(
      ``,
      left <= 1
        ? `Esta es la ÚLTIMA respuesta que le das antes de perder el interés. Ciérrala como quien despide una audiencia.`
        : `Te queda poco interés en esta conversación. Que se empiece a notar.`
    );
  }

  return lines.join("\n");
}

/** `deps.client` swaps the Postgres client (mirrors `withTransaction`'s `Sql`
 *  param across `alen.ts`); `deps.askModel` swaps the Anthropic call. Both
 *  default to the real implementations, so calling `replyTo(ctx)` is unchanged. */
export async function replyTo(
  ctx: ChatContext,
  deps: { client?: Sql; askModel?: typeof askModelStructured } = {}
): Promise<ChatResult> {
  const { client, askModel = askModelStructured } = deps;

  if (!anthropicConfigured()) return { replied: false, why: "sin_clave" };

  const used = await chatsToday(client);
  if (used >= config.alenChatMaxPerDay) {
    return { replied: false, why: "tope_diario_chat" };
  }

  let out;
  try {
    out = await askModel<{
      reply: string; ego: number; interest: number; respect: number;
      intent: ChatAppraisal["intent"];
    }>({
      model: config.alenChatModel,
      cachedSystem: ALEN_SYSTEM_PROMPT, // el MISMO prefijo: acierto de caché compartido
      userContent: buildChatPrompt(ctx),
      schema: REPLY_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 300,
    });
  } catch (err) {
    const msg = err instanceof AnthropicError ? err.message : String(err);
    await recordEvent({ kind: "chat_error", actor: ctx.player, payload: { error: msg.slice(0, 200) } }, client);
    return { replied: false, why: "error_proveedor" };
  }

  const d = out.data;
  if (!d) return { replied: false, why: "respuesta_vacia" };

  // Una respuesta vacía NO es un fallo: es Alen decidiendo no dignarse a
  // contestar. El mundo aplica igualmente lo que ha sentido, que es lo que
  // convierte el silencio en una reacción y no en un cuelgue.
  const reply = (d.reply ?? "").trim();
  const appraisal: ChatAppraisal = {
    ego: clamp(d.ego, -100, 100),
    interest: clamp(d.interest, -50, 50),
    respect: clamp(d.respect, -50, 50),
    intent: (["ignore", "speak", "warn", "attack", "leave"] as const).includes(d.intent)
      ? d.intent
      : "speak",
  };

  await recordEvent(
    {
      kind: "chat_respondido",
      actor: ctx.player,
      payload: {
        dijo: ctx.message.slice(0, 160),
        respondio: reply.slice(0, 160) || "(silencio)",
        ego: appraisal.ego,
        intencion: appraisal.intent,
        tokens_in: out.inputTokens,
        tokens_out: out.outputTokens,
        cache_read: out.cacheReadTokens,
      },
    },
    client
  );

  return {
    replied: true,
    reply: reply.slice(0, 240),
    appraisal,
    inTokens: out.inputTokens,
    outTokens: out.outputTokens,
    cacheRead: out.cacheReadTokens,
  };
}
