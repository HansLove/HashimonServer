import { config } from "@/config";
import { askModelStructured, type StructuredReply } from "@/domain/anthropic";
import type { TownSituation } from "@/domain/wolkers";

// El consejo del town — la única costura por la que los wolkers tocan un modelo.
//
// La regla que ordena todo el fichero: **la postura siempre existe sin modelo**. `ruleOf`
// decide primero, y lo que el modelo puede hacer es matizar esa decisión y ponerle palabras.
// Si no hay clave, si el tope diario está gastado, si la petición falla o si devuelve una
// postura que no está en la enum, el town sigue funcionando con la regla. Un pueblo que
// deja de comportarse porque se cayó la API no es un pueblo, es una demo.
//
// Y la segunda: se consulta **por town, no por wolker**. Doscientos wolkers hambrientos son
// una decisión, no doscientas. Es lo que hace que esto cueste céntimos en vez de cientos.

export type Posture = "normal" | "rationing" | "shelter" | "exodus";

export interface CouncilDecision {
  posture: Posture;
  /** Frase corta que el mundo muestra en el HUD del alcalde. Nunca vacía. */
  reason: string;
  /** Segundos que el mundo debe mantener esta postura antes de volver a preguntar. */
  ttlS: number;
  source: "rule" | "model" | "cache";
}

const POSTURES: Posture[] = ["normal", "rationing", "shelter", "exodus"];

/** Amenaza que sólo el mundo conoce: raid en curso, jugador hostil dentro del claim. */
export interface CouncilSignal {
  /** Agresores no residentes vistos dentro del claim en el último minuto. */
  hostiles?: number;
  /** Explosiones o bloques rotos por terceros desde la última consulta. */
  damage?: number;
}

/**
 * La decisión determinista. Es el suelo del sistema y por sí sola ya juega: raciona cuando
 * hay poca comida, se refugia cuando entra un hostil, y ordena el éxodo cuando el town ya
 * no da de comer a nadie y encima le están matando gente.
 */
export function ruleOf(s: TownSituation, sig: CouncilSignal = {}): CouncilDecision {
  const hostiles = sig.hostiles ?? 0;
  const perCapita = s.population > 0 ? s.larder / s.population : 0;

  if (s.population > 0 && s.larder === 0 && s.starving > 0 && s.deaths7d >= 2) {
    return { posture: "exodus", reason: "Sin despensa y con muertos: el pueblo se va.", ttlS: 900, source: "rule" };
  }
  if (hostiles > 0 || (sig.damage ?? 0) > 0) {
    return { posture: "shelter", reason: "Hostiles dentro del claim: a cubierto.", ttlS: 120, source: "rule" };
  }
  if (perCapita < 1 || s.starving > 0) {
    return { posture: "rationing", reason: "Despensa corta: raciones y a buscar comida.", ttlS: 600, source: "rule" };
  }
  return { posture: "normal", reason: "El pueblo está bien.", ttlS: 900, source: "rule" };
}

/**
 * ¿Merece esto un modelo? Sólo lo que una regla lee mal: gente muriéndose, moral hundida,
 * un raid en curso. Un town tranquilo NUNCA llega al modelo, y ese es el ahorro de verdad
 * — no el precio del token, sino la llamada que no se hace.
 */
export function worthAsking(s: TownSituation, sig: CouncilSignal = {}): boolean {
  return s.starving > 0 || s.deaths7d >= 2 || s.avgMorale < 30 || (sig.hostiles ?? 0) > 0;
}

// Presupuesto en memoria del proceso: se pierde en un reinicio, y eso es aceptable porque
// el peor caso de perderlo es un día con algunas consultas de más, no un cobro sorpresa.
const lastAsk = new Map<string, number>();
let dayKey = "";
let askedToday = 0;

function budgetOk(townName: string, now: number): boolean {
  const today = new Date(now).toISOString().slice(0, 10);
  if (today !== dayKey) {
    dayKey = today;
    askedToday = 0;
  }
  if (askedToday >= config.wolkerCouncilMaxPerDay) return false;
  const last = lastAsk.get(townName) ?? 0;
  return now - last >= config.wolkerCouncilMinIntervalS * 1000;
}

