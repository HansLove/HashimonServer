//Birth Identity (Capa A) — el destino compartido.
//
//La fecha de nacimiento determina QUÉ CLASE DE SER te toca. La semilla del
//servidor determina QUÉ INDIVIDUO eres dentro de esa clase (Capa B, en
//domain/hashimons.ts). Esta separación es el principio del sistema:
//
//    Fecha    -> destino compartido
//    Servidor -> individuo singular
//
//Dos personas nacidas el mismo día comparten espíritu, número de vida,
//elemento y especie — y no comparten ni un color ni una proporción.
//
//DELIBERADAMENTE SIN SHA-256. Toda esta capa se reproduce con papel y lápiz:
//sumar dígitos y mirar dos tablas. Un jugador puede auditar su propia identidad
//sin ejecutar nada. El hash entra después, cuando nace el individuo.
//
//Paridad obligatoria con 3d-world/mods/hashimon_core/birth_identity.lua y
//ihashima-website/src/lib/birth-identity.ts. Verificado por
//scripts/validate_birth_identity.mjs — cualquier cambio aquí rompe el harness
//hasta que los tres archivos coincidan en las 17,897 fechas.

export const BIRTH_IDENTITY_VERSION = 2;

//Elementos Genesis, en la ortografía EXACTA que exige compiler.ts TYPES (con
//acento). El alias ascii sólo existe para construir claves e identificadores.
export type ElementKey = "fuego" | "agua" | "aire" | "tierra" | "eléctrico";

export const ELEMENT_ASCII: Record<ElementKey, string> = {
  fuego: "fuego",
  agua: "agua",
  aire: "aire",
  tierra: "tierra",
  "eléctrico": "electrico",
};

//Prefijo de nombre por elemento. No es invención nueva: species.json ya bautizó
//los cinco Genesis como Ember/Tide/Gust/Root/Volt. V2 continúa esa convención.
export const ELEMENT_PREFIX: Record<ElementKey, string> = {
  fuego: "Ember",
  agua: "Tide",
  aire: "Gust",
  tierra: "Root",
  "eléctrico": "Volt",
};

// ---------------------------------------------------------------------------
// Número de Vida
// ---------------------------------------------------------------------------

//Suma de dígitos reducida a 1..9, conservando 11/22/33 como maestros.
//
//El maestro se comprueba EN CADA PASO de reducción, no sólo en el primer total.
//Medido sobre 1970-2018: con la comprobación en cada paso el 11 aparece en el
//8.6% de los nacimientos; comprobando sólo el primer total, en el 1.7%, y
//Eléctrico caería al 8.7% del padrón en vez del 15.5%. La regla de cada paso es
//además la de la literatura numerológica.
export function lifeNumberOf(dob: string): number {
  let n = 0;
  for (const ch of dob) {
    if (ch >= "0" && ch <= "9") { n += ch.charCodeAt(0) - 48; }
  }
  while (n > 9) {
    if (n === 11 || n === 22 || n === 33) { return n; }
    let next = 0;
    for (const ch of String(n)) { next += ch.charCodeAt(0) - 48; }
    n = next;
  }
  return n;
}

//Número de Vida -> Genesis. Tabla canónica, nunca selección aleatoria.
//
//El 5 pertenece a Aire, no a Fuego. Con el 5 en Fuego el reparto medido era
//fuego 33.3% / aire 13.7% — uno de cada tres nacimientos era Fuego. El 5 es el
//número de la libertad, el movimiento y los sentidos, que es exactamente el
//perfil de movilidad de Aire (vuelo libre, sprint x2.5) en mount.lua.
//Con el cambio: aire 24.8% / fuego 22.2% / tierra 19.9% / agua 17.6% / eléctrico 15.5%.
export const ELEMENT_BY_LIFE: Readonly<Record<number, ElementKey>> = {
  1: "fuego", 3: "fuego",
  2: "aire", 5: "aire", 7: "aire",
  4: "tierra", 8: "tierra",
  6: "agua", 9: "agua",
  //Los maestros resuenan más alto y manifiestan Eléctrico.
  11: "eléctrico", 22: "eléctrico", 33: "eléctrico",
};

//Afinidad secundaria de los maestros. Sólo lore y color de UI — no es una
//segunda mecánica y nada del compilador la lee.
export const UNDERTONE_BY_LIFE: Readonly<Record<number, ElementKey>> = {
  11: "aire", 22: "tierra", 33: "agua",
};

