//Server-side species registry. A species is the SHARED identity of a Hashimon;
//the individual's colour/subtype/markings/rarity come from its DNA. This mirrors
//the client's window.Hashimons, but keeps only what the SERVER needs: identity,
//element, and the base stats the Caos Core scales by rank. Sprite paths, branch
//icons and move kits are client rendering concerns and deliberately live only there.
//
//Keys are the source of truth for "what species can be emitted" — the emission
//gate rejects anything not listed here, so a client cannot invent creatures.
//Keep in sync with game/Content/hashimons.js (same keys, same base stats).
export interface BaseStats {
  power: number;
  defense: number;
  speed: number;
  energy: number;
}

export interface Species {
  name: string;
  description: string;
  species: string;
  type: string;
  type2?: string;
  archetype: string;
  baseHp: number;
  baseStats: BaseStats;
  templateId: string;
  zones?: string[];
}

export const Hashimons: Record<string, Species> = {
  s001: {
    name: "Hashimon", description: "Your first block. Loyal and stubborn.", species: "genesis",
    type: "pixel", archetype: "canine", baseHp: 50,
    baseStats: { power: 8, defense: 7, speed: 7, energy: 10 }, templateId: "template_genesis_001",
  },
  solarCub: {
    name: "Solar Cub", description: "A wild ember of the solar branch.", species: "lion",
    type: "fuego", archetype: "lion", baseHp: 35,
    baseStats: { power: 8, defense: 7, speed: 6, energy: 10 }, templateId: "template_solar_001", zones: ["kitchen"],
  },
  s002: {
    name: "Bacon Brigade", description: "A salty warrior who fears nothing.", species: "brigade",
    type: "metal", archetype: "ursine", baseHp: 50,
    baseStats: { power: 9, defense: 6, speed: 7, energy: 8 }, templateId: "template_metal_001", zones: ["street"],
  },
  glitchPup: {
    name: "Glitchpup", description: "A stray that renders in the wrong resolution.", species: "glitchpup",
    type: "pixel", archetype: "canine", baseHp: 42,
    baseStats: { power: 8, defense: 6, speed: 9, energy: 8 }, templateId: "template_pixel_002", zones: ["street"],
  },
  voltKit: {
    name: "Voltkit", description: "Small, charged, and always twitching.", species: "voltkit",
    type: "electrico", archetype: "rodent", baseHp: 40,
    baseStats: { power: 9, defense: 5, speed: 10, energy: 9 }, templateId: "template_electric_001", zones: ["street"],
  },
  v001: {
    name: "Call Me Kale", description: "Patient as a confirmed block.", species: "kale",
    type: "tierra", type2: "agua", archetype: "amphibian", baseHp: 50,
    baseStats: { power: 7, defense: 9, speed: 5, energy: 9 }, templateId: "template_plant_001", zones: ["greenKitchen"],
  },
  v002: {
    name: "Archie Artichoke", description: "Layers upon layers of defense.", species: "artichoke",
    type: "tierra", archetype: "chelonian", baseHp: 50,
    baseStats: { power: 6, defense: 10, speed: 5, energy: 9 }, templateId: "template_earth_001", zones: ["greenKitchen"],
  },
  f001: {
    name: "Portobello Express", description: "Grows in the dark of the mempool.", species: "portobello",
    type: "hongo", archetype: "fungal", baseHp: 50,
    baseStats: { power: 8, defense: 7, speed: 8, energy: 7 }, templateId: "template_fungus_001", zones: ["greenKitchen"],
  },
  f002: {
    name: "Ninzauu", description: "Speed and ninja moves.", species: "ninzauu",
    type: "sueno", archetype: "chiropteran", baseHp: 50,
    baseStats: { power: 8, defense: 6, speed: 10, energy: 7 }, templateId: "template_dream_001", zones: ["streetNorth"],
  },
  astralFawn: {
    name: "Astral Fawn", description: "It walks a handspan above the road.", species: "astralfawn",
    type: "astro", archetype: "deer", baseHp: 46,
    baseStats: { power: 7, defense: 7, speed: 8, energy: 10 }, templateId: "template_astro_001", zones: ["streetNorth"],
  },
  psyMoth: {
    name: "Psymoth", description: "Reads the block before it is mined.", species: "psymoth",
    type: "mental", archetype: "insect", baseHp: 44,
    baseStats: { power: 7, defense: 6, speed: 9, energy: 10 }, templateId: "template_mental_001", zones: ["streetNorth"],
  },
  tideKit: {
    name: "Tidekit", description: "Half cat, half contained tide.", species: "tidekit",
    type: "agua", archetype: "feline", baseHp: 48,
    baseStats: { power: 7, defense: 8, speed: 7, energy: 9 }, templateId: "template_water_001", zones: ["diningRoom"],
  },
  gustling: {
    name: "Gustling", description: "It never quite touches down.", species: "gustling",
    type: "aire", archetype: "bird", baseHp: 44,
    baseStats: { power: 7, defense: 6, speed: 10, energy: 9 }, templateId: "template_air_001", zones: ["diningRoom"],
  },
};
