import {
  DEFAULT_SHIP_CLASS,
  STARTING_LEVEL,
  STARTING_SCRAP,
  STARTING_XP,
  computeShipStats,
  zoneAt,
  type ShipStats,
  type InputFrame,
  type ShipClass,
  type SnapshotEntity,
  type UpgradeId,
  type ZoneId,
} from '@warship/shared';

/**
 * One player-controlled ship.
 *
 * Authoritative state. The client never writes to any of this: it sends intents
 * (`InputFrame`) and the loop in `Loop.ts` is the only thing that advances it.
 *
 * The class exposes small, explicit mutators instead of public fields so that every
 * change is greppable and a future "record & replay" or "state hash" pass has a
 * single choke point.
 */
export class Player {
  readonly id: string;

  /* --- identity --- */
  shipClass: ShipClass;
  displayName: string;

  /* --- kinematics (authoritative) --- */
  x: number;
  y: number;
  /** Hull facing in radians; 0 points along +x. */
  rotation: number;
  /** Signed forward speed, world units/s. */
  speed: number;

  /* --- combat --- */
  hp: number;
  maxHp: number;
  /** Tick the last legal shot was fired on; used for reload gating. */
  lastFiredTick: number;

  /* --- progression --- */
  level: number;
  xp: number;
  scrap: number;
  readonly upgrades = new Map<UpgradeId, number>();

  /* --- session / input --- */
  /** Tick the player joined on, for stats and for spawn protection later. */
  readonly joinedAtTick: number;
  /** Latest accepted input intent. `null` until the first INPUT arrives. */
  intent: InputFrame | null = null;
  /** Sequence number of the last accepted input; older frames are dropped. */
  lastInputSeq = 0;
  /** Monotonic time the last input arrived, for staleness detection. */
  lastInputAt = 0;

  constructor(options: {
    readonly id: string;
    readonly shipClass?: ShipClass;
    readonly displayName?: string;
    readonly x: number;
    readonly y: number;
    readonly rotation?: number;
    readonly tick: number;
  }) {
    this.id = options.id;
    this.shipClass = options.shipClass ?? DEFAULT_SHIP_CLASS;
    this.displayName = options.displayName ?? options.id.slice(0, 8);

    const stats = computeShipStats(this.shipClass);
    this.maxHp = stats.maxHp;
    this.hp = stats.maxHp;

    this.x = options.x;
    this.y = options.y;
    this.rotation = options.rotation ?? 0;
    this.speed = 0;

    this.lastFiredTick = 0;
    this.level = STARTING_LEVEL;
    this.xp = STARTING_XP;
    this.scrap = STARTING_SCRAP;
    this.joinedAtTick = options.tick;
  }

  /** Effective stats, recomputed from class + purchased upgrades. */
  get stats(): ShipStats {
    return computeShipStats(this.shipClass, this.upgrades);
  }

  /** Zone is derived from position, never stored — it cannot go stale. */
  get zone(): ZoneId {
    return zoneAt({ x: this.x, y: this.y });
  }

  /** Whether the player is alive. MVP has no respawn flow yet. */
  get isAlive(): boolean {
    return this.hp > 0;
  }

  /** Accept an input intent. Returns false when it is stale or out of order. */
  acceptInput(seq: number, intent: InputFrame, now: number): boolean {
    if (!Number.isFinite(seq) || seq <= this.lastInputSeq) return false;
    this.lastInputSeq = seq;
    this.intent = intent;
    this.lastInputAt = now;
    return true;
  }

  /** Forget the current intent, so a disconnected-in-spirit player coasts to a stop. */
  clearInput(): void {
    this.intent = null;
  }

  /** Apply damage. Never below 0; returns the damage actually dealt. */
  applyDamage(amount: number): number {
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    const dealt = Math.min(this.hp, amount);
    this.hp -= dealt;
    return dealt;
  }

  /** Restore hull points, clamped to `maxHp`. */
  heal(amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    this.hp = Math.min(this.maxHp, this.hp + amount);
  }

  /** Flat projection used by snapshots. */
  toSnapshotEntity(): SnapshotEntity {
    return {
      id: this.id,
      x: this.x,
      y: this.y,
      rotation: this.rotation,
      hp: this.hp,
      shipClass: this.shipClass,
    };
  }
}
