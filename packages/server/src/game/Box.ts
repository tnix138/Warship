import {
  BOX_DROP_TABLE,
  BOX_LIFETIME_S,
  BOX_MAX_ALIVE,
  BoxKind,
  TICK_DURATION_S,
  wrapWorldPosition,
  type BoxDropTable,
  type NpcTier,
  type SnapshotEntity,
} from '@warship/shared';

/**
 * One loot box on the water.
 *
 * Same shape as a projectile and for the same reason: boxes are created in bursts on a
 * kill and recycled on a timer, so the pool exists to keep those allocations out of the
 * tick. See `Projectile.ts` for the longer argument.
 */
export interface Box {
  readonly slot: number;
  id: string;
  active: boolean;
  x: number;
  y: number;
  kind: BoxKind;
  /** Scrap value for a `scrap` box; XP for a `part` box; 0 for `repair`. */
  value: number;
  /** Seconds remaining before the box despawns. */
  lifeS: number;
  /** Id of the NPC whose death produced this box, for the kill feed. */
  sourceId: string;
}

/** What one rolled box contains. */
export interface BoxRoll {
  readonly kind: BoxKind;
  readonly value: number;
}

/**
 * Fixed-capacity box pool.
 *
 * ## The drop rule
 *
 * `BOX_DROP_TABLE` is the authority on *how many* boxes a tier drops and on the range of
 * each payload, and this class only turns a roll into a box. Keeping the table in
 * `@warship/shared` means the client can show "a Warship drops 3" in the HUD without a
 * second copy of the numbers drifting from the server's.
 *
 * ## Why `roll` takes a random function
 *
 * Every call site passes `Math.random` in production, and a seeded generator in tests.
 * That is the whole reason drop probability is testable at all: asserting on a random
 * distribution requires being able to fix it.
 */
export class BoxPool {
  readonly #slots: Box[];
  #cursor = 0;

  constructor(capacity: number = BOX_MAX_ALIVE) {
    this.#slots = [];
    for (let index = 0; index < capacity; index += 1) {
      this.#slots.push({
        slot: index,
        id: `b${String(index)}`,
        active: false,
        x: 0,
        y: 0,
        kind: BoxKind.Scrap,
        value: 0,
        lifeS: 0,
        sourceId: '',
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

  /**
   * Roll what a killed NPC of `tier` drops.
   *
   * Returns one entry per box: the table's `boxCount` decides how many, and each box
   * independently rolls for a part. The XP and scrap *ranges* are used by the caller
   * (which owns the player's economy); this only decides the payload shape.
   */
  static rollDrops(tier: NpcTier, random: () => number = Math.random): readonly BoxRoll[] {
    const table: BoxDropTable = BOX_DROP_TABLE[tier];
    const drops: BoxRoll[] = [];

    for (let index = 0; index < table.boxCount; index += 1) {
      if (random() < table.partChance) {
        drops.push({ kind: BoxKind.Part, value: 1 });
        continue;
      }

      /* Scrap is the common case. A repair box appears with the remainder of the
         probability mass so a long fight eventually heals you — which is what makes
         sustained combat in the open survivable at all. */
      const repairShare = 0.18;
      if (random() < repairShare) {
        drops.push({ kind: BoxKind.Repair, value: 1 });
        continue;
      }

      drops.push({ kind: BoxKind.Scrap, value: rollInt(table.scrap.min, table.scrap.max, random) });
    }

    return drops;
  }

  /**
   * Place a box in the world.
   *
   * Returns `null` when the pool is full: like a dropped projectile, a dropped box is a
   * far better failure than an unbounded pool.
   */
  spawn(options: {
    readonly x: number;
    readonly y: number;
    readonly kind: BoxKind;
    readonly value: number;
    readonly sourceId: string;
    readonly angle: number;
    readonly distance: number;
  }): Box | null {
    const slot = this.#acquire();
    if (slot === null) return null;

    const placed = wrapWorldPosition({
      x: options.x + Math.cos(options.angle) * options.distance,
      y: options.y + Math.sin(options.angle) * options.distance,
    });

    slot.active = true;
    slot.x = placed.x;
    slot.y = placed.y;
    slot.kind = options.kind;
    slot.value = options.value;
    slot.lifeS = BOX_LIFETIME_S;
    slot.sourceId = options.sourceId;
    return slot;
  }

  /** Tick every live box's lifetime down; expire the ones that run out. */
  advance(): void {
    for (const box of this.#slots) {
      if (!box.active) continue;
      box.lifeS -= TICK_DURATION_S;
      if (box.lifeS <= 0) box.active = false;
    }
  }

  release(box: Box): void {
    box.active = false;
  }

  *live(): IterableIterator<Box> {
    for (const box of this.#slots) {
      if (box.active) yield box;
    }
  }

  toSnapshotEntity(box: Box): SnapshotEntity {
    return {
      id: box.id,
      x: box.x,
      y: box.y,
      rotation: 0,
      hp: 1,
    };
  }

  clear(): void {
    for (const box of this.#slots) box.active = false;
  }

  #acquire(): Box | null {
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

/** Inclusive integer roll in `[min, max]`. */
export function rollInt(min: number, max: number, random: () => number = Math.random): number {
  const low = Math.ceil(min);
  const high = Math.floor(max);
  if (high <= low) return low;
  return low + Math.floor(random() * (high - low + 1));
}
