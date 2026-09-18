import type { YieldTier } from "@/modules/core/core/pow";

//Qué estampas maduran con el siguiente bloque (docs/ESTAMPAS_V1.md §4.5).
//
//Decisión del 17 sept: maduran el mutágeno, las épicas y las mutaciones. Cada tier
//tiene una BANDA: los ítems que, si la tirada instantánea cae en ellos, salen como
//capullo. El bloque decide después cuál de los ítems de la banda es, con los mismos
//pesos de foods.ts — así las probabilidades publicadas no cambian ni un decimal:
//
//  P(ítem) = P(caer en la banda) × peso(ítem) / peso(banda) = peso(ítem) / peso(tier)
//
//- capital: el tier ENTERO (mutágeno: roca mutágena y geoda génesis).
//- consumable: hongo lumen + fruta prisma. La épica (fruta prisma) va acompañada de la
//  rara del mismo tier a propósito: con la épica sola en la banda, un capullo azul
//  SIEMPRE sería fruta prisma y el bloque no decidiría nada — la espera sería teatro.
//  Con las dos, el capullo es «¿rara o épica?» (80 % / 20 %).
//- durable: ninguna. No tiene épica.
//
//Toca esto sólo a sabiendas: forma parte de las reglas publicadas (MATURATION_RULES en
//rules-version.ts) y cambiarlo produce otra versión.
export const MATURATION_BANDS: Readonly<Record<YieldTier, readonly string[]>> = {
  consumable: ["hongo_lumen", "fruta_prisma"],
  durable: [],
  capital: ["roca_mutagena", "geoda_genesis"],
};
