import {
  SPAWN_ANGLE_STEP,
  SPAWN_CENTER_X,
  SPAWN_CENTER_Y,
  SPAWN_RING_RADIUS,
  type ShipClass,
} from '@warship/shared';

import { SpatialGrid } from './Grid.js';
import { Player } from './Player.js';

/**
 * One shard's authoritative state.
 *
 * Everything the simulation owns lives here: players, the spatial index, the tick
 * counter and the spawn cursor. There is exactly one `World` per shard process in
 * the MVP; multi-shard would mean one `World` per shard, which is why nothing in
 * this class reaches outside itself.
 *
 * Ownership rules:
 *  - `World` never touches the network. `Loop` asks it for snapshots and sends them.
 *  - `World` never reads the clock. `Loop` passes the tick in, so tests can drive it
 *    deterministically.
 */
export class World {
  readonly shardId: string;
  readonly players = new Map<string, Player>();
  readonly grid = new SpatialGrid();

  #tick = 0;
  #spawnCursor = 0;

  constructor(options: { readonly shardId: string }) {
    this.shardId = options.shardId;
  }

  get tick(): number {
    return this.#tick;
  }

  /** Number of live players. */
  get playerCount(): number {
    return this.players.size;
  }

  /** Advance the world's tick counter. Called by `Loop` once per tick. */
  advanceTick(): number {
    this.#tick += 1;
    return this.#tick;
  }

  /* ------------------------------------------------------------------------ */
  /*  Players                                                                 */
  /* ------------------------------------------------------------------------ */

  /**
   * Spawn a player on a ring inside the safe zone.
   *
   * Spawns walk around the ring one step at a time so two players joining back to
   * back never appear on top of each other.
   */
  addPlayer(options: { readonly id: string; readonly shipClass?: ShipClass }): Player {
    const angle = this.#spawnCursor * SPAWN_ANGLE_STEP;
    this.#spawnCursor += 1;

    const player = new Player({
      id: options.id,
      shipClass: options.shipClass,
      x: SPAWN_CENTER_X + Math.cos(angle) * SPAWN_RING_RADIUS,
      y: SPAWN_CENTER_Y + Math.sin(angle) * SPAWN_RING_RADIUS,
      rotation: angle,
      tick: this.#tick,
    });

    this.players.set(player.id, player);
    this.grid.upsert(player);
    return player;
  }

  getPlayer(id: string): Player | undefined {
    return this.players.get(id);
  }

  removePlayer(id: string): boolean {
    const player = this.players.get(id);
    if (player === undefined) return false;

    this.grid.remove(player);
    this.players.delete(id);
    return true;
  }

  /** Every player, for iteration in the hot loop. */
  allPlayers(): Iterable<Player> {
    return this.players.values();
  }

  /* ------------------------------------------------------------------------ */
  /*  Snapshot                                                                */
  /* ------------------------------------------------------------------------ */

  /**
   * Build the entity list for one snapshot.
   *
   * MVP sends everything to everyone: correctness first, bandwidth later. When AoI
   * lands this is where the per-client filter goes — the shape of the call already
   * allows it (`playerId` is passed in even though it is unused today).
   */
  snapshotEntities(): Player[] {
    const entities: Player[] = [];
    for (const player of this.players.values()) {
      if (!player.isAlive) continue;
      entities.push(player);
    }
    return entities;
  }

  /** Rebuild the spatial index. Cheap at MVP population sizes. */
  refreshGrid(): void {
    this.grid.rebuild(this.players.values());
  }
}
