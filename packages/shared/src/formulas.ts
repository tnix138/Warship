/**
 * Formulas — **real implementations**, shared by server and client.
 *
 * Why shared: an authoritative server needs client-side prediction. Any number the
 * client uses to predict movement, damage or progression must come from the *same*
 * function the server uses to authorise it, otherwise players rubber-band and
 * damage numbers disagree with the health bar.
 *
 * Every function here is pure: no I/O, no clock, no randomness, no mutation of its
 * arguments. That makes them trivially unit-testable and safe to call from the hot
 * loop at 20 Hz × 100 players.
 *
 * The five gameplay core functions are documented and tested in
 * `packages/shared/src/formulas.test.ts`:
 *   xpForLevel, levelFromXp, damageAfterArmor, upgradeCost, zoneMultiplier
 */

import {
  AIM_ASSIST_FACTOR,
  GRID_COLUMNS,
  GRID_ROWS,
  GRID_SIZE,
  MAX_LEVEL,
  MIN_DAMAGE,
  SHIP_ACCELERATION,
  STARTING_LEVEL,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  XP_BASE,
  XP_GROWTH,
  SHIP_CLASSES,
  ZONES,
  ZoneId,
  type ShipClass,
  type ZoneDefinition,
  type ZoneId as ZoneIdType,
} from './constants.js';
import {
  MVP_UPGRADE_IDS,
  UPGRADES,
  type ShipStats,
  type UpgradeDefinition,
  type UpgradeId,
} from './upgrades.js';

/* -------------------------------------------------------------------------- */
/*  Small helpers                                                             */
/* -------------------------------------------------------------------------- */

/** Clamp a number into an inclusive range. */
export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Linear interpolation between `a` and `b`. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/* -------------------------------------------------------------------------- */
/*  Angles                                                                    */
/* -------------------------------------------------------------------------- */

/** Clamp an angle to the (-π, π] range. */
export function normalizeAngle(angle: number): number {
  const twoPi = Math.PI * 2;
  let wrapped = angle % twoPi;
  if (wrapped > Math.PI) wrapped -= twoPi;
  if (wrapped <= -Math.PI) wrapped += twoPi;
  return wrapped;
}

/** Shortest signed angular distance from `from` to `to`, in (-π, π]. */
export function angleDelta(from: number, to: number): number {
  return normalizeAngle(to - from);
}

/** Rotate `current` towards `target` by at most `maxStep` radians. */
export function rotateTowards(current: number, target: number, maxStep: number): number {
  const delta = angleDelta(current, target);
  const step = clamp(delta, -Math.abs(maxStep), Math.abs(maxStep));
  return normalizeAngle(current + step);
}

/* -------------------------------------------------------------------------- */
/*  World geometry (toroidal)                                                 */
/* -------------------------------------------------------------------------- */

/** Wrap a world position into the toroidal world bounds. */
export function wrapWorldPosition(position: { x: number; y: number }): { x: number; y: number } {
  return {
    x: ((position.x % WORLD_WIDTH) + WORLD_WIDTH) % WORLD_WIDTH,
    y: ((position.y % WORLD_HEIGHT) + WORLD_HEIGHT) % WORLD_HEIGHT,
  };
}

/** Shortest delta from `from` to `to` across the wrapping world. */
export function wrappedDelta(
  from: { x: number; y: number },
  to: { x: number; y: number },
): { x: number; y: number } {
  let dx = to.x - from.x;
  let dy = to.y - from.y;

  if (dx > WORLD_WIDTH / 2) dx -= WORLD_WIDTH;
  else if (dx < -WORLD_WIDTH / 2) dx += WORLD_WIDTH;

  if (dy > WORLD_HEIGHT / 2) dy -= WORLD_HEIGHT;
  else if (dy < -WORLD_HEIGHT / 2) dy += WORLD_HEIGHT;

  return { x: dx, y: dy };
}

/** Squared distance between two points, torus-aware. Sqrt is never needed for comparisons. */
export function wrappedDistanceSq(
  from: { x: number; y: number },
  to: { x: number; y: number },
): number {
  const delta = wrappedDelta(from, to);
  return delta.x * delta.x + delta.y * delta.y;
}

/** Whether `target` is inside a weapon's range from `origin` (torus-aware). */
export function isInWeaponRange(
  origin: { x: number; y: number },
  target: { x: number; y: number },
  range: number,
): boolean {
  return wrappedDistanceSq(origin, target) <= range * range;
}

