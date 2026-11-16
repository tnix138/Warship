/**
 * Unit tests for the shared gameplay formulas.
 *
 * These are the numbers both the server simulation and the client HUD agree on,
 * so each one is pinned here with an explicit expectation. Run with `pnpm test`.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  MAX_LEVEL,
  MIN_DAMAGE,
  SHIP_CLASSES,
  STARTING_LEVEL,
  XP_BASE,
  XP_GROWTH,
  ZoneId,
  type ShipClass,
} from './constants.js';
import {
  angleDelta,
  availableUpgrades,
  computeShipStats,
  damageAfterArmor,
  gridCellOf,
  gridCellKey,
  gridCellsInRadius,
  levelFromXp,
  normalizeAngle,
  rewardXp,
  rotateTowards,
  stepMotion,
  upgradeCost,
  wrapWorldPosition,
  wrappedDelta,
  wrappedDistanceSq,
  xpForLevel,
  xpProgress,
  xpToNextLevel,
  zoneAt,
  zoneMultiplier,
} from './formulas.js';
import { MVP_UPGRADE_IDS, UPGRADES, UpgradeId } from './upgrades.js';

/* -------------------------------------------------------------------------- */
/*  xpForLevel                                                                */
/* -------------------------------------------------------------------------- */

describe('xpForLevel', () => {
  test('level 1 costs nothing', () => {
    assert.equal(xpForLevel(1), 0);
  });

  test('level 2 costs exactly XP_BASE', () => {
    assert.equal(xpForLevel(2), XP_BASE);
  });

  test('level 3 costs XP_BASE plus the first growth step', () => {
    assert.equal(xpForLevel(3), Math.round(XP_BASE + XP_BASE * XP_GROWTH));
  });

  test('is strictly increasing', () => {
    for (let level = 1; level < MAX_LEVEL; level += 1) {
      assert.ok(
        xpForLevel(level + 1) > xpForLevel(level),
        `level ${String(level + 1)} must cost more than level ${String(level)}`,
      );
    }
  });

  test('clamps below level 1 and above MAX_LEVEL', () => {
    assert.equal(xpForLevel(0), 0);
    assert.equal(xpForLevel(-5), 0);
    assert.equal(xpForLevel(MAX_LEVEL + 10), xpForLevel(MAX_LEVEL));
  });

  test('survives non-finite input', () => {
    assert.equal(xpForLevel(Number.NaN), 0);
    assert.equal(xpForLevel(Number.POSITIVE_INFINITY), xpForLevel(MAX_LEVEL));
  });
});

/* -------------------------------------------------------------------------- */
/*  levelFromXp                                                               */
/* -------------------------------------------------------------------------- */