// ---------------------------------------------------------------------------
// Birth Spirit
// ---------------------------------------------------------------------------

export type SpiritKey =
  | "hearth" | "mirror" | "guardian" | "beacon" | "depth" | "crown"
  | "edge" | "bastion" | "road" | "key" | "forge" | "bloom";

export interface Spirit {
  key: SpiritKey;
  name: string;
  nameEs: string;
  //Lo que el signo SIGNIFICA. Los doce son arquetipos, no animales: el nombre
  //describe el rasgo, y la familia corporal es sólo cómo se manifiesta. Por eso
  //`hearth` es canino y no "Lobo" — un lobo es una silueta, un hogar es un modo
  //de ser, y la silueta puede cambiar de pack sin tocar la identidad.
  archetype: string;
  //Familias corporales del linaje, de la silueta base hacia afuera. El cuerpo
  //destino se elige DENTRO de esta lista y nunca fuera de ella: por eso un
  //Leviathan jamás puede terminar con cuerpo de theropod.
  line: readonly string[];
  //Espíritu pariente cuyo linaje se usa si NINGUNA familia de `line` tiene un
  //cuerpo registrado (mundo sin los packs opcionales). No cambia la identidad
  //publicada: sigues siendo Tyrant, sólo vistes otra malla.
  kin: SpiritKey | null;
}

//Los doce SIGNOS HASHIANOS. Las ventanas solares cubren el año completo y el
//signo cambia el día 21.
//
//Son arquetipos, no animales. El nombre describe el rasgo; la familia corporal
//es sólo cómo ese rasgo se manifiesta. Llamarlos "Lobo" o "Leviatán" habría
//atado la identidad publicada al asset instalado — exactamente lo que el
//firewall de licencias existe para evitar. Un Hearth con otra silueta sigue
//siendo Hearth.
//
//Los doce linajes cubren las 25 familias corporales registradas EXACTAMENTE:
//sin sobras y sin repeticiones. La capa de espíritus no cuesta diversidad
//corporal, la reorganiza — y de paso arregla que 10 de las 25 familias tuvieran
//un solo cuerpo y por tanto ninguna línea evolutiva real.
//NOMBRES PROVISIONALES: depth, edge y road. El resto está cerrado.
//
//Los tres nombran su arquetipo de forma más literal que los otros nueve —
//`depth` casi repite su propia familia (aquatic), y "Tide Depth" sale
//redundante por la regla de nombres. Cambiar uno NO es cosmético: la clave
//`g2_<signo>_<elemento>` está en el preimagen del ADN, así que renombrar
//después de que haya jugadores obliga a renacerlos (ver docs/NACIMIENTO_V2.md
//§4). Mientras no haya nadie nacido, el cambio es gratis. Decidirlo antes de
//abrir el registro.
export const SPIRITS: readonly Spirit[] = [
  { key: "hearth", name: "Hearth", nameEs: "Hogar",
    archetype: "vínculo, lealtad, hogar, comunidad",
    line: ["canine"], kin: null },
  { key: "mirror", name: "Mirror", nameEs: "Espejo",
    archetype: "intuición, reserva, percepción",
    line: ["feline"], kin: null },
  { key: "guardian", name: "Guardian", nameEs: "Guardián",
    archetype: "protección, fuerza, responsabilidad",
    line: ["ursine", "megafauna"], kin: null },
  { key: "beacon", name: "Beacon", nameEs: "Faro",
    archetype: "visión, dirección, descubrimiento",
    line: ["avian", "pterosaur"], kin: null },
  //PROVISIONAL
  { key: "depth", name: "Depth", nameEs: "Abismo",
    archetype: "mundo interior, adaptación, paciencia",
    line: ["aquatic", "marine_reptile"], kin: null },
  { key: "crown", name: "Crown", nameEs: "Corona",
    archetype: "presencia, ambición, autoridad",
    line: ["dragon"], kin: null },
  //PROVISIONAL
  { key: "edge", name: "Edge", nameEs: "Filo",
    archetype: "decisión, instinto, intensidad",
    line: ["theropod", "crocodilian"], kin: "crown" },
  { key: "bastion", name: "Bastion", nameEs: "Bastión",
    archetype: "resistencia, estabilidad, memoria",
    line: ["chelonian", "ceratopsian", "stegosaur", "sauropod"], kin: "guardian" },
  //PROVISIONAL
  { key: "road", name: "Road", nameEs: "Camino",
    archetype: "viaje, constancia, libertad",
    line: ["livestock", "cervid", "equine"], kin: null },
  { key: "key", name: "Key", nameEs: "Llave",
    archetype: "ingenio, oportunidad, supervivencia",
    line: ["rodent", "marsupial"], kin: null },
  { key: "forge", name: "Forge", nameEs: "Fragua",
    archetype: "creación, voluntad, transformación",
    line: ["construct", "humanoid"], kin: "hearth" },
  { key: "bloom", name: "Bloom", nameEs: "Brote",
    archetype: "cambio, renovación, crecimiento",
    line: ["amphibian", "flora", "arthropod"], kin: null },
];


