import {
  NPC_CHASE_GIVE_UP,
  NPC_PATROL_RADIUS,
  NPC_RESPAWN_MAX_S,
  NPC_RESPAWN_MIN_S,
  NPC_STATS,
  NpcState,
  TICK_DURATION_S,
  angleDelta,
  normalizeAngle,
  stepShipMotion,
  wrapWorldPosition,
  wrappedDelta,
  type NpcStats,
  type NpcTier,
  type SnapshotEntity,
} from '@warship/shared';

/** A point on the water, in world coordinates. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * One AI ship.
 *
 * ## What this is, and what it deliberately is not
 *
 * Four states, no memory, no pathfinding: patrol the home patch, notice a player inside
 * the detection radius, close to weapon range, shoot. If the target escapes or dies, go
 * home. That is the whole brain, and keeping it that small is a decision rather than an
 * omission — every addition here (flanking, cover, retreat) needs navigation the world
 * does not have and costs tick time that the player's own prediction is sensitive to.
 *
 * ## Authority
 *
 * Nothing in this class touches the network or reads the clock. `Loop` passes the tick
 * and the list of candidate targets in, and reads the intent out. That keeps the AI
 * drivable from a test at an exact tick, which is the only way to assert on behaviour
 * that depends on elapsed time.
 *
 * ## Motion
 *
 * Movement goes through `stepShipMotion`, the same function the player and the client
 * prediction use. An NPC that moved by its own integrator would drift out of agreement
 * with every client's idea of where it is, and the client would see it stutter — the
 * exact bug that cost several iterations on the player's own ship.
 */
export class Npc {
  readonly id: string;
  readonly tier: NpcTier;
  readonly stats: NpcStats;

  /* --- kinematics --- */
  x: number;
  y: number;
  rotation: number;
  speed = 0;

  /* --- combat --- */
  hp: number;
  /**
   * Tick of the last legal shot, for reload gating.
   *
   * `null` means "never fired". A numeric zero would read as "fired on tick 0", which
   * gates every NPC's first shot behind a full reload it never spent.
   */
  lastFiredTick: number | null = null;
  /** Id of the player currently being chased, or `null`. */
  targetId: string | null = null;

  /* --- behaviour --- */
  state: NpcState = NpcState.Patrol;
  /** Where this NPC was spawned; it patrols around here and returns to it. */
  readonly home: Point;
  /** Current patrol waypoint. */
  patrolTarget: Point;
  /** Tick this NPC died on, or `null` while alive. */
  diedAtTick: number | null = null;

  constructor(options: {
    readonly id: string;
    readonly tier: NpcTier;
    readonly x: number;
    readonly y: number;
    readonly rotation?: number;
  }) {
    this.id = options.id;
    this.tier = options.tier;
    this.stats = NPC_STATS[options.tier];

    this.x = options.x;
    this.y = options.y;
    this.rotation = options.rotation ?? 0;
    this.hp = this.stats.maxHp;
    this.home = { x: options.x, y: options.y };
    this.patrolTarget = { x: options.x, y: options.y };
  }

  get isAlive(): boolean {
    return this.hp > 0 && this.state !== NpcState.Dead;
  }

  get radius(): number {
    return this.stats.radius;
  }

  /** Seconds of respawn delay this hull uses; fixed per NPC so a seed is not needed. */
  get respawnDelayS(): number {
    /* Derived from the id rather than `Math.random()` so a replay of the same
       simulation produces the same world. A random 30–60 s spread is enough to stop
       every kill in a fight refilling simultaneously. */
    const span = NPC_RESPAWN_MAX_S - NPC_RESPAWN_MIN_S;
    return NPC_RESPAWN_MIN_S + hash01(this.id) * span;
  }

  /**
   * Advance one tick.
   *
   * `targets` is whatever the loop considers a valid player. Returns the intent the AI
   * wants, which the caller feeds to the projectile spawner — the AI never creates
   * projectiles itself and no longer even knows whether it is allowed to fire, so there
   * is exactly one place that enforces the cap and the reload rule for either faction.
   */
  step(
    targets: readonly { readonly id: string; readonly x: number; readonly y: number }[],
  ): NpcIntent {
    if (!this.isAlive) {
      return { turn: 0, throttle: 0, aim: null, wantsToFire: false };
    }

    const nearest = this.#nearestTarget(targets);
    const distance = nearest === null ? Infinity : Math.hypot(nearest.dx, nearest.dy);

    this.#updateState(nearest, distance);

    const intent = this.#intentFor(nearest, distance);
    this.#applyMotion(intent);
    return intent;
  }

