import type { ShipClass, SnapshotEntity, SnapshotMessage } from '@warship/shared';

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
        entities: [...this.entities.values()].map((entity) => ({
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
        });
        continue;
      }

      out.push({
        id: pose.id,
        x: pose.x,
        y: pose.y,
        rotation: pose.rotation,
        hp: pose.hp,
        shipClass: authoritative?.shipClass ?? (pose.shipClass as ShipClass),
        alpha: alpha ?? 1,
        isSelf,
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
        tick,
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
    if (entity.ackSeq !== undefined) existing.ackSeq = entity.ackSeq;
  }
}
