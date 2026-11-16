import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  BOX_DROP_TABLE,
  BOX_LIFETIME_S,
  BOX_MAX_ALIVE,
  BoxKind,
  MIN_DAMAGE,
  NPC_STATS,
  NpcTier,
  PROJECTILE_LIFETIME_S,
  PROJECTILE_MAX_ALIVE,
  PROJECTILE_RADIUS,
  TICK_DURATION_S,
  WORLD_WIDTH,
  ZoneId,
} from '@warship/shared';

import { BoxPool } from './Box.js';
import {
  applyDamage,
  killReward,
  lootForKill,
  resolveHits,
  statsForTier,
  sweptHit,
} from './Combat.js';
import { ProjectilePool } from './Projectile.js';

/**
 * Combat tests.
 *
 * The load-bearing question is *did this shot connect*, and the reason it needs its own
 * tests rather than being folded into an integration test is that the naive
 * implementation is wrong in a way that only shows up at speed: a projectile moves up to
 * ~36 units per tick and a hull radius is 16–26, so a point-in-circle test tunnels
 * straight through most targets. Every sweep assertion below fails against that version.
 */

/** A target circle for the sweep tests. */
function targetAt(
  x: number,
  y: number,
  radius = 20,
): { id: string; x: number; y: number; radius: number } {
  return { id: 'target', x, y, radius };
}

describe('Combat — swept collision', () => {
  test('hits when the segment ends inside the target', () => {
    const hit = sweptHit({ fromX: 0, fromY: 0, toX: 100, toY: 0, target: targetAt(100, 0) });
    assert.equal(hit, true);
  });

  test('hits when the segment passes through and ends beyond', () => {
    /* The shot starts 80 units short and ends 80 units past, so at no sampling point is
       it inside the hull — only the swept segment intersects. This is the case a
       point-in-circle test gets wrong. */
    const hit = sweptHit({ fromX: -80, fromY: 0, toX: 80, toY: 0, target: targetAt(0, 0) });
    assert.equal(hit, true);
  });

  test('misses when the segment passes beside the target', () => {
    // A parallel path 60 units off a 20-unit hull with a 5-unit projectile: 25 is the
    // reach, so 60 is comfortably clear.
    const hit = sweptHit({ fromX: -80, fromY: 60, toX: 80, toY: 60, target: targetAt(0, 0) });
    assert.equal(hit, false);
  });

  test('misses when the segment stops short', () => {
    const hit = sweptHit({ fromX: -200, fromY: 0, toX: -100, toY: 0, target: targetAt(0, 0) });
    assert.equal(hit, false);
  });

  test('accounts for the projectile radius', () => {
    /* Exactly at the edge of the hull: a path `radius + PROJECTILE_RADIUS` away grazes,
       and one unit further misses. Pinning both sides proves the radius is added rather
       than ignored. */
    const graze = sweptHit({
      fromX: -100,
      fromY: 25,
      toX: 100,
      toY: 25,
      target: targetAt(0, 0),
    });
    const clear = sweptHit({
      fromX: -100,
      fromY: 25.5,
      toX: 100,
      toY: 25.5,
      target: targetAt(0, 0),
    });

    assert.equal(graze, true, `grazing at ${String(20 + PROJECTILE_RADIUS)} should hit`);
    assert.equal(clear, false, 'half a unit further out should miss');
  });

  test('hits across the world seam', () => {
    /* A shot heading past the right edge and a hull just beyond it. Without wrapping the
       delta the pair look 7 900 units apart and every seam shot misses. */
    const hit = sweptHit({
      fromX: WORLD_WIDTH - 40,
      fromY: 0,
      toX: WORLD_WIDTH + 20,
      toY: 0,
      target: targetAt(10, 0),
    });
    assert.equal(hit, true);
  });
});