  /** Take damage. Returns the amount actually dealt. */
  applyDamage(amount: number): number {
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    const dealt = Math.min(this.hp, amount);
    this.hp -= dealt;
    return dealt;
  }

  /** Mark dead. The loop is responsible for scheduling the respawn. */
  kill(tick: number): void {
    this.hp = 0;
    this.state = NpcState.Dead;
    this.diedAtTick = tick;
    this.speed = 0;
    this.targetId = null;
  }

  /** Bring a dead NPC back at a fresh position, as a new ship. */
  respawn(options: { readonly at: Point; readonly tick: number }): void {
    this.hp = this.stats.maxHp;
    this.x = options.at.x;
    this.y = options.at.y;
    this.rotation = hash01(`${this.id}:respawn:${String(options.tick)}`) * Math.PI * 2;
    this.speed = 0;
    this.state = NpcState.Patrol;
    this.diedAtTick = null;
    this.targetId = null;
    this.lastFiredTick = null;
    this.patrolTarget = this.#pickPatrolPoint();
  }

  toSnapshotEntity(): SnapshotEntity {
    return {
      id: this.id,
      x: this.x,
      y: this.y,
      rotation: this.rotation,
      hp: this.hp,
    };
  }

  /* ------------------------------------------------------------------------ */
  /*  Internals                                                               */
  /* ------------------------------------------------------------------------ */

  /**
   * The target this NPC should be thinking about, with its wrapped offset.
   *
   * Commitment is resolved *here* rather than in the state machine, because choosing the
   * target and deciding what to do about it are separate questions and conflating them
   * produced two bugs: an NPC re-picked the closest ship every tick (so "commitment" was
   * never actually tested), and the detect-radius filter ran before the committed target
   * could be given its longer leash.
   *
   * The rule, in order:
   *  1. if the current target is still inside the give-up radius, keep it;
   *  2. otherwise take the nearest target inside the detection radius;
   *  3. otherwise nothing.
   */
  #nearestTarget(
    targets: readonly { readonly id: string; readonly x: number; readonly y: number }[],
  ): NearestTarget | null {
    const measured = new Map<string, { dx: number; dy: number; distance: number }>();
    for (const target of targets) {
      /* Wrapped, because the world is a torus: a target 5 units away across the seam is
         near, and a straight-line distance would call it 7 995 away and never chase it. */
      const delta = wrappedDelta(this, target);
      measured.set(target.id, { dx: delta.x, dy: delta.y, distance: Math.hypot(delta.x, delta.y) });
    }

    const current = this.targetId === null ? undefined : measured.get(this.targetId);
    if (current !== undefined && current.distance <= NPC_CHASE_GIVE_UP) {
      return { id: this.targetId ?? '', ...current };
    }

    let best: { id: string; dx: number; dy: number; distance: number } | null = null;
    for (const [id, sample] of measured) {
      if (sample.distance > this.stats.detectRadius) continue;
      if (best === null || sample.distance < best.distance) {
        best = { id, dx: sample.dx, dy: sample.dy, distance: sample.distance };
      }
    }

    return best;
  }

  #updateState(
    nearest: { id: string; dx: number; dy: number; distance: number } | null,
    distance: number,
  ): void {
    if (nearest === null) {
      this.state = NpcState.Patrol;
      this.targetId = null;
      return;
    }

    /* Nothing in range: go home. Target selection has already applied both the detection
       radius (for a fresh target) and the longer give-up radius (for a committed one), so
       reaching here means the NPC really has lost interest. */
    if (distance > NPC_CHASE_GIVE_UP) {
      this.state = NpcState.Patrol;
      this.targetId = null;
      return;
    }

    this.targetId = nearest.id;
    this.state = distance <= this.stats.range ? NpcState.Engage : NpcState.Chase;
  }

  #intentFor(nearest: NearestTarget | null, distance: number): NpcIntent {
    if (this.state === NpcState.Patrol || nearest === null) return this.#patrolIntent();

    const aim = Math.atan2(nearest.dy, nearest.dx);

    if (this.state === NpcState.Chase) {
      // Full ahead, pointing at the target.
      return { turn: 0, throttle: 1, aim, wantsToFire: false };
    }

    /* In range. Close to a comfortable fraction of it, then hold station and shoot:
       charging to point-blank range makes every NPC a rammer and every fight a
       collision. */
    const holdAt = this.stats.range * 0.7;
    const throttle = distance > holdAt ? 0.6 : distance < holdAt * 0.55 ? -0.4 : 0;

    /* A warship that only fires when its nose is perfectly aligned would almost never
       fire, because the player is always turning. Fire once the bow is roughly on
       target and let the projectile's own travel do the rest. */
    const aligned = Math.abs(angleDelta(this.rotation, aim)) < 0.35;

    return { turn: 0, throttle, aim, wantsToFire: aligned };
  }

  #patrolIntent(): NpcIntent {
    const toTarget = wrappedDelta(this, this.patrolTarget);
    const distance = Math.hypot(toTarget.x, toTarget.y);

    if (distance < 60) {
      this.patrolTarget = this.#pickPatrolPoint();
      return { turn: 0, throttle: 0, aim: null, wantsToFire: false };
    }

    const aim = Math.atan2(toTarget.y, toTarget.x);
    return { turn: 0, throttle: 0.45, aim, wantsToFire: false };
  }

  /** A deterministic point within the patrol radius of home. */
  #pickPatrolPoint(): Point {
    const angle = hash01(`${this.id}:${String(Math.round(this.x))}:${String(Math.round(this.y))}`);
    const radius = hash01(`${this.id}:r:${String(Math.round(this.y))}`) * NPC_PATROL_RADIUS;
    const wrapped = wrapWorldPosition({
      x: this.home.x + Math.cos(angle * Math.PI * 2) * radius,
      y: this.home.y + Math.sin(angle * Math.PI * 2) * radius,
    });
    return { x: wrapped.x, y: wrapped.y };
  }

  #applyMotion(intent: NpcIntent): void {
    const next = stepShipMotion(
      { x: this.x, y: this.y, rotation: this.rotation, speed: this.speed },
      intent,
      { speed: this.stats.maxSpeed, turnRate: this.stats.turnRate },
      TICK_DURATION_S,
    );

    const wrapped = wrapWorldPosition({ x: next.x, y: next.y });
    this.x = wrapped.x;
    this.y = wrapped.y;
    this.rotation = normalizeAngle(next.rotation);
    this.speed = next.speed;
  }
}

