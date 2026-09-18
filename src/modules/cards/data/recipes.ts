//Las recetas de fusión (docs/CARTAS_V1.md §5). Contenido, no mecánica: añadir
//una receta es añadir una fila aquí, y nada en fusion.ts cambia.
//
//`result` NO está en foods.ts a propósito: una carta fusionada no es un hallazgo,
//así que no puede salir de la tirada de un hash. Su esencia se calcula desde lo
//que quemó (§5.1), no desde un peso de catálogo.

export interface Recipe {
  /** item_key de la carta que nace. */
  key: string;
  name: string;
  /** item_key que hay que quemar — todas iguales. */
  from: string;
  /** Cuántas. */
  count: number;
}

/** La prima decreciente `1 + ceiling/(1 + n/halflife)` (CARTAS_V1 §5.1). Vive aquí
 *  y no en fusion.ts porque es REGLA PUBLICADA: entra en la versión de las reglas
 *  de fusión, igual que las recetas. */
export const FUSION_PREMIUM = { ceiling: 0.6, halflife: 10 } as const;

export const RECIPES: Recipe[] = [
  { key: "super_fruta", name: "Súper Fruta", from: "fruta_prisma", count: 5 },
  { key: "corazon_obsidiana", name: "Corazón de obsidiana", from: "veta_obsidiana", count: 8 },
  { key: "geoda_mayor", name: "Geoda mayor", from: "geoda_genesis", count: 3 },
];

const BY_KEY = new Map(RECIPES.map((r) => [r.key, r]));

export function recipeByKey(key: string): Recipe | undefined {
  return BY_KEY.get(key);
}
