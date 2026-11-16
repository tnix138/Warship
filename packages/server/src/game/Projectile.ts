import {
  PROJECTILE_LIFETIME_S,
  PROJECTILE_MAX_ALIVE,
  PROJECTILE_MIN_SPEED,
  PROJECTILE_MUZZLE_OFFSET,
  PROJECTILE_SPEED_FACTOR,
  TICK_DURATION_S,
  wrapWorldPosition,
  type SnapshotEntity,
} from '@warship/shared';

/** Who fired a projectile. Used to stop a shot hitting its own shooter. */
export type ProjectileOwner = string;

/**
 * One shot in flight.
 *
 * Plain data rather than a class: there are up to 500 of these and they are created and
 * recycled every second, so the thing that matters is that constructing one is free. A
 * projectile never allocates after the pool warms up — `ProjectilePool.acquire` reuses a
 * dead slot — because the alternative is a GC pause inside the tick that the player
 * feels as a stutter on their *own* ship.
 */
export interface Projectile {
  /** Slot index, stable for the lifetime of the pool. */
  readonly slot: number;
  /** Wire id. Reused when the slot is recycled, which is why `active` exists. */
  id: string;
  active: boolean;
  ownerId: ProjectileOwner;
  /** True when the shooter was an NPC, so hits do not damage other NPCs. */
  ownerIsNpc: boolean;
  x: number;
  y: number;
  /** Position at the start of the current tick, for swept collision. */
  previousX: number;
  previousY: number;
  /** Velocity in world units per second. */
  vx: number;
  vy: number;
  damage: number;
  /** Seconds remaining before the shot expires. */
  lifeS: number;
}

/**
 * Fixed-capacity projectile pool.
 *
 * ## Why a pool and not a list
 *
 * At 500 shots and a 2 s lifetime, a busy fight creates and discards a few thousand
 * objects per minute. Letting the JS engine handle that is fine in isolation and
 * *not* fine here, because the allocation lands inside the 50 ms tick that also
 * produces everyone's snapshot — a collection pause shows up as a stutter on a player's
 * own predicted ship, which is exactly the symptom that took several iterations to
 * eliminate. Slot reuse removes the allocation entirely.
 *
 * ## Why a cap
 *
 * A cap is the difference between "more players means slower" and "more players means
 * the newest shot is dropped". Dropping is the honest failure: it degrades a shot the
 * player barely noticed instead of everyone's frame time.
 */
export class ProjectilePool {
  readonly #slots: Projectile[];
  #cursor = 0;
  #dropped = 0;

  constructor(capacity: number = PROJECTILE_MAX_ALIVE) {
    this.#slots = [];
    for (let index = 0; index < capacity; index += 1) {
      this.#slots.push({
        slot: index,
        id: `p${String(index)}`,
        active: false,
        ownerId: '',
        ownerIsNpc: false,
        x: 0,
        y: 0,
        previousX: 0,
        previousY: 0,
        vx: 0,
        vy: 0,
        damage: 0,
        lifeS: 0,
      });
    }
  }

  get capacity(): number {
    return this.#slots.length;
  }

  get liveCount(): number {
    let count = 0;
    for (const slot of this.#slots) if (slot.active) count += 1;
    return count;
  }

  /** Shots refused because every slot was busy. Surfaced in the debug panel. */
  get droppedCount(): number {
    return this.#dropped;
  }

  /**
   * Fire a shot from `origin` along `angle`.
   *
   * Returns the projectile, or `null` when the pool is full. The caller must not hold
   * the reference across ticks — the slot may be recycled.
   */
  spawn(options: {
    readonly ownerId: ProjectileOwner;
    readonly ownerIsNpc: boolean;
    readonly x: number;
    readonly y: number;
    readonly angle: number;
    readonly damage: number;
    /** Firing ship's top speed, used to scale the shot's velocity. */
    readonly shipMaxSpeed: number;
  }): Projectile | null {
    const projectile = this.#acquire();
    if (projectile === null) {
      this.#dropped += 1;
      return null;
    }

    const speed = Math.max(PROJECTILE_MIN_SPEED, options.shipMaxSpeed * PROJECTILE_SPEED_FACTOR);
    const cos = Math.cos(options.angle);
    const sin = Math.sin(options.angle);

    // Start clear of the hull, in the firing direction.
    const muzzle = wrapWorldPosition({
      x: options.x + cos * PROJECTILE_MUZZLE_OFFSET,
      y: options.y + sin * PROJECTILE_MUZZLE_OFFSET,
    });

    projectile.active = true;
    projectile.ownerId = options.ownerId;
    projectile.ownerIsNpc = options.ownerIsNpc;
    projectile.x = muzzle.x;
    projectile.y = muzzle.y;
    projectile.previousX = muzzle.x;
    projectile.previousY = muzzle.y;
    projectile.vx = cos * speed;
    projectile.vy = sin * speed;
    projectile.damage = options.damage;
    projectile.lifeS = PROJECTILE_LIFETIME_S;
    return projectile;
  }

  /**
   * Advance every live shot by one tick.
   *
   * Expiry happens here rather than at collision time so a shot that flies into empty
   * water is still recycled on schedule.
   */
  advance(): void {
    for (const projectile of this.#slots) {
      if (!projectile.active) continue;

      projectile.lifeS -= TICK_DURATION_S;
      if (projectile.lifeS <= 0) {
        projectile.active = false;
        continue;
      }

      /* Record where it was before moving: the collision pass sweeps this segment so a
         fast shot cannot tunnel through a hull between ticks. */
      projectile.previousX = projectile.x;
      projectile.previousY = projectile.y;

      const moved = wrapWorldPosition({
        x: projectile.x + projectile.vx * TICK_DURATION_S,
        y: projectile.y + projectile.vy * TICK_DURATION_S,
      });
      projectile.x = moved.x;
      projectile.y = moved.y;
    }
  }

  /** Recycle one shot (after a hit). */
  release(projectile: Projectile): void {
    projectile.active = false;
  }

  /** Every live shot, for collision and for the snapshot. */
  *live(): IterableIterator<Projectile> {
    for (const projectile of this.#slots) {
      if (projectile.active) yield projectile;
    }
  }

  /** Wire record for the snapshot. */
  toSnapshotEntity(projectile: Projectile): SnapshotEntity {
    return {
      id: projectile.id,
      x: projectile.x,
      y: projectile.y,
      rotation: Math.atan2(projectile.vy, projectile.vx),
      hp: 1,
    };
  }

  /** Drop every shot. Used when resetting a world (tests, shard restart). */
  clear(): void {
    for (const projectile of this.#slots) projectile.active = false;
  }

  /**
   * Next free slot, round-robin.
   *
   * Round-robin rather than first-fit: first-fit makes the first slots hot and the tail
   * cold, which is harmless but means a burst of shots always reuses the same few ids,
   * making traces harder to read.
   */
  #acquire(): Projectile | null {
    for (let step = 0; step < this.#slots.length; step += 1) {
      const index = (this.#cursor + step) % this.#slots.length;
      const candidate = this.#slots[index];
      if (candidate !== undefined && !candidate.active) {
        this.#cursor = (index + 1) % this.#slots.length;
        return candidate;
      }
    }
    return null;
  }
}
