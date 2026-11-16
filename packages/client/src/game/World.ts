import type {
  BoxKind,
  EntityKind,
  NpcTier,
  ShipClass,
  SnapshotEntity,
  SnapshotMessage,
} from '@warship/shared';

import { Interpolation } from '../net/Interpolation';

/**
 * Client-side mirror of the server world.
 *
 * This is a **view cache**, not a simulation. It does no physics and decides nothing;
 * it turns the snapshot stream into the poses the renderer should draw right now.
 *
 * Three layers cooperate here, and the order matters:
 *
 * ```
 *   SNAPSHOT ──▶ authoritative state (this class, `entities`)
 *                     │
 *                     ├──▶ Interpolation ──▶ smooth poses for *other* ships
 *                     └──▶ Prediction    ──▶ immediate pose for *your* ship
 * ```
 *
 * Everything except the local player is drawn from the interpolation buffer, which
 * runs `INTERPOLATION_DELAY_MS` behind the newest data. The local player is drawn
 * from the prediction, which is ahead of the newest data. That asymmetry is the whole
 * point: your input is never late, everyone else is never jittery.
 */

export interface ClientEntity {
  id: string;
  x: number;
  y: number;
  rotation: number;
  hp: number;
  shipClass: ShipClass;
  /**
   * What this id is.
   *
   * Remembered from the first frame that described it, because a delta only re-states
   * what changed and `kind` is not a field that changes. Every later frame can omit it.
   */
  kind: EntityKind;
  /** NPC tier, for colour and scale. */
  npcTier?: NpcTier;
  /** Box payload, for colour. */
  boxKind?: BoxKind;
  /** Shield seconds remaining; non-zero means the hull cannot be hurt. */
  shield: number;
  /** Server tick this state came from. */
  tick: number;
  /** Newest input sequence the server has applied for this entity (self only). */
  ackSeq?: number;
}

/** What the renderer needs to draw one entity this frame. */
export interface RenderEntity {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
  readonly hp: number;
  readonly shipClass: ShipClass;
  /** 0..1, used for the removal fade. `1` for anything alive. */
  readonly alpha: number;
  /** True for the local player, whose pose comes from prediction instead. */
  readonly isSelf: boolean;
  /** What is being drawn: a ship, a shot or a crate. */
  readonly kind: EntityKind;
  /** NPC tier, when `kind` is an NPC. */
  readonly npcTier?: NpcTier;
  /** Box payload, when `kind` is a box. */
  readonly boxKind?: BoxKind;
  /** Shield seconds left, for the invulnerability halo. */
  readonly shield: number;
}

export class ClientWorld {
  /** Authoritative state, exactly as the server last described it. */
  readonly entities = new Map<string, ClientEntity>();

  /** Buffer of recent snapshots, used to interpolate other ships. */
  readonly interpolation = new Interpolation();

  /** Id of the local player, once known. */
  selfId: string | null = null;

  /** Tick of the most recent snapshot applied. */
  tick = 0;

  /** Number of snapshots applied since connect — surfaced in the debug HUD. */
  snapshotsApplied = 0;

  /** Number of `delta` snapshots applied (vs `full` ones). */
  deltasApplied = 0;

  /**
   * Merge a snapshot into the authoritative state.
   *
   * `full` resets the entity set; `delta` updates only what it mentions and applies
   * `removed`. Getting this wrong is the classic delta-compression bug: treating a
   * delta as a full frame makes every stationary ship blink out of existence.
   */
  applySnapshot(snapshot: SnapshotMessage, now: number = performance.now()): void {
    this.tick = snapshot.tick;
    this.snapshotsApplied += 1;
    if (!snapshot.full) this.deltasApplied += 1;

    if (snapshot.full) {
      const present = new Set(snapshot.entities.map((entity) => entity.id));
      for (const id of this.entities.keys()) {
        if (!present.has(id)) this.entities.delete(id);
      }
    }

    for (const entity of snapshot.entities) {
      this.#upsert(entity, snapshot.tick);
    }

    for (const gone of snapshot.removed ?? []) {
      this.entities.delete(gone.id);
    }

    /* Feed the interpolation buffer with the resolved state, so a delta that omits
       `shipClass` still produces a complete frame. */
    this.interpolation.push(
      {
        tick: snapshot.tick,
        serverTime: snapshot.serverTime,
        /* Only ships go into the pose buffer. Shots are short-lived and a crate does
           not move, so interpolating either would add latency for nothing; both are
           drawn straight from authoritative state. */
        entities: [...this.entities.values()]
          .filter((entity) => entity.kind === 'player' || entity.kind === 'npc')
          .map((entity) => ({
            id: entity.id,
            x: entity.x,
            y: entity.y,
            rotation: entity.rotation,
            hp: entity.hp,
            shipClass: entity.shipClass,
          })),
      },
      {
        full: snapshot.full,
        removed: (snapshot.removed ?? []).map((gone) => gone.id),
        now,
      },
    );
  }

  get(id: string): ClientEntity | undefined {
    return this.entities.get(id);
  }

  get self(): ClientEntity | undefined {
    return this.selfId === null ? undefined : this.entities.get(this.selfId);
  }

  /** Number of entities currently mirrored. */
  get size(): number {
    return this.entities.size;
  }

