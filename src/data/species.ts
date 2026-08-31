import {
  ELEMENT_ASCII,
  SPIRITS,
  genesisSpeciesKey,
  genesisSpeciesName,
  genesisTemplateId,
  type ElementKey,
  type SpiritKey,
} from "@/core/birth-identity";

//Server-side species allowlist. A speciesKey here is the only thing the
//emission gate accepts — a client cannot invent creatures.
//
//This is NOT where visual identity lives. Type, archetype, color, build,
//markings and every other look trait are derived entirely from DNA at
//render time by encubation-website/src/lib/compiler.ts (and its Lua port,
//3d-world/mods/hashimon_core/dna_compiler.lua) — never stored, never read
//from here. See api/docs/ADN_PROPIEDAD_TEORIA_DE_JUEGO.md for the current
//canonical type list and the Genesis DNA formula.
//
//Historically this file also carried `type`/`archetype`/`baseStats` fields
//mirroring an older client catalog (`game/Content/hashimons.js`, no longer
//part of this repo). Those fields hardcoded body shape to elemental type
//(e.g. "electrico" -> archetype "rodent") — a rule confirmed false and
//removed 2026-08-20: archetype is randomized per-individual from DNA,
//independent of type, for every Genesis species.
//
//Desde caos-core@2 hay UNA excepción deliberada a "nada visual vive aquí": un
//Genesis V2 sí lleva `spirit` y `element`, porque no salen del DNA sino de la
//fecha de nacimiento (core/birth-identity.ts). Siguen sin ser apariencia —
//color, proporciones y cuerpo concreto se derivan del DNA como siempre.
export interface Species {
  templateId: string;
  //Presentes sólo en los Genesis V2. Un Hashimon salvaje no tiene identidad de
  //nacimiento: nadie nació con él.
  spirit?: SpiritKey;
  element?: ElementKey;
  name?: string;
}

//Los 60 Genesis V2: 12 Birth Spirits x 5 elementos.
//
//Generados desde las tablas de core/birth-identity.ts a propósito. Si esta
//lista se escribiera a mano podría divergir de birthIdentityOf(), y entonces
//una fecha legítima produciría una speciesKey que la puerta de emisión rechaza.
//Generándola, eso es imposible por construcción.
//
//Los nombres siguen la convención que species.json ya había fijado para los
//cinco Genesis V1 (Ember / Tide / Gust / Root / Volt). Para bautizar una celda
//a mano, añádela a GENESIS_NAME_OVERRIDES — el mecanismo no se toca.
const GENESIS_NAME_OVERRIDES: Record<string, string> = {};

function buildGenesisV2(): Record<string, Species> {
  const out: Record<string, Species> = {};
  for (const spirit of SPIRITS) {
    for (const element of Object.keys(ELEMENT_ASCII) as ElementKey[]) {
      const key = genesisSpeciesKey(spirit.key, element);
      out[key] = {
        templateId: genesisTemplateId(spirit.key, element),
        spirit: spirit.key,
        element,
        name: GENESIS_NAME_OVERRIDES[key] ?? genesisSpeciesName(spirit.key, element),
      };
    }
  }
  return out;
}

export const GenesisV2: Record<string, Species> = buildGenesisV2();

//Los Genesis V1 siguen en el allowlist para que las criaturas ARCHIVADAS
//sigan presentándose y verificando su PoW bajo su DNA original. No se pueden
//emitir de nuevo: la puerta de emisión sólo acepta claves g2_ para Genesis
//(ver http/routes/hashimons.ts y domain/players.ts).
export const LEGACY_GENESIS = [
  "s001", "genesis_fuego", "genesis_agua", "genesis_aire", "genesis_tierra", "genesis_electrico",
] as const;

export const Hashimons: Record<string, Species> = {
  ...GenesisV2,
  s001: { templateId: "template_genesis_001" },
  genesis_fuego: { templateId: "template_genesis_fuego" },
  genesis_agua: { templateId: "template_genesis_agua" },
  genesis_aire: { templateId: "template_genesis_aire" },
  genesis_tierra: { templateId: "template_genesis_tierra" },
  genesis_electrico: { templateId: "template_genesis_electrico" },
  solarCub: { templateId: "template_solar_001" },
  s002: { templateId: "template_metal_001" },
  glitchPup: { templateId: "template_pixel_002" },
  voltKit: { templateId: "template_electric_001" },
  v001: { templateId: "template_plant_001" },
  v002: { templateId: "template_earth_001" },
  f001: { templateId: "template_fungus_001" },
  f002: { templateId: "template_dream_001" },
  astralFawn: { templateId: "template_astro_001" },
  psyMoth: { templateId: "template_mental_001" },
  tideKit: { templateId: "template_water_001" },
  gustling: { templateId: "template_air_001" },
};

/** Un Genesis V2 — el único tipo que la puerta de emisión acepta como starter. */
export function isGenesisV2(speciesKey: string): boolean {
  return Object.hasOwn(GenesisV2, speciesKey);
}

/** Genesis de cualquier generación, incluidos los V1 archivados. */
export function isAnyGenesis(speciesKey: string): boolean {
  return isGenesisV2(speciesKey) || (LEGACY_GENESIS as readonly string[]).includes(speciesKey);
}