describe('Combat — hit resolution', () => {
  test('a shot consumes itself on the first hit', () => {
    /* Two targets stacked on the same spot: one projectile must damage one of them, not
       both. Otherwise a single shot fired into a formation would clear it. */
    const hits = resolveHits({
      shots: [
        {
          id: 'p0',
          ownerId: 'shooter',
          ownerIsNpc: false,
          x: 0,
          y: 0,
          previousX: -50,
          previousY: 0,
          damage: 10,
        },
      ],
      targets: [
        { ...targetAt(0, 0), isNpc: true },
        { ...targetAt(2, 0), isNpc: true },
      ],
    });

    assert.equal(hits.length, 1);
  });

  test('a shot cannot hit its own owner', () => {
    const hits = resolveHits({
      shots: [
        {
          id: 'p0',
          ownerId: 'self',
          ownerIsNpc: false,
          x: 0,
          y: 0,
          previousX: 0,
          previousY: 0,
          damage: 10,
        },
      ],
      targets: [{ id: 'self', x: 0, y: 0, radius: 20, isNpc: false }],
    });

    assert.equal(hits.length, 0);
  });

  test('NPC shots pass through other NPCs', () => {
    /* Friendly fire between NPCs would have the AI clearing the zone for the player. */
    const hits = resolveHits({
      shots: [
        {
          id: 'p0',
          ownerId: 'npc-a',
          ownerIsNpc: true,
          x: 0,
          y: 0,
          previousX: -50,
          previousY: 0,
          damage: 10,
        },
      ],
      targets: [{ ...targetAt(0, 0), isNpc: true }],
    });

    assert.equal(hits.length, 0);
  });

  test('an NPC shot does hit a player', () => {
    const hits = resolveHits({
      shots: [
        {
          id: 'p0',
          ownerId: 'npc-a',
          ownerIsNpc: true,
          x: 0,
          y: 0,
          previousX: -50,
          previousY: 0,
          damage: 10,
        },
      ],
      targets: [{ ...targetAt(0, 0), id: 'player-1', isNpc: false }],
    });

    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.targetId, 'player-1');
  });

  test('a miss produces no hit', () => {
    const hits = resolveHits({
      shots: [
        {
          id: 'p0',
          ownerId: 'p',
          ownerIsNpc: false,
          x: 0,
          y: 500,
          previousX: 0,
          previousY: 400,
          damage: 10,
        },
      ],
      targets: [{ ...targetAt(0, 0), isNpc: true }],
    });

    assert.equal(hits.length, 0);
  });
});

describe('Combat — damage', () => {
  test('armor subtracts from damage', () => {
    assert.equal(applyDamage({ damage: 20, armor: 5, shieldS: 0 }), 15);
  });

  test('a hit never falls below the minimum damage floor', () => {
    assert.equal(applyDamage({ damage: 4, armor: 100, shieldS: 0 }), MIN_DAMAGE);
  });

  test('a shield absorbs the whole hit', () => {
    assert.equal(applyDamage({ damage: 999, armor: 0, shieldS: 1.5 }), 0);
  });

  test('the shield stops absorbing at zero', () => {
    assert.equal(applyDamage({ damage: 20, armor: 0, shieldS: 0 }), 20);
  });

  test('zero damage stays zero rather than flooring up', () => {
    assert.equal(applyDamage({ damage: 0, armor: 0, shieldS: 0 }), 0);
  });
});

