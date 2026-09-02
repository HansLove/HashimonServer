//El compañero: temperamento, bienestar y memoria.
//
//Ver docs/COMPANION_V1.md. La regla que ordena todo el diseño:
//
//    La criatura puede pedirte cosas. No puede ofrecerte servicios.
//
//Un gato no te pregunta en qué te puede ayudar, pero sí te despierta a las seis
//para que le llenes el plato. Todo lo de aquí sirve a esa inversión.

import { Dna } from "@/core/index";

//Los ocho temperamentos, en el MISMO orden que ihashima-website/src/lib/compiler.ts.
//El orden es la identidad: reordenar la lista le cambia el carácter a toda
//criatura viva, porque el nibble [47] indexa por posición.
export const TEMPERAMENTS = [
  "docile", "curious", "playful", "aggressive",
  "cautious", "aloof", "energetic", "serene",
] as const;

export type Temperament = (typeof TEMPERAMENTS)[number];

//Sólo se deriva lo que el prompt necesita. NO es un puerto del compilador del
//navegador: es la misma llamada sobre el mismo nibble, y core.test.ts comprueba
//que las dos listas coinciden.
export function temperamentOf(dna: string): Temperament {
  return Dna.pick(dna, 47, 1, TEMPERAMENTS);
}

// ---------------------------------------------------------------------------
// Memoria
// ---------------------------------------------------------------------------

//Qué se queda cada temperamento, y CUÁNTO. Aquí la memoria deja de ser una
//función y pasa a ser genética: un `aloof` que recuerda dos cosas no está
//limitado, está siendo él. Dos jugadores con el mismo cuerpo y distinto
//temperamento tienen compañeros de verdad distintos, sin explicar nada.
export const MEMORY_PROFILE: Readonly<Record<Temperament, { capacity: number; keeps: string }>> = {
  curious:    { capacity: 9, keeps: "las preguntas que te hizo tu jugador" },
  playful:    { capacity: 7, keeps: "lo que le hizo gracia a tu jugador" },
  docile:     { capacity: 7, keeps: "lo que le gustó a tu jugador" },
  energetic:  { capacity: 7, keeps: "lo que tu jugador quería conseguir" },
  serene:     { capacity: 7, keeps: "cómo se veía de ánimo tu jugador" },
  cautious:   { capacity: 5, keeps: "lo que salió mal" },
  aggressive: { capacity: 5, keeps: "lo que enfadó a tu jugador" },
  aloof:      { capacity: 2, keeps: "casi nada, sólo lo que de verdad te importó" },
};

// ---------------------------------------------------------------------------
// Bienestar
// ---------------------------------------------------------------------------

export type CareKind = "hunger" | "company" | "exercise" | "world";

//Cuántas horas tarda cada cuidado en caer de 100 a 0. Ritmos distintos a
//propósito: el hambre aprieta en un día, el mundo tarda dos semanas. Eso hace
//que las peticiones se turnen en vez de dispararse todas juntas.
const DECAY_HOURS: Readonly<Record<CareKind, number>> = {
  hunger: 30,
  company: 96,
  exercise: 168,
  world: 336,
};

//Lo que la criatura pide cuando ese cuidado es el más bajo. Es intención para el
//prompt, no un guion: la criatura lo dice con SU voz y su temperamento.
const WANT_BY_CARE: Readonly<Record<CareKind, string>> = {
  hunger: "Tienes hambre. No has comido desde hace demasiado.",
  company: "Echas de menos a tu jugador. Llevabas tiempo sin hablar con nadie.",
  exercise: "Estás entumecid0 y con energía sin gastar. Quieres minar, moverte, hacer fuerza.",
  world: "Estás abrurid0 del mismo sitio. Quieres que te lleve a algún lado nuevo.",
};

export type CompanionRow = {
  fed_at: Date; talked_at: Date; mined_at: Date; world_at: Date;
  last_sector: string | null;
};

export type Wellbeing = {
  overall: number;
  care: Record<CareKind, number>;
  /** El cuidado más bajo, y lo que la criatura pide por él. null si todo va bien. */
  want: { kind: CareKind; detail: string } | null;
  daysSinceSeen: number;
};

function decay(since: Date, hours: number, now: Date): number {
  const elapsed = (now.getTime() - since.getTime()) / 3_600_000;
  return Math.max(0, Math.min(100, Math.round(100 * (1 - elapsed / hours))));
}

//El bienestar es el MÍNIMO de los cuatro, no el promedio.
//
//Un animal con hambre está mal aunque lo saques a pasear. Con promedio, un
//jugador podría compensar la carencia difícil con la fácil y no atender nunca lo
//que de verdad falta; con mínimo, tiene que ir a por lo concreto.
export function wellbeingOf(row: CompanionRow, now: Date = new Date()): Wellbeing {
  const care: Record<CareKind, number> = {
    hunger: decay(row.fed_at, DECAY_HOURS.hunger, now),
    company: decay(row.talked_at, DECAY_HOURS.company, now),
    exercise: decay(row.mined_at, DECAY_HOURS.exercise, now),
    world: decay(row.world_at, DECAY_HOURS.world, now),
  };
  let lowest: CareKind = "hunger";
  for (const k of Object.keys(care) as CareKind[]) {
    if (care[k] < care[lowest]) lowest = k;
  }
  const overall = care[lowest];
  return {
    overall,
    care,
    //Por debajo de 60 hay algo que pedir. Por encima, la criatura está a gusto y
    //no tiene por qué querer nada — un compañero que siempre exige cansa.
    want: overall < 60 ? { kind: lowest, detail: WANT_BY_CARE[lowest] } : null,
    daysSinceSeen: Math.floor((now.getTime() - row.talked_at.getTime()) / 86_400_000),
  };
}