export function spiritByKey(key: string): Spirit | undefined {
  return SPIRITS.find((s) => s.key === key);
}

//Ventana solar -> espíritu. El día 21 abre la ventana del mes en curso; del 1 al
//20 sigues en la ventana abierta el mes anterior. Fang abre el 21 de enero y
//Bloom cierra el 20 de enero del año siguiente.
export function spiritOf(dob: string): SpiritKey {
  const { month, day } = parseDob(dob);
  const i = (((day >= 21 ? month - 1 : month - 2) % 12) + 12) % 12;
  return SPIRITS[i]!.key;
}

// ---------------------------------------------------------------------------
// Especie curada: Spirit x Element
// ---------------------------------------------------------------------------

//Las 60 celdas son alcanzables (verificado: 0 huecos sobre 1970-2018), con
//frecuencias entre 1.21% y 2.20%.
export function genesisSpeciesKey(spirit: SpiritKey, element: ElementKey): string {
  return `g2_${spirit}_${ELEMENT_ASCII[element]}`;
}

export function genesisTemplateId(spirit: SpiritKey, element: ElementKey): string {
  return `template_g2_${spirit}_${ELEMENT_ASCII[element]}`;
}

//Nombre por regla. Las celdas que merezcan un nombre propio se sobrescriben en
//data/species.ts sin tocar el mecanismo.
export function genesisSpeciesName(spirit: SpiritKey, element: ElementKey): string {
  return `${ELEMENT_PREFIX[element]} ${spiritByKey(spirit)!.name}`;
}

// ---------------------------------------------------------------------------
// La identidad completa
// ---------------------------------------------------------------------------

export interface BirthIdentity {
  lifeNumber: number;
  element: ElementKey;
  //Sólo para 11/22/33. Lore, no mecánica.
  undertone: ElementKey | null;
  spirit: SpiritKey;
  spiritName: string;
  speciesKey: string;
  templateId: string;
  version: number;
}

export function birthIdentityOf(dob: string): BirthIdentity {
  const lifeNumber = lifeNumberOf(dob);
  const element = ELEMENT_BY_LIFE[lifeNumber];
  if (!element) {
    //Inalcanzable: lifeNumberOf sólo devuelve 1..9, 11, 22, 33.
    throw new Error(`birth-identity: no element for life number ${lifeNumber}`);
  }
  const spirit = spiritOf(dob);
  return {
    lifeNumber,
    element,
    undertone: UNDERTONE_BY_LIFE[lifeNumber] ?? null,
    spirit,
    spiritName: spiritByKey(spirit)!.name,
    speciesKey: genesisSpeciesKey(spirit, element),
    templateId: genesisTemplateId(spirit, element),
    version: BIRTH_IDENTITY_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Fecha
// ---------------------------------------------------------------------------

export const DOB_MIN_YEAR = 1900;

//ISO YYYY-MM-DD estricto y calendario real — "2001-02-30" se rechaza. La fecha
//nunca se persiste (ver schema.sql): entra, produce la identidad, y se descarta.
export function parseDob(dob: string): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob);
  if (!m) {
    throw new Error("birth-identity: dob must be YYYY-MM-DD");
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    throw new Error("birth-identity: dob is not a real calendar date");
  }
  return { year, month, day };
}

//`now` inyectable para que el test no dependa del reloj.
export function isPlausibleDob(dob: string, now: Date = new Date()): boolean {
  let parsed: { year: number; month: number; day: number };
  try {
    parsed = parseDob(dob);
  } catch {
    return false;
  }
  if (parsed.year < DOB_MIN_YEAR) { return false; }
  return Date.UTC(parsed.year, parsed.month - 1, parsed.day) <= now.getTime();
}