/**
 * Push two overlapping circles apart, torus-aware.
 * Returns the corrected positions; the caller decides whether to apply them.
 */
export function resolveCollision(
  a: { x: number; y: number; radius: number },
  b: { x: number; y: number; radius: number },
): [{ x: number; y: number }, { x: number; y: number }] {
  const delta = wrappedDelta(a, b);
  const distance = Math.hypot(delta.x, delta.y);
  const minimum = a.radius + b.radius;

  if (distance >= minimum || distance === 0) {
    return [
      { x: a.x, y: a.y },
      { x: b.x, y: b.y },
    ];
  }

  const overlap = (minimum - distance) / 2;
  const nx = delta.x / distance;
  const ny = delta.y / distance;

  return [
    wrapWorldPosition({ x: a.x - nx * overlap, y: a.y - ny * overlap }),
    wrapWorldPosition({ x: b.x + nx * overlap, y: b.y + ny * overlap }),
  ];
}

/* -------------------------------------------------------------------------- */
/*  Grid (spatial hash maths — no culling yet)                                */
/* -------------------------------------------------------------------------- */

/** Integer grid cell coordinates. */
export interface GridCell {
  readonly col: number;
  readonly row: number;
}

/** Which grid cell a world position falls into. */
export function gridCellOf(position: { x: number; y: number }): GridCell {
  const wrapped = wrapWorldPosition(position);
  return {
    col: clamp(Math.floor(wrapped.x / GRID_SIZE), 0, GRID_COLUMNS - 1),
    row: clamp(Math.floor(wrapped.y / GRID_SIZE), 0, GRID_ROWS - 1),
  };
}

/** Stable numeric key for a cell, handy as a `Map` key. */
export function gridCellKey(cell: GridCell): number {
  return cell.row * GRID_COLUMNS + cell.col;
}

/** All cells touching a circle's radius (used by future AoI and NPC search). */
export function gridCellsInRadius(position: { x: number; y: number }, radius: number): GridCell[] {
  const wrapped = wrapWorldPosition(position);
  const reach = Math.max(0, Number.isFinite(radius) ? radius : 0);

  const minCol = Math.floor((wrapped.x - reach) / GRID_SIZE);
  const maxCol = Math.floor((wrapped.x + reach) / GRID_SIZE);
  const minRow = Math.floor((wrapped.y - reach) / GRID_SIZE);
  const maxRow = Math.floor((wrapped.y + reach) / GRID_SIZE);

  const cells: GridCell[] = [];
  for (let row = minRow; row <= maxRow; row += 1) {
    for (let col = minCol; col <= maxCol; col += 1) {
      // Toroidal wrap keeps the grid closed at the world edge.
      cells.push({
        col: ((col % GRID_COLUMNS) + GRID_COLUMNS) % GRID_COLUMNS,
        row: ((row % GRID_ROWS) + GRID_ROWS) % GRID_ROWS,
      });
    }
  }

  return dedupeCells(cells);
}

function dedupeCells(cells: GridCell[]): GridCell[] {
  const seen = new Set<number>();
  const unique: GridCell[] = [];
  for (const cell of cells) {
    const key = gridCellKey(cell);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(cell);
  }
  return unique;
}

/* -------------------------------------------------------------------------- */
/*  Zones                                                                     */
/* -------------------------------------------------------------------------- */

/** Zone definition for an id. */
export function zoneDefinition(zone: ZoneIdType): ZoneDefinition {
  const found = ZONES.find((candidate) => candidate.id === zone);
  if (found === undefined) {
    throw new RangeError(`unknown zone id: ${zone as string}`);
  }
  return found;
}

/** Which zone a world position falls into (innermost match wins). */
export function zoneAt(position: { x: number; y: number }): ZoneIdType {
  const wrapped = wrapWorldPosition(position);
  const centerX = WORLD_WIDTH / 2;
  const centerY = WORLD_HEIGHT / 2;
  const distance = Math.hypot(wrapped.x - centerX, wrapped.y - centerY);

  for (const zone of ZONES) {
    if (zone.radius === null) return zone.id;
    if (distance <= zone.radius) return zone.id;
  }

  return ZoneId.Open;
}

/**
 * XP multiplier for a zone.
 *
 * Unknown ids fall back to `1` (neutral) rather than throwing: this runs while
 * rendering a HUD, and a HUD must never crash the game.
 */