describe('levelFromXp', () => {
  test('zero XP is level 1', () => {
    assert.equal(levelFromXp(0), STARTING_LEVEL);
  });

  test('is the exact inverse of xpForLevel', () => {
    for (let level = 1; level <= MAX_LEVEL; level += 1) {
      assert.equal(
        levelFromXp(xpForLevel(level)),
        level,
        `xpForLevel(${String(level)}) must map back to ${String(level)}`,
      );
    }
  });

  test('one XP short of a threshold stays on the previous level', () => {
    for (let level = 2; level <= 20; level += 1) {
      assert.equal(levelFromXp(xpForLevel(level) - 1), level - 1);
    }
  });

  test('never exceeds MAX_LEVEL', () => {
    assert.equal(levelFromXp(Number.MAX_SAFE_INTEGER), MAX_LEVEL);
  });

  test('negative and non-finite XP clamp to level 1', () => {
    assert.equal(levelFromXp(-100), STARTING_LEVEL);
    assert.equal(levelFromXp(Number.NaN), STARTING_LEVEL);
  });

  test('xpProgress reports a within-level fraction, not a fully-charted one', () => {
    /* The bug this pins: a bar built from (into = span) is pinned at 100% and looks
       plausible on a fresh character (`0 / 0`) while telling the player nothing. Both
       ends of a level and the midpoint are checked so the fill has to actually move. */
    const start = xpProgress(xpForLevel(2));
    assert.equal(start.level, 2);
    assert.equal(start.intoLevel, 0);
    assert.equal(start.fraction, 0, 'a level begins empty');

    const span = xpForLevel(3) - xpForLevel(2);
    const middle = xpProgress(xpForLevel(2) + span / 2);
    assert.ok(
      Math.abs(middle.fraction - 0.5) < 1e-9,
      `midpoint fraction was ${String(middle.fraction)}`,
    );
    assert.ok(Math.abs(middle.levelSpan - span) < 1e-9);

    const lastXp = xpProgress(xpForLevel(3) - 1);
    assert.ok(lastXp.fraction > 0.99 && lastXp.fraction < 1, 'a level ends nearly full');
  });

  test('xpProgress stays inside 0..1 at every level boundary', () => {
    for (let level = 1; level < MAX_LEVEL; level += 1) {
      const progress = xpProgress(xpForLevel(level));
      assert.ok(progress.fraction >= 0 && progress.fraction <= 1, `level ${String(level)}`);
      assert.ok(progress.levelSpan > 0, `level ${String(level)} needs a positive span`);
    }
  });

  test('xpProgress at the level cap reports a full bar rather than dividing by zero', () => {
    const capped = xpProgress(xpForLevel(MAX_LEVEL));
    assert.equal(capped.level, MAX_LEVEL);
    assert.equal(capped.fraction, 1);
    assert.ok(Number.isFinite(capped.fraction));
  });

  test('xpProgress survives nonsense input', () => {
    assert.equal(xpProgress(Number.NaN).fraction, 0);
    assert.equal(xpProgress(-500).level, 1);
  });

  test('xpToNextLevel shrinks as XP approaches the threshold', () => {
    const threshold = xpForLevel(4);
    assert.equal(xpToNextLevel(threshold - 10), 10);
    assert.equal(xpToNextLevel(threshold), xpForLevel(5) - threshold);
  });

  test('xpToNextLevel is 0 at the level cap', () => {
    assert.equal(xpToNextLevel(xpForLevel(MAX_LEVEL)), 0);
  });
});

/* -------------------------------------------------------------------------- */
/*  damageAfterArmor                                                          */
/* -------------------------------------------------------------------------- */