describe('Combat — projectile pool', () => {
  test('recycles slots rather than growing', () => {
    const pool = new ProjectilePool(4);
    const ids = new Set<string>();

    for (let index = 0; index < 4; index += 1) {
      const shot = pool.spawn({
        ownerId: 'p',
        ownerIsNpc: false,
        x: 0,
        y: 0,
        angle: 0,
        damage: 1,
        shipMaxSpeed: 240,
      });
      assert.notEqual(shot, null);
      if (shot !== null) ids.add(shot.id);
    }

    assert.equal(pool.liveCount, 4);
    assert.equal(ids.size, 4, 'each live shot needs its own id');
  });

  test('refuses a shot when full and counts the drop', () => {
    const pool = new ProjectilePool(2);
    for (let index = 0; index < 2; index += 1) {
      pool.spawn({
        ownerId: 'p',
        ownerIsNpc: false,
        x: 0,
        y: 0,
        angle: 0,
        damage: 1,
        shipMaxSpeed: 240,
      });
    }

    const overflow = pool.spawn({
      ownerId: 'p',
      ownerIsNpc: false,
      x: 0,
      y: 0,
      angle: 0,
      damage: 1,
      shipMaxSpeed: 240,
    });

    assert.equal(overflow, null);
    assert.equal(pool.liveCount, 2);
    assert.equal(pool.droppedCount, 1);
  });

  test('a slot is reusable after its shot expires', () => {
    const pool = new ProjectilePool(1);
    pool.spawn({
      ownerId: 'p',
      ownerIsNpc: false,
      x: 0,
      y: 0,
      angle: 0,
      damage: 1,
      shipMaxSpeed: 240,
    });
    assert.equal(pool.liveCount, 1);

    // Expire it: lifetime is 2 s, the tick is 50 ms.
    const ticks = Math.ceil(PROJECTILE_LIFETIME_S / TICK_DURATION_S);
    for (let index = 0; index < ticks; index += 1) pool.advance();

    assert.equal(pool.liveCount, 0);

    const reused = pool.spawn({
      ownerId: 'p',
      ownerIsNpc: false,
      x: 0,
      y: 0,
      angle: 0,
      damage: 1,
      shipMaxSpeed: 240,
    });
    assert.notEqual(reused, null);
  });

  test('a shot travels at the expected speed along its heading', () => {
    const pool = new ProjectilePool(1);
    const shot = pool.spawn({
      ownerId: 'p',
      ownerIsNpc: false,
      x: 1_000,
      y: 1_000,
      angle: 0,
      damage: 1,
      shipMaxSpeed: 240,
    });
    assert.notEqual(shot, null);
    if (shot === null) return;

    const startX = shot.x;
    pool.advance();

    // 240 * 3 = 720 u/s, so one 50 ms tick is 36 units.
    assert.ok(Math.abs(shot.x - startX - 36) < 0.5, `moved ${(shot.x - startX).toFixed(2)} units`);
    assert.ok(Math.abs(shot.y - 1_000) < 0.001, 'should not drift off-axis');
  });

  test('default capacity matches the documented cap', () => {
    assert.equal(new ProjectilePool().capacity, PROJECTILE_MAX_ALIVE);
  });
});

describe('Combat — loot', () => {
  test('drops one box per Coastal, two per Raider, three per Warship', () => {
    for (const tier of [NpcTier.Small, NpcTier.Medium, NpcTier.Large] as const) {
      const drops = lootForKill({ tier, x: 0, y: 0, sourceId: 'n1', random: () => 0.5 });
      assert.equal(drops.length, BOX_DROP_TABLE[tier].boxCount, `tier ${tier}`);
    }
  });

  test('box positions fan out rather than stacking', () => {
    const drops = lootForKill({
      tier: NpcTier.Large,
      x: 0,
      y: 0,
      sourceId: 'n1',
      random: () => 0.5,
    });
    const angles = new Set(drops.map((drop) => Math.round(drop.angle * 100)));

    assert.equal(angles.size, drops.length, 'each box should have its own bearing');
  });

  test('a part box rolls the chance from the drop table', () => {
    /* `partChance` is 0.4 for a Warship, so a random of 0.1 must produce parts and 0.9
       must not. Pinning both sides proves the table is consulted rather than a constant. */
    const partHeavy = lootForKill({
      tier: NpcTier.Large,
      x: 0,
      y: 0,
      sourceId: 'n1',
      random: () => 0.1,
    });
    assert.ok(partHeavy.every((drop) => drop.kind === BoxKind.Part));

    const scrapHeavy = lootForKill({
      tier: NpcTier.Large,
      x: 0,
      y: 0,
      sourceId: 'n1',
      random: () => 0.9,
    });
    assert.ok(scrapHeavy.every((drop) => drop.kind === BoxKind.Scrap));
  });
});