export function zoneMultiplier(zone: ZoneIdType): number {
  // Table lookup rather than a chain of ternaries: readable, and adding a zone
  // cannot silently fall through to the wrong branch.
  const multipliers: Readonly<Partial<Record<ZoneIdType, number>>> = {
    [ZoneId.Safe]: 0.5,
    [ZoneId.Mid]: 1,
    [ZoneId.Open]: 1.5,
  };
  return multipliers[zone] ?? 1;
}

/* -------------------------------------------------------------------------- */
/*  Combat                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Damage left after flat armor mitigation.
 *
 * Rules:
 *  - armor is a flat subtraction (simple, predictable, easy to show in the UI),
 *  - the result never drops below `MIN_DAMAGE`, so armor can slow a fight but
 *    never make a target invulnerable,
 *  - negative inputs are treated as 0 instead of throwing, because damage values
 *    arrive from the network and are clamped at the boundary.
 */
export function damageAfterArmor(baseDamage: number, armor: number): number {
  const base = Number.isFinite(baseDamage) ? Math.max(0, baseDamage) : 0;
  const flat = Number.isFinite(armor) ? Math.max(0, armor) : 0;
  if (base <= 0) return 0;
  return Math.max(MIN_DAMAGE, base - flat);
}

/* -------------------------------------------------------------------------- */
/*  Upgrades                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Scrap cost of the next rank of an upgrade.
 *
 * `currentLevel` is how many ranks are already owned (0 = none). The cost grows
 * geometrically by the node's `costGrowth`. Returns `null` when the node cannot be
 * bought again: maxed out, or an unknown id.
 */
export function upgradeCost(upgradeId: UpgradeId, currentLevel: number): number | null {
  // Widened lookup: `upgradeId` may arrive from the wire, so the guard is real even
  // though the static type says the record is total.
  const table: Readonly<Partial<Record<UpgradeId, UpgradeDefinition>>> = UPGRADES;
  const definition = table[upgradeId];
  if (definition === undefined) return null;

  const owned = Math.floor(Number.isFinite(currentLevel) ? Math.max(0, currentLevel) : 0);
  if (owned >= definition.maxRank) return null;

  return Math.round(definition.cost * Math.pow(definition.costGrowth, owned));
}

/** Which upgrade ids are purchasable right now, given what the player owns. */
export function availableUpgrades(
  owned: ReadonlyMap<UpgradeId, number>,
  pool: readonly UpgradeId[] = MVP_UPGRADE_IDS,
): readonly UpgradeId[] {
  /* The `pool` argument is what keeps the MVP tree honest: an upgrade that is not in it
     can never be offered, so the picker and the server agree by construction. */
  return pool.filter((id) => {
    const definition = UPGRADES[id];
    const rank = owned.get(id) ?? 0;
    if (rank >= definition.maxRank) return false;
    return definition.requires.every((requirement) => (owned.get(requirement) ?? 0) > 0);
  });
}

/**
 * Effective stats of a ship: the class baseline plus every purchased upgrade rank.
 *
 * Percent effects compound on the *base* value (not on each other), which keeps the
 * order of purchase irrelevant and prevents an upgrade tree from becoming
 * exponential. Flat effects are summed and applied after the percentages.
 */
export function computeShipStats(
  shipClass: ShipClass,
  upgrades: ReadonlyMap<UpgradeId, number> = new Map(),
): ShipStats {
  const base = SHIP_CLASSES[shipClass];

  let hp = base.hp;
  let maxSpeed = base.speed;
  let turnRate = base.turnRate;
  let damage = base.damage;
  let range = base.range;
  let reloadTime = base.reloadTime;
  let armor = 0;

  const table: Readonly<Partial<Record<UpgradeId, UpgradeDefinition>>> = UPGRADES;

  for (const [id, rank] of upgrades) {
    // Widened for the same reason as `upgradeCost`: ranks come from storage and
    // may name an upgrade this build no longer ships.
    const definition = table[id];
    if (definition === undefined || rank <= 0) continue;

    const effective = Math.min(rank, definition.maxRank);
    const effect = definition.effect;

    if (effect.kind === 'flat') {
      if (definition.stat === 'armor') armor += effect.amount * effective;
      continue;
    }

    if (effect.kind === 'percent') {
      const scale = 1 + effect.factor * effective;
      switch (definition.stat) {
        case 'hp':
          hp *= scale;
          break;
        case 'maxSpeed':
          maxSpeed *= scale;
          break;
        case 'turnRate':
          turnRate *= scale;
          break;
        case 'damage':
          damage *= scale;
          break;
        case 'range':
          range *= scale;
          break;
        case 'reload':
          reloadTime *= scale;
          break;
        default:
          break;
      }
    }
  }

  return {
    maxHp: Math.round(hp),
    maxSpeed: Math.round(maxSpeed),
    turnRate: turnRate,
    radius: base.radius,
    damage: Math.round(damage * 100) / 100,
    armor,
    range: Math.round(range),
    reloadTime: Math.max(0.05, Math.round(reloadTime * 1000) / 1000),
  };
}