/**
 * A target as the AI sees it: who, and where relative to this hull.
 *
 * `distance` is carried alongside `dx`/`dy` because every caller needs all three and
 * recomputing a square root at each call site is how two of them end up disagreeing.
 */
interface NearestTarget {
  readonly id: string;
  readonly dx: number;
  readonly dy: number;
  readonly distance: number;
}

/**
 * What an NPC wants to do this tick.
 *
 * Deliberately *not* `InputFrame`. Player input lost its `aim` field when mouse aiming
 * was removed — the hull is keyboard-only and the server points the gun — but an NPC
 * still has to steer toward its target, so it needs an aim angle of its own. Sharing one
 * type between the two would have meant keeping a field on the wire that no longer means
 * anything for players.
 */
export interface NpcIntent {
  readonly turn: number;
  readonly throttle: number;
  /** Heading the hull should swing toward, or `null` to hold course. */
  readonly aim: number | null;
  /**
   * Whether the AI would like to shoot this tick.
   *
   * A *request*, like a player's: the loop still applies `canFire` before spawning
   * anything, so the weapon rules stay in exactly one place per faction and an NPC can
   * never out-shoot its own stat block.
   */
  readonly wantsToFire: boolean;
}

/** Reload time expressed in whole ticks, never less than one. */
export function reloadTicks(reloadTime: number): number {
  return Math.max(1, Math.round(reloadTime / TICK_DURATION_S));
}

/**
 * Stable 0..1 hash of a string.
 *
 * Used for the respawn spread and for patrol points. A cheap FNV-1a is plenty: the only
 * requirement is that it is deterministic across processes and well spread, not that it
 * resists an adversary.
 */
export function hash01(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  // >>> 0 makes it unsigned; / 2^32 maps to [0, 1).
  return (hash >>> 0) / 0x1_0000_0000;
}
