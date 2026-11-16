import { NpcTier } from '@warship/shared';

/**
 * Target selection for automatic fire.
 *
 * This is the whole PvE targeting rule, kept as pure functions so it can be tested
 * without a world, a tick, or a socket. The server calls it once per player per tick;
 * the client never runs it, because the client is not allowed to decide what gets shot.
 *
 * The rules, in priority order:
 *
 *  1. A manual selection wins, as long as it is still alive and still inside weapon
 *     range. Both conditions are re-checked every tick, so a player cannot hold a lock
 *     on a corpse or on something that has fled.
 *  2. Otherwise, the nearest live NPC inside weapon range.
 *  3. Otherwise, nothing — and with nothing, the guns are silent.
 *
 * Note that "in range" uses the same wrapped distance the simulation uses. Using a
 * straight-line distance here would make a target across the world seam look 8 000
 * units away and silently immune, which is exactly the bug that makes some enemies
 * mysteriously untargetable near an edge.
 */

export interface TargetCandidate {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

export interface TargetOwner {
  readonly x: number;
  readonly y: number;
}

/** Result of one targeting pass. */
export interface TargetSelection {
  /** Chosen id, or `null` when there is nothing worth shooting. */
  readonly id: string | null;
  /** Wrapped centre-to-centre distance to the target, 0 when there is none. */
  readonly distance: number;
}

const NO_TARGET: TargetSelection = { id: null, distance: 0 };

/**
 * Shortest wrapped offset from `from` to `to` on the toroidal world.
 *
 * Duplicated deliberately rather than imported from `@warship/shared`: this module is
 * about *targeting*, and the moment it reaches into the simulation's helpers it becomes
 * hard to tell which of the two owns the rule. The shared `wrappedDelta` is used by the
 * caller for everything else.
 */
function wrappedOffset(
  from: TargetOwner,
  to: TargetCandidate,
  worldWidth: number,
  worldHeight: number,
): { x: number; y: number } {
  let dx = to.x - from.x;
  let dy = to.y - from.y;

  if (dx > worldWidth / 2) dx -= worldWidth;
  else if (dx < -worldWidth / 2) dx += worldWidth;

  if (dy > worldHeight / 2) dy -= worldHeight;
  else if (dy < -worldHeight / 2) dy += worldHeight;

  return { x: dx, y: dy };
}

/** Wrapped distance between two points, in world units. */
export function wrappedDistance(
  from: TargetOwner,
  to: TargetCandidate,
  worldWidth: number,
  worldHeight: number,
): number {
  const offset = wrappedOffset(from, to, worldWidth, worldHeight);
  return Math.hypot(offset.x, offset.y);
}

/**
 * Choose the target for one player this tick.
 *
 * `candidates` is expected to be every live NPC. It is passed in rather than looked up
 * so the caller can share one list across every player — with 100 players and 50 NPCs a
 * per-player scan of the whole map would be 5 000 distance checks per tick.
 */
export function selectTarget(options: {
  readonly owner: TargetOwner;
  readonly candidates: readonly TargetCandidate[];
  /** Manual selection from a `TARGET` message, or `null` for automatic. */
  readonly manualTargetId: string | null;
  /** Weapon range in world units. A target beyond this is not shootable. */
  readonly range: number;
  readonly worldWidth: number;
  readonly worldHeight: number;
}): TargetSelection {
  const { owner, candidates, manualTargetId, range, worldWidth, worldHeight } = options;

  /* Manual first: a player who clicked something meant it, and overriding that choice
     with "actually the nearest one" is the single most infuriating thing a targeting
     system can do. It still has to be alive (it is in the list) and in range. */
  if (manualTargetId !== null) {
    for (const candidate of candidates) {
      if (candidate.id !== manualTargetId) continue;
      const distance = wrappedDistance(owner, candidate, worldWidth, worldHeight);
      return distance <= range ? { id: candidate.id, distance } : NO_TARGET;
    }
    // The manual target is gone: fall through to automatic rather than firing at nothing.
  }

  let best: TargetSelection = NO_TARGET;
  for (const candidate of candidates) {
    const distance = wrappedDistance(owner, candidate, worldWidth, worldHeight);
    if (distance > range) continue;
    if (best.id === null || distance < best.distance) {
      best = { id: candidate.id, distance };
    }
  }

  return best;
}

/**
 * Whether the gun may fire this tick.
 *
 * Two separate gates, both needed: `reloadTime` is how fast the mechanism cycles, and
 * `fireRate` is the sustained rate the ship is allowed. Checking only the reload would
 * let a 0.25 s reload class fire four times a second forever.
 */
export function canFire(options: {
  readonly tick: number;
  readonly lastFiredTick: number | null;
  readonly reloadTime: number;
  readonly fireRate: number;
  readonly tickDurationS: number;
}): boolean {
  const { tick, lastFiredTick, reloadTime, fireRate, tickDurationS } = options;
  if (lastFiredTick === null) return true;

  const reloadTicks = Math.max(1, Math.round(reloadTime / tickDurationS));
  const rateTicks =
    fireRate > 0 ? Math.ceil(1 / (fireRate * tickDurationS)) : Number.POSITIVE_INFINITY;

  return tick - lastFiredTick >= Math.max(reloadTicks, rateTicks);
}

/**
 * Ring colour per NPC tier, so threat level is legible at a glance.
 *
 * Deliberately its own palette, **not** `NPC_TIER_COLORS`. Those are hull tints
 * (green / orange / purple) chosen to look like the faction's paint; these are a traffic
 * light (green / yellow / red) chosen to be read in one glance during a fight. Aliasing
 * one to the other would make a "medium" enemy orange-ringed and a "large" one purple,
 * which is precisely the signal a player cannot decode mid-combat.
 */
export const NPC_TIER_RING_COLORS: Readonly<Record<NpcTier, number>> = {
  [NpcTier.Small]: 0x4ade80, // green — safe to engage
  [NpcTier.Medium]: 0xfacc15, // yellow — even fight
  [NpcTier.Large]: 0xef4444, // red — bring friends
};

/**
 * Scale per NPC tier.
 *
 * The three tiers share one sprite, so size is the primary signal that a Warship is not
 * a Coastal — before it has even fired. Ring colour is the secondary one, for players
 * who cannot separate the two greens.
 */
export const NPC_TIER_SCALE: Readonly<Record<NpcTier, number>> = {
  [NpcTier.Small]: 0.7,
  [NpcTier.Medium]: 1,
  [NpcTier.Large]: 1.5,
};