/* -------------------------------------------------------------------------- */
/*  Progression                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Total XP required to **reach** `level` from level 1.
 *
 * The curve is geometric with a gentle ratio: every level costs `XP_GROWTH` times
 * the previous one, so early levels come fast and later ones are a grind without
 * exploding into unreadable numbers.
 *
 *   xpForLevel(1) === 0        (a fresh player is already level 1)
 *   xpForLevel(2) === XP_BASE
 *   xpForLevel(3) === XP_BASE * (1 + XP_GROWTH)
 */
export function xpForLevel(level: number): number {
  // NaN has no ordering, so it falls back to level 1; +/-Infinity clamps to the cap.
  const raw = Number.isNaN(level) ? STARTING_LEVEL : level;
  const target = Math.floor(clamp(raw, STARTING_LEVEL, MAX_LEVEL));
  if (target <= STARTING_LEVEL) return 0;

  let total = 0;
  let step = XP_BASE;
  for (let current = STARTING_LEVEL; current < target; current += 1) {
    total += step;
    step *= XP_GROWTH;
  }

  return Math.round(total);
}

/**
 * Level implied by a total XP amount, clamped to `[1, MAX_LEVEL]`.
 * Inverse of `xpForLevel` in the sense that `levelFromXp(xpForLevel(n)) === n`.
 */
export function levelFromXp(xp: number): number {
  const total = Number.isFinite(xp) ? Math.max(0, xp) : 0;

  // `maxLevel` is typed as `number` so the comparison is not narrowed away: the
  // constant is 50 today but this loop must keep working if it changes.
  const maxLevel: number = MAX_LEVEL;
  let level = STARTING_LEVEL;
  while (level < maxLevel && total >= xpForLevel(level + 1)) {
    level += 1;
  }

  return level;
}

/** XP still required to reach the next level; `0` at `MAX_LEVEL`. */
export function xpToNextLevel(xp: number): number {
  const level = levelFromXp(xp);
  if (level >= MAX_LEVEL) return 0;
  return Math.max(0, xpForLevel(level + 1) - Math.max(0, xp));
}

/**
 * Position within the current level, for an XP bar.
 *
 * `intoLevel` is XP earned since the current level began and `span` is the width of the
 * level, so `intoLevel / span` is the fill. At the cap both are equal and `fraction` is
 * 1, which draws a full bar rather than dividing by zero.
 */
export function xpProgress(xp: number): {
  readonly level: number;
  readonly intoLevel: number;
  readonly levelSpan: number;
  readonly fraction: number;
} {
  const total = Number.isFinite(xp) ? Math.max(0, xp) : 0;
  const level = levelFromXp(total);

  const floorXp = xpForLevel(level);
  const ceilXp = xpForLevel(level + 1);
  const span = ceilXp - floorXp;

  if (!(span > 0)) return { level, intoLevel: 0, levelSpan: 0, fraction: 1 };

  const intoLevel = clamp(total - floorXp, 0, span);
  return { level, intoLevel, levelSpan: span, fraction: intoLevel / span };
}

/* -------------------------------------------------------------------------- */
/*  Loot & rewards                                                            */
/* -------------------------------------------------------------------------- */

/**
 * XP awarded for a kill, before the zone multiplier.
 * Bigger, slower ships are worth more than fast ones.
 */
export function killXp(shipClass: ShipClass): number {
  return shipClass === 'speed' ? 12 : shipClass === 'normal' ? 20 : 32;
}

/** Scrap awarded for a kill, before any multipliers. */
export function scrapReward(shipClass: ShipClass): number {
  return shipClass === 'speed' ? 8 : shipClass === 'normal' ? 14 : 24;
}

/**
 * Final XP for an action: base reward, scaled by the zone and by the level gap.
 *
 * Killing something far below your level should not be a viable way to level up,
 * so the gap term decays towards a floor instead of going negative.
 */
