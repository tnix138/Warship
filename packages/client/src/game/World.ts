import type { ShipClass, SnapshotEntity, SnapshotMessage } from '@warship/shared';

/**
 * Client-side mirror of the server world.
 *
 * Holds only what the renderer needs, keyed by entity id. It is a *view cache*, not
 * a simulation: nothing here is interpolated, predicted or corrected yet — each
 * snapshot simply replaces the known state (MVP: "direct on the latest snapshot").
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
  /** True while the entity was present in the most recent snapshot. */
  alive: boolean;
}

export class ClientWorld {
  readonly entities = new Map<string, ClientEntity>();

  /** Id of the local player, once known. */
  selfId: string | null = null;

  /** Tick of the most recent snapshot applied. */
  tick = 0;

  /** Replace the world with a snapshot; entities missing from it are dropped. */
  applySnapshot(snapshot: SnapshotMessage): void {
    this.tick = snapshot.tick;

    const seen = new Set<string>();
    for (const entity of snapshot.entities) {
      seen.add(entity.id);
      this.#upsert(entity, snapshot.tick);
    }

    for (const id of this.entities.keys()) {
      if (!seen.has(id)) this.entities.delete(id);
    }
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

  #upsert(entity: SnapshotEntity, tick: number): void {
    const existing = this.entities.get(entity.id);
    if (existing === undefined) {
      this.entities.set(entity.id, {
        id: entity.id,
        x: entity.x,
        y: entity.y,
        rotation: entity.rotation,
        hp: entity.hp,
        shipClass: entity.shipClass,
        tick,
        alive: true,
      });
      return;
    }

    existing.x = entity.x;
    existing.y = entity.y;
    existing.rotation = entity.rotation;
    existing.hp = entity.hp;
    existing.shipClass = entity.shipClass;
    existing.tick = tick;
    existing.alive = true;
  }
}
