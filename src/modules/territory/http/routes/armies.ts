import { Router } from "express";
import { z } from "zod";
import { requireSession } from "@/modules/core/http/auth";
import { AppError, asyncHandler } from "@/modules/core/http/errors";
import { enrich } from "@/modules/core/http/wide-event";
import { getPlayerTerritory } from "@/modules/territory/domain/territory";
import { resolveTownName } from "@/modules/territory/domain/diplomacy";
import {
  armyOf,
  attack,
  canAct,
  currentTurn,
  nextTurnAt,
  moveUnit,
  muster,
  setDoctrine,
  UNITS,
  type Doctrine,
  type UnitKind,
} from "@/modules/territory/domain/armies";
import { population, townSituation } from "@/modules/territory/domain/wolkers";
import { query } from "@/modules/core/db/pool";

export const armiesRouter = Router();

// La capa Risk vista desde la web (docs/ARMIES_V1.md).
//
// La regla de acceso, y es deliberada: **mirar es público, mandar es del alcalde.** Un Risk
// donde no ves el tablero no es un Risk — saber que el vecino tiene tres veces tus fichas es
// justo la información que evita guerras. Lo que no puede hacer un extraño es mover nada.

/** El tablero: toda nación con claim, su población, su ejército y lo fina que es su frontera. */
armiesRouter.get(
  "/armies",
  asyncHandler(async (_req, res) => {
    const towns = await query<{ town_name: string }>(
      `SELECT town_name FROM town_claims ORDER BY block_count DESC, town_name ASC LIMIT 100`
    );
    const board = [];
    for (const t of towns.rows) {
      const army = await armyOf(t.town_name);
      board.push({ ...army, population: await population(t.town_name) });
    }
    enrich({ nation_count: board.length });
    res.json({ nations: board });
  })
);

/** Una nación en detalle. Cualquiera puede consultarla, incluidos sus enemigos. */
armiesRouter.get(
  "/armies/:town",
  asyncHandler(async (req, res) => {
    const town = await resolveTownName(req.params.town ?? "");
    if (!town) throw new AppError(404, "no town by that name", "no_such_town");
    const army = await armyOf(town);
    const situation = await townSituation(town);
    res.json({ army, situation, unitTypes: UNITS });
  })
);

/** Las batallas recientes, con su semilla: el registro es público para que cualquiera pueda
 *  recomputar un resultado que le parezca sospechoso. */
armiesRouter.get(
  "/armies/:town/battles",
  asyncHandler(async (req, res) => {
    const town = await resolveTownName(req.params.town ?? "");
    if (!town) throw new AppError(404, "no town by that name", "no_such_town");
    const rows = await query(
      `SELECT id, bx, by, bz, attacker, defender, seed, roll, attack_power, defense_power, winner, detail, at
         FROM battles WHERE attacker = $1 OR defender = $1 ORDER BY at DESC LIMIT 50`,
      [town]
    );
    res.json({ battles: rows.rows });
  })
);

const orderSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("muster"),
    kind: z.enum(["milicia", "linea", "incursores"]),
    block: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }),
  }),
  z.object({
    op: z.literal("move"),
    unitId: z.number().int().positive(),
    block: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }),
  }),
  z.object({
    op: z.literal("attack"),
    block: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }),
  }),
]);

/** Reclutar, mover y atacar. Sólo el alcalde: un ejército con dos manos al volante no es un
 *  ejército. El co-alcalde queda fuera a propósito hasta que exista un rango militar propio
 *  — declarar una guerra no debería colarse dentro del permiso de gestionar el pueblo. */
armiesRouter.post(
  "/armies/orders",
  requireSession,
  asyncHandler(async (req, res) => {
    const player = req.player!;
    const pt = await getPlayerTerritory(player.id);
    if (!pt || !pt.town_name) throw new AppError(400, "you are not in a town", "no_town");
    if (!pt.is_mayor) throw new AppError(403, "only the mayor commands the army", "not_mayor");

    const order = orderSchema.parse(req.body ?? {});
    enrich({ town_name: pt.town_name, army_op: order.op });

    if (order.op === "muster") {
      const out = await muster(pt.town_name, order.kind as UnitKind, order.block);
      if (!out.ok) throw new AppError(400, out.error, out.error);
      res.json({ ok: true, unitId: out.unitId, army: await armyOf(pt.town_name) });
      return;
    }
    if (order.op === "move") {
      const out = await moveUnit(pt.town_name, order.unitId, order.block);
      if (!out.ok) throw new AppError(400, out.error, out.error);
      res.json({ ok: true, from: out.from, army: await armyOf(pt.town_name) });
      return;
    }

    // Atacar es irreversible y se cobra en gente: se resuelve y se registra, sin deshacer.
    const result = await attack(pt.town_name, order.block);
    if ("error" in result) throw new AppError(400, result.error, result.error);
    enrich({ battle_id: result.battleId, battle_winner: result.winner });
    res.json({ ok: true, battle: result, army: await armyOf(pt.town_name) });
  })
);

const doctrineSchema = z.object({
  doctrine: z.enum(["manual", "defensiva", "equilibrada", "expansiva"]),
});

/** La doctrina: qué hace tu ejército cuando no estás. Del alcalde, como el resto del mando,
 *  pero es la única orden que se da una vez y sigue valiendo — que es justo el punto. */
armiesRouter.post(
  "/armies/doctrine",
  requireSession,
  asyncHandler(async (req, res) => {
    const player = req.player!;
    const pt = await getPlayerTerritory(player.id);
    if (!pt || !pt.town_name) throw new AppError(400, "you are not in a town", "no_town");
    if (!pt.is_mayor) throw new AppError(403, "only the mayor commands the army", "not_mayor");

    const { doctrine } = doctrineSchema.parse(req.body ?? {});
    await setDoctrine(pt.town_name, doctrine as Doctrine);
    enrich({ town_name: pt.town_name, doctrine });
    res.json({ ok: true, army: await armyOf(pt.town_name) });
  })
);

/** Las fichas de tu nación, una por una, para poder moverlas desde el tablero. Sólo las
 *  tuyas: dónde está el ejército del vecino es público, pero sus números de ficha no. */
armiesRouter.get(
  "/armies/mine/units",
  requireSession,
  asyncHandler(async (req, res) => {
    const player = req.player!;
    const pt = await getPlayerTerritory(player.id);
    if (!pt || !pt.town_name) throw new AppError(400, "you are not in a town", "no_town");
    const rows = await query<{
      id: number; kind: UnitKind; bx: number; by: number; bz: number; moved_at: Date | null;
    }>(
      `SELECT id, kind, bx, by, bz, moved_at FROM army_units WHERE town_name = $1 ORDER BY id`,
      [pt.town_name]
    );
    // `canAct` se resuelve aquí y no en el cliente: el turno lo decide el reloj del
    // servidor, y una web con la hora mal puesta no debe poder discutirlo.
    const units = rows.rows.map(({ moved_at, ...u }) => ({ ...u, canAct: canAct(moved_at) }));
    res.json({ units, turn: currentTurn(), nextTurnAt: nextTurnAt().toISOString() });
  })
);
