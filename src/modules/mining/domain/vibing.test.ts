// Vibing towers (VIBING_V1.md §3): the PLACE-ceiling rule (resolveHarvestPlace, pure) and
// the projection it sits on top of (replaceVibingTowers/listVibingTowers/heat), against the
// local DB.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveHarvestPlace,
  replaceVibingTowers,
  listVibingTowers,
  presentVibingTowers,
  harvestPlaceForPlayer,
  bumpHeat,
  heatByPlace,
} from "@/modules/mining/domain/vibing";
import { zoneAtWorld } from "@/modules/core/core/yield-map";
import { pool, query } from "@/modules/core/db/pool";
import { uniqueId } from "@/test/support/db";
import { seedPlayer, deletePlayers } from "@/test/support/fixtures";

describe("resolveHarvestPlace (pure — the PLACE-ceiling rule)", () => {
  it("no town floors to the player's own vault at the consumable tier", () => {
    const place = resolveHarvestPlace("player-1", null, null);
    assert.deepEqual(place, { place: "vault:player-1", tier: "consumable", townName: null });
  });

  it("a town without a planted tower still floors to the vault", () => {
    const place = resolveHarvestPlace("player-1", "TownA", null);
    assert.deepEqual(place, { place: "vault:player-1", tier: "consumable", townName: "TownA" });
  });

  it("a town with a planted tower yields that tower's zone", () => {
    const tower = { id: "10:8:30", x: 160, z: 320 };
    const expectedTier = zoneAtWorld(tower.x, tower.z).tier;
    const place = resolveHarvestPlace("player-1", "TownA", tower);
    assert.deepEqual(place, { place: tower.id, tier: expectedTier, townName: "TownA" });
  });
});

describe("presentVibingTowers (pure)", () => {
  it("derives the tier from the coordinate and defaults heat to 0", () => {
    const rows = [
      { id: "a", town_name: "T", owner: "o", x: 0, y: 8, z: 0 },
      { id: "b", town_name: "T", owner: "o", x: 160, y: 8, z: 320, heat: 5 },
    ];
    const [a, b] = presentVibingTowers(rows);
    assert.equal(a!.tier, zoneAtWorld(0, 0).tier);
    assert.equal(a!.heat, 0);
    assert.equal(b!.heat, 5);
    assert.equal(b!.town, "T");
  });
});

describe("vibing towers + heat (against the local DB)", () => {
  const playerIds: string[] = [];
  const towerIds: string[] = [];
  const places: string[] = [];

  after(async () => {
    if (towerIds.length > 0) {
      await query(`DELETE FROM vibing_towers WHERE id = ANY($1)`, [towerIds]);
    }
    if (places.length > 0) {
      await query(`DELETE FROM place_heat WHERE place = ANY($1)`, [places]);
    }
    if (playerIds.length > 0) {
      await deletePlayers(playerIds);
    }
    await pool.end();
  });

  it("replaceVibingTowers replaces the whole set: new rows land, dropped ones disappear", async () => {
    const town = uniqueId("VibingTown");
    const a = { id: uniqueId("tower-a"), townName: town, owner: "p1", x: 0, y: 8, z: 0 };
    const b = { id: uniqueId("tower-b"), townName: town, owner: "p1", x: 16, y: 8, z: 0 };
    towerIds.push(a.id, b.id);

    const count = await replaceVibingTowers([a, b]);
    assert.equal(count, 2);

    const afterFirstPush = (await listVibingTowers()).filter((r) => r.town_name === town);
    assert.deepEqual(afterFirstPush.map((r) => r.id).sort(), [a.id, b.id].sort());

    // The world is authoritative: dropping "a" from the next push must delete it, not just
    // leave it stale.
    await replaceVibingTowers([b]);
    const afterSecondPush = await listVibingTowers();
    assert.equal(afterSecondPush.some((r) => r.id === a.id), false);
    assert.equal(afterSecondPush.some((r) => r.id === b.id), true);
  });

  it("replaceVibingTowers with an empty list clears every tower", async () => {
    const town = uniqueId("VibingTownEmpty");
    const tower = { id: uniqueId("tower-empty"), townName: town, owner: null, x: 0, y: 8, z: 0 };
    towerIds.push(tower.id);
    await replaceVibingTowers([tower]);
    assert.equal((await listVibingTowers()).some((r) => r.id === tower.id), true);

    const count = await replaceVibingTowers([]);
    assert.equal(count, 0);
    assert.equal((await listVibingTowers()).length, 0);
  });

  it("harvestPlaceForPlayer floors to the vault when the player has no territory row", async () => {
    const player = await seedPlayer();
    playerIds.push(player.id);
    const place = await harvestPlaceForPlayer(player.id);
    assert.deepEqual(place, { place: `vault:${player.id}`, tier: "consumable", townName: null });
  });

  it("harvestPlaceForPlayer resolves the town's tower when one is planted", async () => {
    const player = await seedPlayer();
    playerIds.push(player.id);
    const town = uniqueId("VibingHarvestTown");
    await query(`INSERT INTO player_territory (player_id, town_name) VALUES ($1, $2)`, [player.id, town]);
    const tower = { id: uniqueId("tower-harvest"), townName: town, owner: player.id, x: 320, y: 8, z: 0 };
    towerIds.push(tower.id);
    await replaceVibingTowers([tower]);

    const place = await harvestPlaceForPlayer(player.id);
    assert.deepEqual(place, {
      place: tower.id,
      tier: zoneAtWorld(tower.x, tower.z).tier,
      townName: town,
    });
  });

  it("bumpHeat increments an existing place and heatByPlace reads it back", async () => {
    const place = uniqueId("vault:heat-test");
    places.push(place);
    const spot = { place, tier: "consumable" as const, townName: null };

    await bumpHeat(spot);
    await bumpHeat(spot);

    const heat = await heatByPlace([place]);
    assert.equal(heat.get(place), 2);
  });

  it("heatByPlace with an empty list returns an empty map without querying for any place", async () => {
    const heat = await heatByPlace([]);
    assert.equal(heat.size, 0);
  });
});
