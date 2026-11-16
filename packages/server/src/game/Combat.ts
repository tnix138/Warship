import {
  BOX_DROP_TABLE,
  BOX_PICKUP_RADIUS,
  BOX_REPAIR_FRACTION,
  BoxKind,
  PROJECTILE_RADIUS,
  type ZoneId,
  damageAfterArmor,
  type NpcTier,
  rewardXp,
  wrappedDelta,
  type ShipStats,
} from '@warship/shared';

/** Anything a projectile is allowed to hit. */
export interface Damageable {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

/** A projectile as the collision pass sees it. */
export interface Shot {
  readonly id: string;
  readonly ownerId: string;
  readonly ownerIsNpc: boolean;
  readonly x: number;
  readonly y: number;
  /** Position at the start of the tick, for the swept segment. */
  readonly previousX: number;
  readonly previousY: number;
  readonly damage: number;
}

/** Outcome of one collision test. */
export interface Hit {
  readonly projectileId: string;
  readonly targetId: string;
  readonly damage: number;
  readonly x: number;
  readonly y: number;
}

/**
 * Combat resolution.
 *
 * Everything that decides an outcome lives here: whether a shot connects, how much
 * damage it does after armor, whether that kills the target, and what the kill is worth.
 * Keeping it in one module rather than spread across `Loop` means the ordering rules
 * (armor before the minimum-damage floor, reward multipliers before rounding, shield
 * before hull) are stated once and can be tested directly.
 *
 * Nothing here mutates a player or an NPC: the functions return facts and the caller
 * applies them. That is what makes "did this shot hit?" a pure question.
 */

/**
 * Whether a shot overlaps a target this tick, using swept collision.
 *
 * ## Why swept and not point-in-circle
 *
 * A projectile moves up to ~36 units per tick (720 u/s × 50 ms) and a ship's collision
 * radius is 16–26 units. Testing only the post-move position therefore tunnels straight
 * through most targets at full speed — the shot appears, the ship is hit a tick later or
 * not at all, and the player sees shots pass through hulls. Sweeping the segment from
 * the previous position to the current one against the circle closes that gap exactly,
 * for the cost of one quadratic.
 */
export function sweptHit(options: {
  readonly fromX: number;
  readonly fromY: number;
  readonly toX: number;
  readonly toY: number;
  readonly target: Damageable;
}): boolean {
  const radius = options.target.radius + PROJECTILE_RADIUS;

  /* Work in the target's local frame, using the shortest wrapped offset from the target
     to the start of the segment. Doing this in absolute coordinates would make a shot
     crossing the seam miss a target it passes straight through. */
  const start = wrappedDelta(options.target, { x: options.fromX, y: options.fromY });
  const end = wrappedDelta(options.target, { x: options.toX, y: options.toY });

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;

  // A shot that did not move this tick is still allowed to hit: treat it as a point.
  if (lengthSquared === 0) {
    return start.x * start.x + start.y * start.y <= radius * radius;
  }

  /* Closest point on the segment to the circle's centre (the origin in local space).
     `t` is the projection parameter, clamped to the segment. */
  const t = Math.max(0, Math.min(1, -(start.x * dx + start.y * dy) / lengthSquared));
  const closestX = start.x + dx * t;
  const closestY = start.y + dy * t;

  return closestX * closestX + closestY * closestY <= radius * radius;
}

/**
 * Resolve every shot against every target for one tick.
 *
 * `targets` are players and NPCs; `shots` is the live projectile list. A shot can only
 * hit one target, and a target can only be hit once per tick by the same shot — a
 * projectile that connects is consumed, which is what stops one shot sweeping through a
 * formation and damaging everyone in it.
 *
 * Friendly fire between NPCs is off: an NPC shooting through a crowd of its own kind
 * would otherwise be doing the player's work for them.
 */
export function resolveHits(options: {
  readonly shots: readonly Shot[];
  readonly targets: readonly (Damageable & { readonly isNpc: boolean })[];
}): readonly Hit[] {
  const hits: Hit[] = [];
  const consumed = new Set<string>();

  for (const shot of options.shots) {
    if (consumed.has(shot.id)) continue;

    for (const target of options.targets) {
      if (target.id === shot.ownerId) continue;
      if (shot.ownerIsNpc && target.isNpc) continue;

      if (
        !sweptHit({
          fromX: shot.previousX,
          fromY: shot.previousY,
          toX: shot.x,
          toY: shot.y,
          target,
        })
      ) {
        continue;
      }

      hits.push({
        projectileId: shot.id,
        targetId: target.id,
        damage: shot.damage,
        x: shot.x,
        y: shot.y,
      });
      consumed.add(shot.id);
      break;
    }
  }

  return hits;
}

/**
 * Damage actually applied to a hull.
 *
 * Armor is subtractive and there is a minimum-damage floor, so a heavily armored target
 * still takes chip damage rather than becoming invulnerable. Shields absorb the whole
 * hit — a spawn shield is meant to be absolute, and a partial shield would let a
 * determined attacker chip a freshly respawned player down inside their own safe zone.
 */
export function applyDamage(options: {
  readonly damage: number;
  readonly armor: number;
  readonly shieldS: number;
}): number {
  if (options.shieldS > 0) return 0;
  return damageAfterArmor(options.damage, options.armor);
}

/**
 * XP awarded for a kill, after the zone multiplier and the level-gap penalty.
 *
 * Zone multiplier rewards going out into danger, which is the whole point of the
 * concentric design. The gap penalty stops a level-30 player farming level-1 Coasters
 * for full value.
 */
export function killReward(options: {
  readonly tier: NpcTier;
  readonly baseXp: number;
  readonly zone: ZoneId;
  readonly playerLevel: number;
  readonly npcLevel: number;
}): number {
  return rewardXp(options.baseXp, options.zone, options.playerLevel, options.npcLevel);
}

/**
 * The boxes a kill produces, as placement instructions.
 *
 * Deterministic when `random` is: the pool decides *what* each box holds, this decides
 * *where* it lands and gives it a stable identity for the client's pickup flow.
 */
export function lootForKill(options: {
  readonly tier: NpcTier;
  readonly x: number;
  readonly y: number;
  readonly sourceId: string;
  readonly random?: () => number;
}): readonly {
  readonly kind: BoxKind;
  readonly value: number;
  readonly angle: number;
  readonly distance: number;
}[] {
  const random = options.random ?? Math.random;
  const table = BOX_DROP_TABLE[options.tier];
  const drops: { kind: BoxKind; value: number; angle: number; distance: number }[] = [];

  for (let index = 0; index < table.boxCount; index += 1) {
    /* Spread the boxes evenly around the wreck rather than on top of each other, so
       collecting them all takes a slow turn instead of a single stop. */
    const angle = (index / Math.max(1, table.boxCount)) * Math.PI * 2 + random() * 0.5;
    const distance = 40 + random() * 55;

    const kind: BoxKind =
      random() < table.partChance ? BoxKind.Part : random() < 0.18 ? BoxKind.Repair : BoxKind.Scrap;

    const value =
      kind === BoxKind.Scrap
        ? table.scrap.min + Math.floor(random() * (table.scrap.max - table.scrap.min + 1))
        : kind === BoxKind.Part
          ? table.xp.min + Math.floor(random() * (table.xp.max - table.xp.min + 1))
          : 0;

    drops.push({ kind, value, angle, distance });
  }

  return drops;
}

/** Whether a box is close enough to the given position to be collected. */
export function isPickupInRange(
  box: { readonly x: number; readonly y: number },
  player: { readonly x: number; readonly y: number },
  radius: number = BOX_PICKUP_RADIUS,
): boolean {
  const delta = wrappedDelta(player, box);
  return delta.x * delta.x + delta.y * delta.y <= radius * radius;
}

/** Hull points a repair box restores from a given max HP. */
export function repairAmount(maxHp: number): number {
  return Math.max(1, Math.round(maxHp * BOX_REPAIR_FRACTION));
}

/**
 * Ship stats with a hull tier applied.
 *
 * Multiplicative so the tiers compound the way the upgrade tree does; additive would
 * make tier 3 barely different from tier 2 once a player has bought a few ranks.
 */
export function statsForTier<Stats extends ShipStats>(stats: Stats, multiplier: number): Stats {
  if (multiplier === 1) return stats;

  return {
    ...stats,
    maxHp: Math.round(stats.maxHp * multiplier),
    maxSpeed: Math.round(stats.maxSpeed * multiplier),
    damage: Math.round(stats.damage * multiplier),
    armor: Math.round(stats.armor * multiplier),
    range: Math.round(stats.range * multiplier),
    /* Reload is a duration: multiplying it would make a better hull shoot *slower*.
       Dividing shortens it, which is what a stronger hull should feel like. */
    reloadTime: stats.reloadTime / multiplier,
  };
}
