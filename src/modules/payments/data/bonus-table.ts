//La tabla del bono del paquete (docs/BONO_VERIFICABLE_V1.md §3). Contenido
//publicado, no mecánica: entra en la versión `bonus:` de rules_versions, así que
//cambiar un tramo produce una versión nueva por sí sola.

/** La tirada va de 0 a MODULUS-1. */
export const BONUS_ROLL_MODULUS = 10000;

/** Tramos acumulados: el primero cuyo `upto` supere la tirada. El último cierra en
 *  el módulo, así que toda tirada cae en uno. 70 % / 20 % / 8 % / 2 %. */
export const BONUS_TIERS = [
  { upto: 7000, pct: 0 },
  { upto: 9000, pct: 5 },
  { upto: 9800, pct: 10 },
  { upto: 10000, pct: 15 },
] as const;

/** El bono se resuelve con el bloque comprometido y dos más encima: una
 *  reorganización de esa profundidad es rarísima. */
export const BONUS_CONFIRMATIONS = 3;

/** El extra se redondea a múltiplos de esto: 10 créditos = 1 marca, así que el
 *  jugador siempre recibe marcas enteras. */
export const BONUS_CREDIT_STEP = 10;