describe('Combat — box pool', () => {
  test('spawns, ticks down and expires', () => {
    const pool = new BoxPool(4);
    const box = pool.spawn({
      x: 0,
      y: 0,
      kind: BoxKind.Scrap,
      value: 5,
      sourceId: 'n1',
      angle: 0,
      distance: 20,
    });
    assert.notEqual(box, null);
    assert.equal(pool.liveCount, 1);

    /* Derived, with slack for floating-point accumulation: 120 s / 50 ms is 2400
       subtractions and the residual is a few ulps. */
    const ticks = Math.ceil(BOX_LIFETIME_S / TICK_DURATION_S) + 1;
    for (let index = 0; index < ticks; index += 1) pool.advance();
    assert.equal(pool.liveCount, 0);
  });

  test('release frees the slot immediately', () => {
    const pool = new BoxPool(2);
    const box = pool.spawn({
      x: 0,
      y: 0,
      kind: BoxKind.Repair,
      value: 0,
      sourceId: 'n1',
      angle: 0,
      distance: 20,
    });
    assert.notEqual(box, null);
    if (box === null) return;

    pool.release(box);
    assert.equal(pool.liveCount, 0);
  });

  test('default capacity matches the documented cap', () => {
    assert.equal(new BoxPool().capacity, BOX_MAX_ALIVE);
  });
});

describe('Combat — hull tiers', () => {
  test('tier 1 leaves the stat block untouched', () => {
    const stats = {
      maxHp: 100,
      maxSpeed: 200,
      turnRate: 1.5,
      radius: 20,
      damage: 10,
      armor: 4,
      range: 500,
      reloadTime: 0.4,
    };

    assert.deepEqual(statsForTier(stats, 1), stats);
  });

  test('a higher tier raises hull, speed and damage', () => {
    const stats = {
      maxHp: 100,
      maxSpeed: 200,
      turnRate: 1.5,
      radius: 20,
      damage: 10,
      armor: 4,
      range: 500,
      reloadTime: 0.4,
    };

    const tier2 = statsForTier(stats, 1.2);
    assert.equal(tier2.maxHp, 120);
    assert.equal(tier2.maxSpeed, 240);
    assert.equal(tier2.damage, 12);
  });

  test('reload time shrinks rather than growing', () => {
    /* Reload is a duration: multiplying it would make a better hull shoot more slowly,
       which is the opposite of what a tier is for. */
    const stats = {
      maxHp: 100,
      maxSpeed: 200,
      turnRate: 1.5,
      radius: 20,
      damage: 10,
      armor: 4,
      range: 500,
      reloadTime: 0.4,
    };

    assert.ok(statsForTier(stats, 1.2).reloadTime < 0.4);
  });
});

describe('Combat — kill reward', () => {
  test('the open sea is worth more than the mid band, which beats the safe zone', () => {
    const base = {
      tier: NpcTier.Medium,
      baseXp: NPC_STATS[NpcTier.Medium].xp,
      playerLevel: 1,
      npcLevel: 1,
    };

    /* Calls the shipped function, not a reimplementation of it: a test that restates the
       formula passes even when the formula changes. */
    const safe = killReward({ ...base, zone: ZoneId.Safe });
    const mid = killReward({ ...base, zone: ZoneId.Mid });
    const open = killReward({ ...base, zone: ZoneId.Open });

    assert.ok(mid > safe, `mid ${String(mid)} should beat safe ${String(safe)}`);
    assert.ok(open > mid, `open ${String(open)} should beat mid ${String(mid)}`);
  });

  test('farming far below your level pays less', () => {
    const base = {
      tier: NpcTier.Small,
      baseXp: NPC_STATS[NpcTier.Small].xp,
      zone: ZoneId.Mid,
      npcLevel: 1,
    };

    const fresh = killReward({ ...base, playerLevel: 1 });
    const veteran = killReward({ ...base, playerLevel: 40 });

    assert.ok(
      veteran < fresh,
      `a level-40 player should earn less: ${String(veteran)} vs ${String(fresh)}`,
    );
    assert.ok(veteran > 0, 'the penalty must never reach zero');
  });
});