describe('damageAfterArmor', () => {
  test('subtracts armor linearly', () => {
    assert.equal(damageAfterArmor(30, 0), 30);
    assert.equal(damageAfterArmor(30, 10), 20);
    assert.equal(damageAfterArmor(30, 29), 1);
  });

  test('never drops below MIN_DAMAGE, so armor cannot make a target invulnerable', () => {
    assert.equal(damageAfterArmor(10, 10), MIN_DAMAGE);
    assert.equal(damageAfterArmor(10, 999), MIN_DAMAGE);
  });

  test('zero base damage stays zero', () => {
    assert.equal(damageAfterArmor(0, 5), 0);
  });

  test('negative armor is treated as none', () => {
    assert.equal(damageAfterArmor(20, -50), 20);
  });

  test('garbage input fails safe', () => {
    assert.equal(damageAfterArmor(Number.NaN, 5), 0);
    assert.equal(damageAfterArmor(20, Number.NaN), 20);
  });

  test('is monotonic in armor', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let armor = 0; armor <= 100; armor += 5) {
      const damage = damageAfterArmor(80, armor);
      assert.ok(damage <= previous);
      previous = damage;
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  upgradeCost                                                               */
/* -------------------------------------------------------------------------- */

describe('upgradeCost', () => {
  test('rank 0 costs the base price', () => {
    assert.equal(upgradeCost(UpgradeId.ReinforcedHull, 0), 120);
  });

  test('each rank costs more than the previous one', () => {
    let previous = 0;
    for (let rank = 0; rank < 5; rank += 1) {
      const cost = upgradeCost(UpgradeId.ReinforcedHull, rank);
      assert.notEqual(cost, null);
      assert.ok(cost !== null && cost > previous);
      previous = cost;
    }
  });

  test('returns null once maxed out', () => {
    assert.equal(upgradeCost(UpgradeId.ReinforcedHull, 5), null);
    assert.equal(upgradeCost(UpgradeId.ReinforcedHull, 12), null);
  });

  test('returns whole numbers of scrap', () => {
    for (const id of Object.values(UpgradeId)) {
      for (let rank = 0; rank < 5; rank += 1) {
        const cost = upgradeCost(id, rank);
        if (cost === null) continue;
        assert.ok(Number.isInteger(cost), `${id} rank ${String(rank)} must be an integer`);
      }
    }
  });

  test('negative rank is treated as zero', () => {
    assert.equal(upgradeCost(UpgradeId.MarineBoiler, -3), upgradeCost(UpgradeId.MarineBoiler, 0));
  });
});

/* -------------------------------------------------------------------------- */
/*  zoneMultiplier                                                            */
/* -------------------------------------------------------------------------- */

describe('zoneMultiplier', () => {
  test('matches the zone table exactly', () => {
    assert.equal(zoneMultiplier(ZoneId.Safe), 0.5);
    assert.equal(zoneMultiplier(ZoneId.Mid), 1);
    assert.equal(zoneMultiplier(ZoneId.Open), 1.5);
  });

  test('rises from safe to open', () => {
    assert.ok(zoneMultiplier(ZoneId.Open) > zoneMultiplier(ZoneId.Mid));
    assert.ok(zoneMultiplier(ZoneId.Mid) > zoneMultiplier(ZoneId.Safe));
  });

  test('is always positive, so rewards never go negative', () => {
    for (const zone of Object.values(ZoneId)) {
      assert.ok(zoneMultiplier(zone) > 0);
    }
  });

  test('rewardXp applies the multiplier and rounds', () => {
    assert.equal(rewardXp(100, ZoneId.Safe, 1, 1), 50);
    assert.equal(rewardXp(100, ZoneId.Open, 1, 1), 150);
  });

  test('rewardXp penalises killing far below your level, with a floor', () => {
    const fair = rewardXp(100, ZoneId.Mid, 1, 1);
    const farming = rewardXp(100, ZoneId.Mid, 20, 1);
    assert.ok(farming < fair);
    assert.ok(farming > 0);
  });
});

/* -------------------------------------------------------------------------- */
/*  Geometry                                                                  */
/* -------------------------------------------------------------------------- */

describe('geometry', () => {
  test('normalizeAngle wraps into (-pi, pi]', () => {
    assert.ok(Math.abs(normalizeAngle(Math.PI * 3) - Math.PI) < 1e-9);
    assert.ok(Math.abs(normalizeAngle(-Math.PI * 3) - Math.PI) < 1e-9);
    assert.equal(normalizeAngle(0), 0);
  });

  test('angleDelta takes the short way around', () => {
    assert.ok(Math.abs(angleDelta(0.1, -0.1) - -0.2) < 1e-9);
    // Just under a full turn: the short way is +0.1π, the long way would be -1.9π.
    const delta = angleDelta(Math.PI * 0.95, -Math.PI * 0.95);
    assert.ok(delta > 0, 'must take the positive short way');
    assert.ok(Math.abs(delta) < 0.4, 'must not travel the long way');
  });

  test('rotateTowards never overshoots', () => {
    assert.equal(rotateTowards(0, 1, 10), 1);
    assert.ok(Math.abs(rotateTowards(0, 1, 0.25) - 0.25) < 1e-9);
  });

  test('wrapWorldPosition wraps both axes', () => {
    const wrapped = wrapWorldPosition({ x: 8100, y: -200 });
    assert.equal(wrapped.x, 100);
    assert.equal(wrapped.y, 7800);
  });

  test('wrappedDelta takes the short way across a seam', () => {
    const delta = wrappedDelta({ x: 7950, y: 4000 }, { x: 50, y: 4000 });
    assert.equal(delta.x, 100);
  });

  test('wrappedDistanceSq sees across the seam and matches plain distance away from it', () => {
    assert.equal(wrappedDistanceSq({ x: 7950, y: 4000 }, { x: 50, y: 4000 }), 100 * 100);
    assert.equal(wrappedDistanceSq({ x: 100, y: 100 }, { x: 103, y: 104 }), 25);
  });
});

/* -------------------------------------------------------------------------- */
/*  Grid                                                                      */
/* -------------------------------------------------------------------------- */

describe('grid', () => {
  test('maps positions to the expected cell', () => {
    assert.deepEqual(gridCellOf({ x: 0, y: 0 }), { col: 0, row: 0 });
    assert.deepEqual(gridCellOf({ x: 2_500, y: 5_100 }), { col: 1, row: 2 });
  });

  test('wraps the world edge back to the first cell (the map is a torus)', () => {
    assert.deepEqual(gridCellOf({ x: 8_000, y: 8_000 }), { col: 0, row: 0 });
  });

  test('the last valid coordinate lands in the last cell', () => {
    assert.deepEqual(gridCellOf({ x: 7_999, y: 7_999 }), { col: 3, row: 3 });
  });

  test('cell keys are unique per cell', () => {
    const keys = new Set<number>();
    for (let row = 0; row < 4; row += 1) {
      for (let col = 0; col < 4; col += 1) {
        keys.add(gridCellKey({ col, row }));
      }
    }
    assert.equal(keys.size, 16);
  });

  test('gridCellsInRadius wraps around the world edge without duplicates', () => {
    const cells = gridCellsInRadius({ x: 10, y: 10 }, 2_100);
    const keys = cells.map(gridCellKey);
    assert.equal(new Set(keys).size, keys.length, 'no duplicate cells');
    assert.ok(cells.length > 0);
  });
});

/* -------------------------------------------------------------------------- */
/*  Zones on the map                                                          */
/* -------------------------------------------------------------------------- */

describe('zoneAt', () => {
  test('the world centre is the safe zone', () => {
    assert.equal(zoneAt({ x: 4_000, y: 4_000 }), ZoneId.Safe);
  });

  test('a point just outside the safe radius is mid', () => {
    assert.equal(zoneAt({ x: 4_000 + 1_500, y: 4_000 }), ZoneId.Mid);
  });

  test('the far rim is open sea', () => {
    assert.equal(zoneAt({ x: 4_000 + 3_500, y: 4_000 }), ZoneId.Open);
  });
});

/* -------------------------------------------------------------------------- */
/*  Ship classes & stats                                                      */
/* -------------------------------------------------------------------------- */

describe('SHIP_CLASSES', () => {
  test('fireRate is the reciprocal of reloadTime for every class', () => {
    for (const shipClass of Object.values(SHIP_CLASSES)) {
      assert.ok(
        Math.abs(shipClass.fireRate * shipClass.reloadTime - 1) < 1e-9,
        `${shipClass.id}: fireRate * reloadTime must be 1`,
      );
    }
  });

  test('every stat is positive', () => {
    for (const shipClass of Object.values(SHIP_CLASSES)) {
      for (const key of [
        'hp',
        'speed',
        'damage',
        'fireRate',
        'turnRate',
        'reloadTime',
        'range',
        'radius',
      ] as const) {
        assert.ok(shipClass[key] > 0, `${shipClass.id}.${key} must be positive`);
      }
    }
  });

  test('speed trades hull for velocity, power trades velocity for hull', () => {
    const { speed, normal, power } = SHIP_CLASSES;
    assert.ok(speed.speed > normal.speed && normal.speed > power.speed);
    assert.ok(speed.hp < normal.hp && normal.hp < power.hp);
  });
});

describe('computeShipStats', () => {
  test('with no upgrades matches the class baseline', () => {
    const stats = computeShipStats('normal');
    const base = SHIP_CLASSES.normal;
    assert.equal(stats.maxHp, base.hp);
    assert.equal(stats.maxSpeed, base.speed);
    assert.equal(stats.damage, base.damage);
    assert.equal(stats.armor, 0);
  });

  test('applies percent upgrades to the base value', () => {
    const base = SHIP_CLASSES.normal;
    const stats = computeShipStats('normal', new Map([[UpgradeId.ReinforcedHull, 2]]));
    assert.equal(stats.maxHp, Math.round(base.hp * 1.2));
  });

  test('applies flat armor upgrades', () => {
    const stats = computeShipStats('normal', new Map([[UpgradeId.ArmorPlating, 3]]));
    assert.equal(stats.armor, 18);
  });

  test('purchase order does not matter', () => {
    const a = computeShipStats(
      'power',
      new Map([
        [UpgradeId.ReinforcedHull, 2],
        [UpgradeId.HeavyShells, 1],
      ]),
    );
    const b = computeShipStats(
      'power',
      new Map([
        [UpgradeId.HeavyShells, 1],
        [UpgradeId.ReinforcedHull, 2],
      ]),
    );
    assert.deepEqual(a, b);
  });

  test('caps at maxRank even if more ranks are supplied', () => {
    const base = SHIP_CLASSES.normal;
    const stats = computeShipStats('normal', new Map([[UpgradeId.ReinforcedHull, 99]]));
    assert.equal(stats.maxHp, Math.round(base.hp * (1 + 0.1 * 5)));
  });

  test('reload upgrades shorten reloadTime', () => {
    const base = SHIP_CLASSES.normal;
    const stats = computeShipStats('normal', new Map([[UpgradeId.RapidLoader, 4]]));
    assert.ok(stats.reloadTime < base.reloadTime);
  });
});

describe('availableUpgrades', () => {
  test('starts with the root nodes', () => {
    const available = availableUpgrades(new Map());
    assert.ok(available.includes(UpgradeId.ReinforcedHull));
    assert.ok(available.includes(UpgradeId.MarineBoiler));
    assert.ok(!available.includes(UpgradeId.ArmorPlating), 'ArmorPlating needs ReinforcedHull');
  });

  test('unlocks a child once its requirement is owned', () => {
    /* Passed the full tree explicitly: the default pool is the MVP's three upgrades,
       and the prerequisite mechanic belongs to the tree, not to which subset is
       currently offered. */
    const fullTree = Object.keys(UPGRADES) as UpgradeId[];
    const locked = availableUpgrades(new Map(), fullTree);
    assert.ok(!locked.includes(UpgradeId.ArmorPlating), 'gated before its parent');

    const unlocked = availableUpgrades(new Map([[UpgradeId.ReinforcedHull, 1]]), fullTree);
    assert.ok(unlocked.includes(UpgradeId.ArmorPlating));
  });

  test('drops a node once it is maxed out', () => {
    const fullTree = Object.keys(UPGRADES) as UpgradeId[];
    const available = availableUpgrades(new Map([[UpgradeId.SteeringGear, 3]]), fullTree);
    assert.ok(!available.includes(UpgradeId.SteeringGear));
  });

  test('the MVP pool offers exactly hull, speed and damage', () => {
    /* Pinned because this is a scope decision, not an accident: three upgrades are
       enough to prove the progression loop, and a wider picker is easy to restore by
       changing `MVP_UPGRADE_IDS`. */
    assert.deepEqual([...MVP_UPGRADE_IDS].sort(), [
      UpgradeId.HeavyShells,
      UpgradeId.MarineBoiler,
      UpgradeId.ReinforcedHull,
    ]);
    assert.deepEqual([...availableUpgrades(new Map())].sort(), [...MVP_UPGRADE_IDS].sort());
  });
});

/* -------------------------------------------------------------------------- */
/*  stepMotion                                                                */
/* -------------------------------------------------------------------------- */

describe('stepMotion', () => {
  const stats = { speed: 100, turnRate: 1 };

  test('accelerates towards the throttle target without overshooting it', () => {
    const start = { x: 0, y: 0, rotation: 0, speed: 0 };
    const afterOne = stepMotion(start, { turn: 0, throttle: 1 }, stats, 0.05);
    assert.ok(afterOne.speed > 0 && afterOne.speed < 100);

    let state = start;
    for (let i = 0; i < 100; i += 1) {
      state = stepMotion(state, { turn: 0, throttle: 1 }, stats, 0.05);
    }
    assert.equal(state.speed, 100);
  });

  test('moves along the heading', () => {
    const state = stepMotion(
      { x: 0, y: 0, rotation: 0, speed: 100 },
      { turn: 0, throttle: 1 },
      stats,
      0.1,
    );
    assert.ok(state.x > 9.9 && state.x < 10.1);
    assert.ok(Math.abs(state.y) < 1e-9);
  });

  test('turning right rotates clockwise (positive angle)', () => {
    const state = stepMotion(
      { x: 0, y: 0, rotation: 0, speed: 0 },
      { turn: 1, throttle: 0 },
      stats,
      0.5,
    );
    assert.ok(state.rotation > 0);
  });

  test('is pure: the input state is not mutated', () => {
    const start = Object.freeze({ x: 5, y: 5, rotation: 0, speed: 10 });
    const result = stepMotion(start, { turn: 1, throttle: 1 }, stats, 0.05);
    assert.notEqual(result, start);
    assert.equal(start.x, 5);
    assert.equal(start.y, 5);
  });

  test('zero dt changes nothing', () => {
    const start = { x: 10, y: 20, rotation: 0.5, speed: 50 };
    assert.deepEqual(stepMotion(start, { turn: 1, throttle: 1 }, stats, 0), start);
  });
});

/* -------------------------------------------------------------------------- */
/*  Ship class naming sanity                                                  */
/* -------------------------------------------------------------------------- */

test('ShipClass union values match the runtime table keys', () => {
  const classes: ShipClass[] = ['speed', 'normal', 'power'];
  for (const shipClass of classes) {
    assert.equal(SHIP_CLASSES[shipClass].id, shipClass);
    assert.equal(typeof SHIP_CLASSES[shipClass].spriteKey, 'string');
  }
});
