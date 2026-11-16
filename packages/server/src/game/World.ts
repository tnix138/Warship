import {
  NPC_MAX_ALIVE,
  NPC_SPAWN_INTERVAL_TICKS,
  NPC_TARGET_COUNTS,
  NPC_TIER_ZONE,
  NpcTier,
  RESPAWN_RING_RADIUS,
  SPAWN_ANGLE_STEP,
  SPAWN_CENTER_X,
  SPAWN_CENTER_Y,
  SPAWN_RING_RADIUS,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  ZONES,
  type ShipClass,
  type ZoneId,
} from '@warship/shared';

import { BoxPool } from './Box.js';
import { SpatialGrid } from './Grid.js';
import { Npc, hash01 } from './Npc.js';
import { Player } from './Player.js';
import { ProjectilePool } from './Projectile.js';

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
  readonly npcs = new Map<string, Npc>();
  readonly projectiles = new ProjectilePool();
  readonly boxes = new BoxPool();
  readonly grid = new SpatialGrid();

  #tick = 0;
  #spawnCursor = 0;
  /** Monotonic counter for NPC and box ids, so ids are never reused within a run. */
  #npcSerial = 0;
  /** Per-tier count of spawns attempted, used to spread NPCs around the map. */
  readonly #tierSpawnCursor = new Map<NpcTier, number>();

  /**
   * Whether the ambient spawner may add NPCs.
   *
   * Tests that need a hand-placed, precisely-positioned NPC turn this off instead of
   * clearing the map and hoping: with spawning live, a real spawn can land next to the
   * fixture and change the outcome of the test.
   */
  npcSpawning = true;

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

  /** Number of live NPCs. */
  get npcCount(): number {
    let count = 0;
    for (const npc of this.npcs.values()) if (npc.isAlive) count += 1;
    return count;
  }

  /** Live projectiles, for the debug panel and tests. */
  get projectileCount(): number {
    return this.projectiles.liveCount;
  }

  /** Live loot boxes. */
  get boxCount(): number {
    return this.boxes.liveCount;
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
  addPlayer(options: {
    readonly id: string;
    readonly shipClass?: ShipClass;
    /**
     * Explicit spawn point. Used by tests to place players far apart for Area of
     * Interest, and by the future "join a friend" flow. Omit it for the default ring.
     */
    readonly at?: { readonly x: number; readonly y: number };
  }): Player {
    const angle = this.#spawnCursor * SPAWN_ANGLE_STEP;
    this.#spawnCursor += 1;

    const x = options.at?.x ?? SPAWN_CENTER_X + Math.cos(angle) * SPAWN_RING_RADIUS;
    const y = options.at?.y ?? SPAWN_CENTER_Y + Math.sin(angle) * SPAWN_RING_RADIUS;

    const player = new Player({
      id: options.id,
      shipClass: options.shipClass,
      x,
      y,
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

  /**
   * Bring a dead player back into the safe zone.
   *
   * The ring is small and near the centre so a respawn is always somewhere the player
   * is not immediately in danger, and the angle is derived from the player id so two
   * players who die together do not reappear on top of each other.
   */
  respawnPlayer(player: Player): void {
    const angle = hash01(`${player.id}:respawn:${String(this.#tick)}`) * Math.PI * 2;
    const at = {
      x: SPAWN_CENTER_X + Math.cos(angle) * RESPAWN_RING_RADIUS,
      y: SPAWN_CENTER_Y + Math.sin(angle) * RESPAWN_RING_RADIUS,
    };

    player.respawn({ at, tick: this.#tick });
    this.grid.upsert(player);
  }

  /* ------------------------------------------------------------------------ */
  /*  NPCs                                                                    */
  /* ------------------------------------------------------------------------ */

  /**
   * Top up the NPC population, one tick at a time.
   *
   * Called once per spawn interval rather than every tick: spawning is a policy
   * decision, not part of the simulation step, and doing it on the tick path would make
   * tick cost depend on how many NPCs happened to be dead.
   */
  maintainNpcs(): void {
    if (!this.npcSpawning) return;
    if (this.#tick % NPC_SPAWN_INTERVAL_TICKS !== 0) return;

    for (const tier of [NpcTier.Small, NpcTier.Medium, NpcTier.Large] as const) {
      const target = NPC_TARGET_COUNTS[tier];
      const alive = this.#aliveCount(tier);

      for (let index = alive; index < target; index += 1) {
        if (this.npcCount >= NPC_MAX_ALIVE) return;
        this.#spawnNpc(tier);
      }
    }
  }

  #aliveCount(tier: NpcTier): number {
    let count = 0;
    for (const npc of this.npcs.values()) {
      if (npc.tier === tier && npc.isAlive) count += 1;
    }
    return count;
  }

  /**
   * Spawn one NPC of `tier` inside its own zone.
   *
   * The annulus for a zone is `[inner, outer)`; the safe zone has no inner ring, and the
   * open zone has no outer one. Sampling by area rather than by radius stops the outer
   * bands from being wildly under-populated, which is the classic bug in ring spawning.
   */
  #spawnNpc(tier: NpcTier): Npc {
    const zone = NPC_TIER_ZONE[tier];
    const bounds = zoneBounds(zone);

    const cursor = (this.#tierSpawnCursor.get(tier) ?? 0) + 1;
    this.#tierSpawnCursor.set(tier, cursor);

    /* Golden-angle walk: consecutive spawns land far apart without needing a random
       number generator, so a replay of the same world produces the same layout. */
    const angle = cursor * 2.399_963_229_728_653;

    const inner = bounds.inner;
    const outer = Math.min(bounds.outer, WORLD_WIDTH / 2 - 120);
    const radius = Math.sqrt(
      inner * inner + hash01(`${tier}:${String(cursor)}`) * (outer * outer - inner * inner),
    );

    const x = SPAWN_CENTER_X + Math.cos(angle) * radius;
    const y = SPAWN_CENTER_Y + Math.sin(angle) * radius;

    /* Never reuse an id that is still in the table. `Map.set` would silently replace the
       live NPC holding it — the ship would teleport to the new spawn point, fully healed,
       which reads as a phantom respawn and makes its killer's shots vanish mid-flight. */
    do {
      this.#npcSerial += 1;
    } while (this.npcs.has(`n${String(this.#npcSerial)}`));

    const npc = new Npc({
      id: `n${String(this.#npcSerial)}`,
      tier,
      x: wrapCoord(x, WORLD_WIDTH),
      y: wrapCoord(y, WORLD_HEIGHT),
      rotation: angle,
    });

    this.npcs.set(npc.id, npc);
    return npc;
  }

  getNpc(id: string): Npc | undefined {
    return this.npcs.get(id);
  }

  /* ------------------------------------------------------------------------ */
  /*  Projectiles and boxes                                                   */
  /* ------------------------------------------------------------------------ */

  /* ------------------------------------------------------------------------ */
  /*  Snapshot                                                                */
  /* ------------------------------------------------------------------------ */

  /**
   * Build the entity list for one snapshot: players, NPCs, projectiles and boxes.
   *
   * AoI filtering happens in `Loop`, which asks for these once per tick and then decides
   * per viewer. Returning a flat list here keeps this class free of any per-client logic.
   */
  snapshotEntities(): {
    readonly players: readonly Player[];
    readonly npcs: readonly Npc[];
    readonly projectiles: readonly { id: string; x: number; y: number }[];
    readonly boxes: readonly { id: string; x: number; y: number }[];
  } {
    const players: Player[] = [];
    for (const player of this.players.values()) {
      if (!player.isAlive) continue;
      players.push(player);
    }

    const npcs: Npc[] = [];
    for (const npc of this.npcs.values()) {
      if (!npc.isAlive) continue;
      npcs.push(npc);
    }

    const projectiles: { id: string; x: number; y: number }[] = [];
    for (const projectile of this.projectiles.live()) {
      projectiles.push({ id: projectile.id, x: projectile.x, y: projectile.y });
    }

    const boxes: { id: string; x: number; y: number }[] = [];
    for (const box of this.boxes.live()) {
      boxes.push({ id: box.id, x: box.x, y: box.y });
    }

    return { players, npcs, projectiles, boxes };
  }

  /**
   * Rebuild the spatial index.
   *
   * Players and NPCs share one grid: AoI asks "what is near me" without caring what kind
   * of thing it is, and a second index would double the query cost for no benefit.
   */
  refreshGrid(): void {
    /* Projectiles and boxes go in the grid too, and this is not optional: `entitiesNear`
       resolves AoI through the grid, so anything absent from it is invisible to every
       viewer no matter how close it is. They were missing here at first, which meant
       shots were simulated, collided and drew blood while no client ever saw one. */
    this.grid.rebuild([
      ...this.players.values(),
      ...this.npcs.values(),
      ...[...this.projectiles.live()].map((shot) => ({ id: shot.id, x: shot.x, y: shot.y })),
      ...[...this.boxes.live()].map((box) => ({ id: box.id, x: box.x, y: box.y })),
    ]);
  }
}

/** Inner and outer radius of a zone's annulus, in world units. */
function zoneBounds(zone: ZoneId): { inner: number; outer: number } {
  const index = ZONES.findIndex((definition) => definition.id === zone);
  const current = ZONES[index];

  const inner = index > 0 ? (ZONES[index - 1]?.radius ?? 0) : 0;
  /* The outermost zone has no radius, so it runs to the corner of the world: half the
     diagonal. Half the width would leave the four corners permanently empty. */
  const outer = current?.radius ?? WORLD_WIDTH / 2;

  return { inner, outer };
}

/** Fold a coordinate into [0, size). */
function wrapCoord(value: number, size: number): number {
  return ((value % size) + size) % size;
}
