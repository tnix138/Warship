import {
  HULL_TIER_MULTIPLIER,
  LEVELS_PER_HULL_TIER,
  MAX_HULL_TIER,
  UPGRADES,
  UPGRADE_POINTS_PER_LEVEL,
  availableUpgrades,
  levelFromXp,
  type UpgradeId,
} from '@warship/shared';

/** What changed when XP was added, or `null` when nothing did. */
export interface LevelUpResult {
  readonly levelsGained: number;
  readonly newLevel: number;
  /** Upgrade points granted by this XP award. */
  readonly pointsGranted: number;
  /** True when the hull itself crossed a tier boundary. */
  readonly hullUpgraded: boolean;
  /** The new tier, always present for convenience. */
  readonly hullTier: number;
}

/**
 * Progression rules: XP, levels, upgrade points and hull tiers.
 *
 * All of it is pure arithmetic over the values already stored on a `Player`, expressed
 * as functions rather than as methods on `Player` so that the rules are testable without
 * constructing a ship, and so the client can run the identical calculation for its HUD
 * without importing server code.
 *
 * ## Hull tier
 *
 * A player's *level* grows smoothly; their *hull* steps up every ten levels. That split
 * exists because a smooth power curve makes every level feel like nothing, while a
 * tier step is a visible change (a different sprite, a different stat block) that
 * arrives rarely enough to be an event. The tier multiplies all stats by
 * `HULL_TIER_MULTIPLIER`, applied on top of upgrades.
 */

/** Hull tier for a given level: 1 at levels 1–10, 2 at 11–20, 3 at 21+. */
export function hullTierForLevel(level: number): number {
  if (!Number.isFinite(level)) return 1;
  const tier = Math.floor((Math.max(1, level) - 1) / LEVELS_PER_HULL_TIER) + 1;
  return Math.min(MAX_HULL_TIER, tier);
}

/** Stat multiplier for a hull tier, applied to every stat that has one. */
export function hullTierMultiplier(tier: number): number {
  const clamped = Math.min(MAX_HULL_TIER, Math.max(1, Math.floor(tier)));
  return HULL_TIER_MULTIPLIER ** (clamped - 1);
}

/**
 * Add XP and report what changed.
 *
 * Pure: it returns the new totals rather than mutating a player, so the loop decides
 * when to apply it and a test can assert on the arithmetic alone.
 */
export function addXp(
  xpBefore: number,
  xpGained: number,
  upgradePointsBefore: number,
): {
  readonly xp: number;
  readonly level: number;
  readonly upgradePoints: number;
  readonly result: LevelUpResult | null;
} {
  const gained = Number.isFinite(xpGained) ? Math.max(0, Math.floor(xpGained)) : 0;
  if (gained === 0) {
    const level = levelFromXp(xpBefore);
    return {
      xp: xpBefore,
      level,
      upgradePoints: upgradePointsBefore,
      result: null,
    };
  }

  const before = levelFromXp(xpBefore);
  const after = levelFromXp(xpBefore + gained);
  const levelsGained = Math.max(0, after - before);

  /* Points are granted per level *gained*, never per call: a single huge XP award that
     spans three levels must grant three points, and a call that crosses none must grant
     nothing. Deriving from the level delta rather than from the call count is what makes
     both true. */
  const pointsGranted = levelsGained * UPGRADE_POINTS_PER_LEVEL;

  const tierBefore = hullTierForLevel(before);
  const tierAfter = hullTierForLevel(after);

  const xp = xpBefore + gained;
  const upgradePoints = upgradePointsBefore + pointsGranted;

  if (levelsGained === 0) {
    return { xp, level: after, upgradePoints, result: null };
  }

  return {
    xp,
    level: after,
    upgradePoints,
    result: {
      levelsGained,
      newLevel: after,
      pointsGranted,
      hullUpgraded: tierAfter > tierBefore,
      hullTier: tierAfter,
    },
  };
}

/** Upgrade ids a player may buy right now: unspent points and an unpurchased option. */
export function purchasableUpgrades(
  owned: ReadonlyMap<UpgradeId, number>,
  upgradePoints: number,
): readonly UpgradeId[] {
  if (upgradePoints <= 0) return [];
  return availableUpgrades(owned);
}

/**
 * Validate and apply an upgrade purchase.
 *
 * Returns the new rank and the remaining points, or `null` when the purchase is illegal
 * — unknown id, no points, already at max rank, or a prerequisite that is not met. The
 * server never trusts the client's `UPGRADE` frame, so this is the single gate.
 */
export function purchaseUpgrade(options: {
  readonly upgradeId: UpgradeId;
  readonly owned: ReadonlyMap<UpgradeId, number>;
  readonly upgradePoints: number;
}): { readonly rank: number; readonly upgradePoints: number } | null {
  /* An id that is not in the tree can still arrive from the wire: the UPGRADE frame's
     `upgradeId` is a string that was only *typed* as an UpgradeId, so the guard has to
     survive at runtime even though the record is total in the type system. */
  if (!Object.hasOwn(UPGRADES, options.upgradeId)) return null;
  const definition = UPGRADES[options.upgradeId];
  if (options.upgradePoints < 1) return null;

  const currentRank = options.owned.get(options.upgradeId) ?? 0;
  if (currentRank >= definition.maxRank) return null;

  const affordable = purchasableUpgrades(options.owned, options.upgradePoints);
  if (!affordable.includes(options.upgradeId)) return null;

  return { rank: currentRank + 1, upgradePoints: options.upgradePoints - 1 };
}

/**
 * XP still required to reach the next level, or 0 at the cap.
 *
 * Distinct from `xpToNextLevel`, which reports the *gap* needed. This reports the
 * absolute total, which is what a progress bar wants.
 */
export { xpProgress } from '@warship/shared';
