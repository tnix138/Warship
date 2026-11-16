import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  LEVELS_PER_HULL_TIER,
  MAX_HULL_TIER,
  UPGRADE_POINTS_PER_LEVEL,
  UPGRADES,
  UpgradeId,
  xpForLevel,
  type UpgradeId as UpgradeIdType,
} from '@warship/shared';

import {
  addXp,
  hullTierForLevel,
  hullTierMultiplier,
  purchasableUpgrades,
  purchaseUpgrade,
} from './Progression.js';

/**
 * Progression tests.
 *
 * The interesting rules are all about *counting*: how many upgrade points a single award
 * grants when it spans several levels, and when a hull tier steps up. Both are easy to
 * get subtly wrong — granting one point per call instead of per level, or stepping the
 * tier a level early — and neither shows up until a player has actually levelled.
 */

/** XP that lands exactly on `level`. */
function xpAt(level: number): number {
  return xpForLevel(level);
}

describe('Progression — hull tiers', () => {
  test('tier 1 covers the first ten levels', () => {
    for (let level = 1; level <= LEVELS_PER_HULL_TIER; level += 1) {
      assert.equal(hullTierForLevel(level), 1, `level ${String(level)}`);
    }
  });

  test('tier steps up exactly on the boundary', () => {
    assert.equal(hullTierForLevel(LEVELS_PER_HULL_TIER + 1), 2);
    assert.equal(hullTierForLevel(LEVELS_PER_HULL_TIER * 2 + 1), 3);
  });

  test('never exceeds the maximum tier', () => {
    assert.equal(hullTierForLevel(999), MAX_HULL_TIER);
  });

  test('nonsense levels fall back to tier 1 rather than NaN', () => {
    assert.equal(hullTierForLevel(Number.NaN), 1);
    assert.equal(hullTierForLevel(-10), 1);
  });

  test('each tier multiplies by the configured factor', () => {
    assert.equal(hullTierMultiplier(1), 1);
    assert.ok(Math.abs(hullTierMultiplier(2) - 1.2) < 1e-9);
    assert.ok(Math.abs(hullTierMultiplier(3) - 1.44) < 1e-9);
  });
});

describe('Progression — XP and points', () => {
  test('awarding zero XP changes nothing', () => {
    const outcome = addXp(0, 0, 0);
    assert.equal(outcome.result, null);
    assert.equal(outcome.xp, 0);
    assert.equal(outcome.upgradePoints, 0);
  });

  test('an award that does not cross a level grants no points', () => {
    const outcome = addXp(0, 10, 0);
    assert.equal(outcome.result, null);
    assert.equal(outcome.upgradePoints, 0);
    assert.equal(outcome.level, 1);
  });

  test('crossing one level grants one point', () => {
    const outcome = addXp(0, xpAt(2), 0);

    assert.notEqual(outcome.result, null);
    assert.equal(outcome.level, 2);
    assert.equal(outcome.upgradePoints, UPGRADE_POINTS_PER_LEVEL);
  });

  test('one award spanning three levels grants three points', () => {
    /* The counting bug this guards against: granting per *call* would give one point no
       matter how far the player jumped. */
    const outcome = addXp(0, xpAt(4), 0);

    assert.notEqual(outcome.result, null);
    assert.equal(outcome.level, 4);
    assert.equal(
      outcome.upgradePoints,
      3 * UPGRADE_POINTS_PER_LEVEL,
      'three levels must mean three points',
    );
  });

  test('points accumulate on top of unspent ones', () => {
    const outcome = addXp(0, xpAt(2), 5);
    assert.equal(outcome.upgradePoints, 5 + UPGRADE_POINTS_PER_LEVEL);
  });

  test('crossing a tier boundary reports a hull upgrade', () => {
    /* xpForLevel(10) is the *start* of level 10, which is still tier 1. Crossing into
       level 11 is what steps the hull up, so the award has to be big enough to reach it. */
    const outcome = addXp(
      xpAt(LEVELS_PER_HULL_TIER),
      xpAt(LEVELS_PER_HULL_TIER + 1) - xpAt(LEVELS_PER_HULL_TIER),
      0,
    );

    /* `assert.equal` does not narrow for the compiler, so the null check is explicit:
       the assertion documents the intent and the guard makes the following lines legal. */
    assert.notEqual(outcome.result, null);
    const result = outcome.result;
    assert.ok(result !== null);
    assert.equal(result.hullUpgraded, true);
    assert.equal(result.hullTier, 2);
  });

  test('a level that stays inside a tier does not report a hull upgrade', () => {
    const outcome = addXp(xpAt(2), xpAt(3) - xpAt(2), 0);

    assert.notEqual(outcome.result, null);
    assert.equal(outcome.result?.hullUpgraded, false);
  });
});

describe('Progression — upgrade purchase', () => {
  test('refuses without a point', () => {
    const outcome = purchaseUpgrade({
      upgradeId: UpgradeId.ReinforcedHull,
      owned: new Map(),
      upgradePoints: 0,
    });

    assert.equal(outcome, null);
  });

  test('buys the first rank for one point', () => {
    const outcome = purchaseUpgrade({
      upgradeId: UpgradeId.ReinforcedHull,
      owned: new Map(),
      upgradePoints: 1,
    });

    assert.notEqual(outcome, null);
    assert.ok(outcome !== null);
    assert.equal(outcome.rank, 1);
    assert.equal(outcome.upgradePoints, 0);
  });

  test('refuses past the rank cap', () => {
    const owned = new Map<UpgradeIdType, number>([
      [UpgradeId.ReinforcedHull, UPGRADES[UpgradeId.ReinforcedHull].maxRank],
    ]);

    const outcome = purchaseUpgrade({
      upgradeId: UpgradeId.ReinforcedHull,
      owned,
      upgradePoints: 10,
    });

    assert.equal(outcome, null);
  });

  test('refuses an upgrade whose prerequisite is missing', () => {
    /* Find a real gated upgrade rather than assuming one exists: if the tree changes so
       that none has a requirement, this test should fail loudly instead of passing
       vacuously. */
    const gated = (Object.keys(UPGRADES) as UpgradeIdType[]).find(
      (id) => UPGRADES[id].requires.length > 0,
    );
    assert.notEqual(gated, undefined, 'the tree should contain at least one gated upgrade');

    const outcome = purchaseUpgrade({
      upgradeId: gated ?? UpgradeId.ReinforcedHull,
      owned: new Map(),
      upgradePoints: 5,
    });

    assert.equal(outcome, null);
  });

  test('refuses an id that is not in the tree', () => {
    const outcome = purchaseUpgrade({
      upgradeId: 'not-a-real-upgrade' as UpgradeIdType,
      owned: new Map(),
      upgradePoints: 5,
    });

    assert.equal(outcome, null);
  });

  test('purchasableUpgrades is empty with no points', () => {
    assert.equal(purchasableUpgrades(new Map(), 0).length, 0);
  });

  test('purchasableUpgrades is non-empty with a point', () => {
    assert.ok(purchasableUpgrades(new Map(), 1).length > 0);
  });
});