/** Sólo para tests: el presupuesto es estado de módulo, como la caché de block-template. */
export function resetCouncilBudget(): void {
  lastAsk.clear();
  dayKey = "";
  askedToday = 0;
}

const CACHED_SYSTEM = [
  "Eres el consejo de un pueblo de wolkers en Hashimon, un mundo de voxels.",
  "Los wolkers son la población nativa de un town: comen croquetas minadas por sus",
  "residentes, se defienden dentro de su claim, y emigran al town vecino si viven mal.",
  "Tu única salida es una postura para el pueblo entero, de esta lista:",
  "  normal    — la vida sigue",
  "  rationing — la comida no llega: raciones cortas y prioridad a buscar más",
  "  shelter   — hay peligro dentro del claim: a cubierto, no salir a trabajar",
  "  exodus    — el town ya no es viable: preparar la marcha",
  "Elige la MENOS drástica que resuelva la situación; el éxodo vacía un pueblo y no se",
  "deshace. La razón va en una frase de menos de 90 caracteres, en español, dirigida al",
  "alcalde. No inventes datos que no estén en la situación.",
].join("\n");

const SCHEMA = {
  type: "object",
  properties: {
    posture: { type: "string", enum: POSTURES },
    reason: { type: "string", maxLength: 90 },
  },
  required: ["posture", "reason"],
  additionalProperties: false,
};

/** La forma exacta que el consejo le pide al modelo: una postura y una frase, nada más.
 *  Tipar el hueco así (en vez de `typeof askModelStructured`) es lo que deja inyectar un
 *  doble en los tests sin genéricos sueltos. */
export type CouncilAsk = (opts: {
  model: string;
  cachedSystem: string;
  userContent: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
}) => Promise<StructuredReply<{ posture: string; reason: string }>>;

export interface CouncilOptions {
  now?: number;
  /** Inyectable en tests; por defecto, el modelo real. */
  ask?: CouncilAsk;
  /** Presencia de clave. Inyectable para probar el mundo sin modelo sin tocar `config`. */
  apiKey?: string;
}

/**
 * Decide la postura de un town. El orden importa: regla primero, y el modelo sólo por encima
 * de ella. `source` dice de dónde salió, y el mundo lo registra — si un día el modelo deja de
 * aportar, se ve en los logs antes que en la factura.
 */
export async function councilFor(
  s: TownSituation,
  sig: CouncilSignal = {},
  opts: CouncilOptions = {}
): Promise<CouncilDecision> {
  const now = opts.now ?? Date.now();
  const rule = ruleOf(s, sig);

  if (!(opts.apiKey ?? config.anthropicApiKey)) return rule;
  if (!worthAsking(s, sig)) return rule;
  if (!budgetOk(s.townName, now)) return rule;

  lastAsk.set(s.townName, now);
  askedToday++;

  const ask: CouncilAsk = opts.ask ?? ((o) => askModelStructured<{ posture: string; reason: string }>(o));
  try {
    const reply = await ask({
      model: config.wolkerCouncilModel,
      cachedSystem: CACHED_SYSTEM,
      userContent: JSON.stringify({
        población: s.population,
        despensa: s.larder,
        hambre_media: s.avgHunger,
        moral_media: s.avgMorale,
        muriéndose_de_hambre: s.starving,
        muertos_7d: s.deaths7d,
        hostiles: sig.hostiles ?? 0,
        daño_reciente: sig.damage ?? 0,
        postura_por_regla: rule.posture,
      }),
      schema: SCHEMA,
      maxTokens: 200,
    });
    const posture = reply.data?.posture as Posture | undefined;
    if (!posture || !POSTURES.includes(posture)) return rule;
    const reason = (reply.data?.reason ?? "").trim();
    return {
      posture,
      reason: reason === "" ? rule.reason : reason.slice(0, 90),
      ttlS: rule.ttlS,
      source: "model",
    };
  } catch {
    // Un consejo que no llega no es una avería del pueblo: la regla ya decidió.
    return rule;
  }
}
