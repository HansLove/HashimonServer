//Server-side species allowlist. A speciesKey here is the only thing the
//emission gate accepts — a client cannot invent creatures.
//
//This is NOT where visual identity lives. Type, archetype, color, build,
//markings and every other look trait are derived entirely from DNA at
//render time by encubation-website/src/lib/compiler.ts (and its Lua port,
//3d-world/mods/hashimon_core/dna_compiler.lua) — never stored, never read
//from here. See docs/ADN_PROPIEDAD_TEORIA_DE_JUEGO.md for the current
//canonical type list and the Genesis DNA formula.
//
//Historically this file also carried `type`/`archetype`/`baseStats` fields
//mirroring an older client catalog (`game/Content/hashimons.js`, no longer
//part of this repo). Those fields hardcoded body shape to elemental type
//(e.g. "electrico" -> archetype "rodent") — a rule confirmed false and
//removed 2026-08-20: archetype is randomized per-individual from DNA,
//independent of type, for every Genesis species.
export interface Species {
  templateId: string;
}

export const Hashimons: Record<string, Species> = {
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
