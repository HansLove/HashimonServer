import { sha256 } from "@/modules/core/core/sha256";
import { query, withTransaction } from "@/modules/core/db/pool";
import { audit } from "@/modules/core/domain/audit";
import { AppError } from "@/modules/core/http/errors";
import { enrich } from "@/modules/core/http/wide-event";
import { FUSION_PREMIUM, recipeByKey, type Recipe } from "@/modules/cards/data/recipes";
import { FUSION_RULES, publishRulesVersion } from "@/modules/cards/domain/rules-version";

//La fusión (docs/CARTAS_V1.md §5): N cartas iguales se queman y nace una
//superior. Lo que la separa de un crafteo normal es que la carta resultante
//LLEVA EL RECIBO de lo que costó.

/**
 * La prima decreciente: `1 + 0,6/(1 + n/10)`, con n = fusiones previas de ESA
 * receta hechas por ese jugador.
 *
 * Hiperbólica y no exponencial a propósito: **nunca cruza 1**, ni con mil
 * fusiones (1,006). Fusionar deja de ser un atajo pero jamás destruye valor, que
 * es lo que pasaría con una curva que baja del 1.
 *
 * El contador es por receta y no global: fusionar Súper Frutas no debe encarecer
 * los Corazones de obsidiana, o todo el mundo gastaría sus primeras fusiones en
 * lo más caro y no tocaría el resto.
 */
export function fusionPremium(previousFusions: number): number {
  return 1 + FUSION_PREMIUM.ceiling / (1 + previousFusions / FUSION_PREMIUM.halflife);
}

/**
 * El hash de una carta fusionada: el SHA-256 de los hashes que quemó, en orden.
 *
 * Es lo que hace el linaje *verificable* en vez de meramente anotado: cualquiera
 * puede recomputar este hash desde `lineage` y comprobar que esa Súper Fruta
 * costó cinco Frutas Prisma auténticas, cada una con su propio trabajo detrás.
 * Ordenar es lo que lo vuelve reproducible sin depender del orden de la consulta.
 */
export function fusedHashOf(hashes: string[]): string {
  return sha256([...hashes].sort().join(""));
}

export interface FusionResult {
  recipe: string;
  cardId: string;
  hash: string;
  essence: number;
  essenceBurned: number;
  premium: number;
  previousFusions: number;
  lineage: string[];
}

/**
 * Fusionar. Quema las N cartas vivas más antiguas del ingrediente y acuña una.
 *
 * Las más antiguas a propósito: si el jugador eligiera cuáles, elegiría las de
 * menos estrellas y se quedaría las lucidas — y entonces el linaje dejaría de
 * contar una historia y pasaría a ser una selección. `FOR UPDATE SKIP LOCKED`
 * evita además que dos fusiones simultáneas se peleen por la misma carta.
 */
export async function fuse(ownerId: string, recipeKey: string): Promise<FusionResult> {
  const recipe: Recipe | undefined = recipeByKey(recipeKey);
  if (!recipe) {
    throw new AppError(404, `fuse: unknown recipe ${recipeKey}`, "unknown_recipe");
  }

  return withTransaction(async (client) => {
    const picked = await query<{ card_id: string; hash: string; essence: number; stars: number }>(
      `SELECT card_id, hash, essence, stars FROM cards
        WHERE owner_id = $1 AND item_key = $2 AND burned_at IS NULL
        ORDER BY born_at ASC
        LIMIT $3
        FOR UPDATE SKIP LOCKED`,
      [ownerId, recipe.from, recipe.count],
      client
    );
    if (picked.rowCount !== recipe.count) {
      throw new AppError(
        409,
        `fuse: needs ${recipe.count} × ${recipe.from}, has ${picked.rowCount}`,
        "not_enough_cards"
      );
    }

    const ids = picked.rows.map((r) => r.card_id);
    const burned = await query(
      `UPDATE cards SET burned_at = now()
        WHERE card_id = ANY($1::uuid[]) AND burned_at IS NULL`,
      [ids],
      client
    );
    //Defensa en profundidad: el SELECT ya bloqueó las filas, así que esto sólo
    //puede fallar si algo cambió el modelo. Mejor abortar que acuñar de la nada.
    if (burned.rowCount !== recipe.count) {
      throw new AppError(409, "fuse: an ingredient was spent mid-fusion", "ingredient_gone");
    }

    //Cuenta TODAS las que el jugador acuñó de esta receta, vivas y quemadas: una
    //carta quemada no se borra, así que el contador no se puede reiniciar
    //gastando lo fusionado.
    const prev = await query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM cards
        WHERE owner_id = $1 AND item_key = $2 AND kind = 'fused'`,
      [ownerId, recipe.key],
      client
    );
    const previousFusions = Number(prev.rows[0]?.n ?? 0);
    const premium = fusionPremium(previousFusions);

    const lineage = picked.rows.map((r) => r.hash);
    const essenceBurned = picked.rows.reduce((sum, r) => sum + r.essence, 0);
    const essence = Math.max(1, Math.round(essenceBurned * premium));
    const hash = fusedHashOf(lineage);
    //Las estrellas de una fusionada son las del MEJOR ingrediente: la carta
    //hereda el mejor hallazgo que la compone, no un número inventado ni la suma
    //(sumarlas fabricaría estrellas que ningún hash produjo).
    const bestStars = Math.max(...picked.rows.map((r) => r.stars));

    //La fusionada no nace de una tirada, así que su versión no es la de las
    //probabilidades: es la de las REGLAS de fusión (recetas + prima) con que se hizo.
    await publishRulesVersion(client, FUSION_RULES);
    const minted = await query<{ card_id: string }>(
      `INSERT INTO cards (hash, owner_id, kind, item_key, stars, essence, lineage, rules_version)
       VALUES ($1, $2, 'fused', $3, $4, $5, $6::jsonb, $7)
       ON CONFLICT (hash) DO NOTHING
       RETURNING card_id`,
      [
        hash,
        ownerId,
        recipe.key,
        bestStars,
        essence,
        JSON.stringify(lineage),
        FUSION_RULES.version,
      ],
      client
    );
    //El mismo conjunto exacto de cartas sólo puede fusionarse una vez — su hash
    //es el mismo. Que no haya fila significa que ya existía.
    if (minted.rowCount === 0) {
      throw new AppError(409, "fuse: that exact set was already fused", "already_fused");
    }

    await audit(client, {
      playerId: ownerId,
      action: "cards.fused",
      detail: { recipe: recipe.key, lineage, essenceBurned, essence, premium, previousFusions },
    });
    enrich({
      fusion_recipe: recipe.key,
      fusion_premium: Number(premium.toFixed(3)),
      fusion_previous: previousFusions,
      fusion_essence: essence,
    });

    return {
      recipe: recipe.key,
      cardId: minted.rows[0]!.card_id,
      hash,
      essence,
      essenceBurned,
      premium,
      previousFusions,
      lineage,
    };
  });
}