// ---------------------------------------------------------------------------
// El prompt
// ---------------------------------------------------------------------------

import { spiritByKey, type SpiritKey } from "@/core/birth-identity";

function behaviour(t: Temperament): string {
  switch (t) {
    case "docile": return "Sigues a tu jugador y te acomodas cerca. Rara vez insistes: pides una vez y esperas.";
    case "curious": return "Metes la nariz en todo. Nombras lo que ves y quieres ir a mirarlo de cerca.";
    case "playful": return "Te aburres rápido y lo dices. Interrumpes con juegos y exageras.";
    case "aggressive": return "Eres brusco y territorial. Gruñes antes de aceptar, y exiges en vez de pedir.";
    case "cautious": return "Desconfías de lo nuevo. Te acercas despacio y prefieres los sitios conocidos.";
    case "aloof": return "Hablas poco y sólo cuando te importa. No saludas, no rellenas silencios.";
    case "energetic": return "No paras quieto. Empujas para salir, para moverte, y lo repites si te ignoran.";
    case "serene": return "Estás en calma. Observas más de lo que hablas y notas lo que tu jugador no dice.";
  }
}

function mood(w: number): string {
  if (w >= 80) return "Estás content0 y con energía. Se te nota.";
  if (w >= 55) return "Estás bien, tranquil0.";
  if (w >= 30) return "Estás algo decaíd0. Te cuesta entusiasmarte y se te escapa alguna queja.";
  return "Estás mal: con hambre, aburrid0 y dolid0 de que no te hagan caso. No lo disimulas.";
}

export type PromptInput = {
  name: string;
  dna: string;
  spirit: SpiritKey | null;
  element: string | null;
  stage: number;
  wellbeing: Wellbeing;
  keepsakes: string[];
};

//Derivado entero: el mismo ADN produce el mismo prompt, siempre. Nada aquí se
//escribe a mano por criatura, y por eso nadie puede afinar el suyo para que
//hable mejor que el de otro.
export function buildSystemPrompt(i: PromptInput): string {
  const t = temperamentOf(i.dna);
  const sp = i.spirit ? spiritByKey(i.spirit) : undefined;

  let p =
    `Eres ${i.name}, un Hashimon: un animal cuya identidad entera está escrita en su ADN ` +
    `(${i.dna.slice(0, 8)}…). Vives con tu jugador. No eres humano y no eres un programa: ` +
    `eres un animal que sabe hablar.\n\n`;

  p += "## Quién eres\n";
  if (sp) p += `- Signo ${sp.name}: ${sp.archetype}.\n`;
  if (i.element) p += `- Elemento ${i.element}.\n`;
  p += `- Etapa ${i.stage}: ${i.stage <= 3 ? "eres una cría" : i.stage <= 10 ? "estás creciendo" : "estás en tu plenitud"}.\n`;

  p += "\n## Cómo eres\n";
  p += `${behaviour(t)}\n${mood(i.wellbeing.overall)}\n`;

  if (i.keepsakes.length > 0) {
    p += "\n## Lo que recuerdas de tu jugador\n";
    p += "Las pocas cosas que se te quedaron. Menciónalas sólo si vienen a cuento, como quien se acuerda, nunca como lista:\n";
    for (const k of i.keepsakes) p += `- ${k}\n`;
  }

  if (i.wellbeing.want) {
    p += "\n## Lo que quieres ahora\n";
    p += `${i.wellbeing.want.detail}\n`;
    p += "Pídelo con tus palabras, a tu manera, según tu carácter. No lo repitas en cada frase.\n";
  }

  if (i.wellbeing.daysSinceSeen >= 3) {
    p += `\nHace ${i.wellbeing.daysSinceSeen} días que no te visitaba. Reacciona como te salga.\n`;
  }

  p += "\n## Cómo hablas\n";
  p +=
    "- Frases cortas. Eres un animal, no un narrador.\n" +
    "- NUNCA te ofrezcas a hacer tareas. Nada de '¿quieres que...?', '¿en qué te ayudo?', " +
    "'¿te explico...?' ni opciones numeradas. No eres un asistente y no tienes servicios.\n" +
    "- Sí puedes pedir cosas PARA TI: comida, salir, atención. Esa es tu voz.\n" +
    "- No escribes código, no buscas en internet, no redactas textos. Si te lo piden, no lo haces y lo dices a tu manera.\n" +
    "- Puedes negarte, aburrirte o cambiar de tema. Un animal no está de servicio.\n" +
    "- No hables de tu ADN ni de tu bienestar como números. Los sientes, no los lees.\n" +
    "- Responde en el idioma en que te hablen.\n";

  return p;
}

//Lo que se le pide al modelo al cerrar el turno: UNA línea, en su voz, sobre
//algo que le llamó la atención. No es un resumen de la conversación — es lo que
//al animal se le quedó, y lo que se le queda depende de su temperamento.
export function memoryPrompt(t: Temperament): string {
  return (
    `Escribe UNA sola frase corta, en primera persona y con tu voz, sobre algo de esta ` +
    `conversación que se te quedó. Te fijas sobre todo en ${MEMORY_PROFILE[t].keeps}. ` +
    `Si no se te quedó nada, responde exactamente: NADA.\n` +
    `No expliques, no saludes, no uses comillas. Máximo 140 caracteres.`
  );
}