  /**
   * What the renderer should draw, straight from the newest snapshot.
   *
   * This is the MVP path: no interpolation buffer, no prediction, no easing. Every
   * entity is drawn at the pose the server last sent, so remote ships step at 20 Hz and
   * the local ship is one tick behind its input. Both are visible; both are acceptable
   * while the goal is "you can play it", and `MVP_FLAGS` is where that judgement lives.
   *
   * Kept as a separate method rather than a branch inside `renderEntities` so the
   * simplicity is obvious to a reader of the call site.
   */
  renderEntitiesNow(): RenderEntity[] {
    const out: RenderEntity[] = [];

    for (const entity of this.entities.values()) {
      const isSelf = entity.id === this.selfId;

      out.push({
        id: entity.id,
        x: entity.x,
        y: entity.y,
        rotation: entity.rotation,
        hp: entity.hp,
        shipClass: entity.shipClass,
        alpha: 1,
        isSelf,
        kind: entity.kind,
        ...(entity.npcTier === undefined ? {} : { npcTier: entity.npcTier }),
        ...(entity.boxKind === undefined ? {} : { boxKind: entity.boxKind }),
        shield: entity.shield,
      });
    }

    return out;
  }

  /**
   * What the renderer should draw at `now`.
   *
   * Interpolated poses for everyone, with the local player's pose overridden by the
   * caller-supplied prediction (if there is one).
   */
  renderEntities(
    now: number,
    predictedSelf?: { x: number; y: number; rotation: number },
  ): RenderEntity[] {
    const out: RenderEntity[] = [];

    for (const pose of this.interpolation.sample(now)) {
      const authoritative = this.entities.get(pose.id);
      const isSelf = pose.id === this.selfId;

      const alpha = this.interpolation.fadeAlpha(pose.id, now);

      if (isSelf && predictedSelf !== undefined) {
        out.push({
          id: pose.id,
          x: predictedSelf.x,
          y: predictedSelf.y,
          rotation: predictedSelf.rotation,
          hp: authoritative?.hp ?? pose.hp,
          shipClass: authoritative?.shipClass ?? (pose.shipClass as ShipClass),
          alpha: 1,
          isSelf: true,
          kind: 'player',
          shield: authoritative?.shield ?? 0,
        });
        continue;
      }

      const kind = authoritative?.kind ?? 'player';
      out.push({
        id: pose.id,
        x: pose.x,
        y: pose.y,
        rotation: pose.rotation,
        hp: pose.hp,
        shipClass: authoritative?.shipClass ?? (pose.shipClass as ShipClass),
        alpha: alpha ?? 1,
        isSelf,
        kind,
        ...(authoritative?.npcTier === undefined ? {} : { npcTier: authoritative.npcTier }),
        shield: authoritative?.shield ?? 0,
      });
    }

    /* Shots and crates are drawn from authoritative state, not the pose buffer. They are
       short-lived and jitter-free by nature, and interpolating them would lag the impact
       behind the flash it causes. */
    for (const entity of this.entities.values()) {
      if (entity.kind !== 'projectile' && entity.kind !== 'box') continue;

      out.push({
        id: entity.id,
        x: entity.x,
        y: entity.y,
        rotation: entity.rotation,
        hp: entity.hp,
        shipClass: entity.shipClass,
        alpha: 1,
        isSelf: false,
        kind: entity.kind,
        ...(entity.boxKind === undefined ? {} : { boxKind: entity.boxKind }),
        shield: 0,
      });
    }

    /* The local ship must be drawable even before two snapshots exist to
       interpolate between: prediction already knows where it is. */
    if (
      predictedSelf !== undefined &&
      this.selfId !== null &&
      !out.some((entity) => entity.id === this.selfId)
    ) {
      const authoritative = this.entities.get(this.selfId);
      if (authoritative !== undefined) {
        out.push({
          id: this.selfId,
          x: predictedSelf.x,
          y: predictedSelf.y,
          rotation: predictedSelf.rotation,
          hp: authoritative.hp,
          shipClass: authoritative.shipClass,
          alpha: 1,
          isSelf: true,
          kind: 'player',
          shield: authoritative.shield,
        });
      }
    }

    return out;
  }

  /** Drop everything (reconnect). */
  reset(): void {
    this.entities.clear();
    this.interpolation.clear();
    this.selfId = null;
    this.tick = 0;
  }

  #upsert(entity: SnapshotEntity, tick: number): void {
    const existing = this.entities.get(entity.id);

    if (existing === undefined) {
      if (entity.shipClass === undefined) return; // can never happen on a full frame
      this.entities.set(entity.id, {
        id: entity.id,
        x: entity.x,
        y: entity.y,
        rotation: entity.rotation,
        hp: entity.hp,
        shipClass: entity.shipClass,
        kind: entity.kind ?? 'player',
        shield: entity.shield ?? 0,
        tick,
        ...(entity.npcTier === undefined ? {} : { npcTier: entity.npcTier }),
        ...(entity.boxKind === undefined ? {} : { boxKind: entity.boxKind }),
        ...(entity.ackSeq === undefined ? {} : { ackSeq: entity.ackSeq }),
      });
      return;
    }

    existing.x = entity.x;
    existing.y = entity.y;
    existing.rotation = entity.rotation;
    existing.hp = entity.hp;
    existing.tick = tick;
    if (entity.shipClass !== undefined) existing.shipClass = entity.shipClass;
    /* `kind` is not sticky the way position is: it is only ever sent on a full frame or
       a first appearance, so a later frame omitting it must not erase what we know. */
    if (entity.kind !== undefined) existing.kind = entity.kind;
    if (entity.npcTier !== undefined) existing.npcTier = entity.npcTier;
    if (entity.boxKind !== undefined) existing.boxKind = entity.boxKind;
    /* The shield, by contrast, *must* be able to fall back to zero, so it is always
       re-stated and always assigned. */
    existing.shield = entity.shield ?? 0;
    if (entity.ackSeq !== undefined) existing.ackSeq = entity.ackSeq;
  }
}