export function rewardXp(
  baseXp: number,
  zone: ZoneIdType,
  playerLevel: number,
  targetLevel: number,
): number {
  const base = Number.isFinite(baseXp) ? Math.max(0, baseXp) : 0;
  const gap = Math.max(0, playerLevel - targetLevel);
  const gapPenalty = Math.max(0.25, 1 - gap * 0.08);
  return Math.round(base * zoneMultiplier(zone) * gapPenalty);
}

/* -------------------------------------------------------------------------- */
/*  Timing                                                                    */
/* -------------------------------------------------------------------------- */

/** Convert a tick index to a timestamp in ms, relative to tick 0. */
export function tickToMs(tick: number): number {
  return tick * (1000 / 20);
}

/** Convert ms to a (fractional) tick index. */
export function msToTick(ms: number): number {
  return ms / (1000 / 20);
}

/** Exponential moving average, used for ping and bandwidth smoothing. */
export function ewma(previous: number, sample: number, alpha: number): number {
  const a = clamp(alpha, 0, 1);
  return previous + a * (sample - previous);
}

/* -------------------------------------------------------------------------- */
/*  Movement integration                                                      */
/* -------------------------------------------------------------------------- */

/** Movement intent, as produced by player input or an NPC brain. */
export interface MovementIntent {
  /** -1..1 steering. */
  readonly turn: number;
  /** -1..1 throttle. */
  readonly throttle: number;
}

/** The part of a ship that movement touches. */
export interface MotionState {
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
  /** Signed forward speed, world units per second. */
  readonly speed: number;
}

/** Stats movement needs; a subset of `ShipClassDefinition`. */
export interface MotionStats {
  readonly speed: number;
  readonly turnRate: number;
}

/**
 * Advance one ship by `dt` seconds under `intent`.
 *
 * Deliberately simple: accelerate towards the throttle target, rotate towards the
 * turn input, then integrate position along the heading. No drift, no inertia
 * side-slip — a naval feel is achieved through turn rate, not through vehicle
 * physics. Pure function: returns a new state.
 */
/**
 * Advance one ship by `dt` seconds, honouring mouse aim exactly as the server does.
 *
 * `stepMotion` alone cannot express aiming: the server rotates the hull toward the
 * client's `aim` (capped by how fast the ship can physically turn), and only then
 * integrates position along that heading. A client that predicts with plain
 * `stepMotion` drops that rotation entirely, so it disagrees with the server on every
 * tick — permanent rubber-banding that no amount of correction smoothing can hide.
 *
 * Both ends call this, so they cannot drift apart.
 */
export function stepShipMotion(
  state: MotionState,
  intent: MovementIntent & { readonly aim?: number | null },
  stats: MotionStats,
  dt: number,
  options: { readonly aimAssistFactor?: number } = {},
): MotionState {
  const aim = intent.aim ?? null;

  if (aim === null) return stepMotion(state, intent, stats, dt);

  /* Aim beats the keyboard for this tick, exactly like the server: the hull swings
     toward the cursor as far as it may, and `turn` is not applied again. */
  const assist = options.aimAssistFactor ?? AIM_ASSIST_FACTOR;
  const heading = rotateTowards(state.rotation, aim, stats.turnRate * assist * dt);

  return stepMotion(
    { ...state, rotation: heading },
    { turn: 0, throttle: intent.throttle },
    stats,
    dt,
  );
}

export function stepMotion(
  state: MotionState,
  intent: MovementIntent,
  stats: MotionStats,
  dt: number,
): MotionState {
  const step = Math.max(0, dt);

  const throttle = clamp(intent.throttle, -1, 1);
  const turn = clamp(intent.turn, -1, 1);

  // Rotation first, so the ship steers where it is about to point.
  const rotation = normalizeAngle(state.rotation + turn * stats.turnRate * step);

  // Speed approaches the throttle target at a fixed acceleration.
  const targetSpeed = throttle * stats.speed;
  const maxDelta = SHIP_ACCELERATION * step;
  const speed =
    Math.abs(targetSpeed - state.speed) <= maxDelta
      ? targetSpeed
      : state.speed + Math.sign(targetSpeed - state.speed) * maxDelta;

  const x = state.x + Math.cos(rotation) * speed * step;
  const y = state.y + Math.sin(rotation) * speed * step;

  return { x, y, rotation, speed };
}
