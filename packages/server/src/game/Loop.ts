import {
  INPUT_STALE_AFTER_MS,
  MessageType,
  PLAYER_STATE_INTERVAL_TICKS,
  AIM_ASSIST_FACTOR,
  SNAPSHOT_KEYFRAME_INTERVAL_TICKS,
  PROTOCOL_VERSION,
  SNAPSHOT_COORDINATE_DECIMALS,
  TICK_DURATION_S,
  computeShipStats,
  levelFromXp,
  stepMotion,
  wrapWorldPosition,
  xpToNextLevel,
  type InputFrame,
  type PlayerStateMessage,
  type ServerMessage,
  type SnapshotMessage,
  type SnapshotEntity,
  type UpgradeId,
} from '@warship/shared';

import { angleDelta, normalizeAngle } from '@warship/shared';

import type { Logger } from '../logger.js';

/**
 * Rotate `current` toward `target` by at most `maxStep` radians.
 *
 * Aim arrives as an absolute angle, but a ship cannot pivot instantly, so the
 * server walks toward it instead of assigning it. `angleDelta` gives the signed
 * shortest arc, which is what keeps a turn through ±π from going the long way
 * round.
 */
function approachAngle(current: number, target: number, maxStep: number): number {
  const delta = angleDelta(current, target);
  if (Math.abs(delta) <= maxStep) return normalizeAngle(target);
  return normalizeAngle(current + Math.sign(delta) * maxStep);
}
import { createAoiState, isUnchanged, updateAoi, type AoiState } from './AoI.js';
import type { Player } from './Player.js';
import type { World } from './World.js';

/**
 * The game loop.
 *
 * One `tick()` call is the entire authoritative step: advance every player's
 * motion, refresh the spatial index, then produce frames. It is deliberately
 * synchronous and allocation-light — no promises, no timers, no I/O — so the clock
 * can call it 20 times a second with predictable cost.
 *
 * The loop owns *policy* (what a tick does); `World` owns *state*; the network
 * layer owns *transport*. `Loop` is the only place those three meet, which is why
 * it takes a `broadcast` callback instead of a socket.
 */
export interface LoopOptions {
  readonly world: World;
  readonly logger: Logger;
  /** Deliver one already-encoded message to one player's connection. */
  readonly send: (playerId: string, message: ServerMessage) => void;
  /** Deliver one message to every connected player. */
  readonly broadcast: (message: ServerMessage) => void;
}

/** Everything the loop needs from the network layer, and nothing more. */
export class Loop {
  readonly #world: World;
  readonly #log: Logger;
  readonly #send: LoopOptions['send'];
  readonly #broadcast: LoopOptions['broadcast'];
  /** Per-player AoI memory (what each client currently believes exists). */
  readonly #aoi = new Map<string, { state: AoiState }>();

  constructor(options: LoopOptions) {
    this.#world = options.world;
    this.#log = options.logger;
    this.#send = options.send;
    this.#broadcast = options.broadcast;
  }

  /**
   * Advance the world by exactly one tick and emit the resulting frames.
   *
   * Order matters:
   *  1. motion — the state the snapshot will describe,
   *  2. spatial index — must reflect the *new* positions,
   *  3. snapshot — one frame, broadcast to everyone,
   *  4. player state — private, a few times per second.
   */
  tick(): void {
    const tick = this.#world.advanceTick();
    const dt = TICK_DURATION_S;

    this.#stepPlayers(dt, tick);
    this.#world.refreshGrid();
    this.#broadcastSnapshot(tick);

    if (tick % PLAYER_STATE_INTERVAL_TICKS === 0) {
      this.#sendPlayerStates(tick);
    }
  }

  /* ------------------------------------------------------------------------ */
  /*  Simulation                                                              */
  /* ------------------------------------------------------------------------ */

  #stepPlayers(dt: number, tick: number): void {
    const now = performance.now();

    for (const player of this.#world.allPlayers()) {
      if (!player.isAlive) continue;

      // A stale intent (packet loss, tab in the background) must not keep pushing
      // the ship forever: the ship coasts instead of running on autopilot.
      const intent = this.#effectiveIntent(player, now);
      const stats = computeShipStats(player.shipClass, player.upgrades);

      /* Mouse aim beats keyboard turn: if the client sent an absolute heading,
         adopt it (limited to what the hull could physically rotate this tick, so a
         teleporting cursor cannot spin the ship instantly). `null` means "no mouse",
         in which case `turn` steers. */
      const heading =
        intent.aim === null
          ? player.rotation
          : approachAngle(player.rotation, intent.aim, stats.turnRate * AIM_ASSIST_FACTOR * dt);

      const next = stepMotion(
        { x: player.x, y: player.y, rotation: heading, speed: player.speed },
        { turn: intent.aim === null ? intent.turn : 0, throttle: intent.throttle },
        { speed: stats.maxSpeed, turnRate: stats.turnRate },
        dt,
      );

      const wrapped = wrapWorldPosition({ x: next.x, y: next.y });
      player.x = wrapped.x;
      player.y = wrapped.y;
      player.rotation = next.rotation;
      player.speed = next.speed;

      /* Firing is *gated* here but not implemented yet — combat and projectiles
         are a later milestone. Recording the attempt now means the reload
         indicator in `PLAYER_STATE` already has honest data. */
      if (intent.firing && tick - player.lastFiredTick >= this.#reloadTicks(stats.reloadTime)) {
        player.lastFiredTick = tick;
      }
    }
  }

  /** Neutral intent when the player has not sent anything recently. */
  #effectiveIntent(player: Player, now: number): InputFrame {
    if (player.intent === null) {
      return { turn: 0, throttle: 0, aim: null, firing: false };
    }
    if (now - player.lastInputAt > INPUT_STALE_AFTER_MS) {
      return { turn: 0, throttle: 0, aim: player.intent.aim, firing: false };
    }
    return player.intent;
  }

  /** Reload time expressed in whole ticks, never less than one. */
  #reloadTicks(reloadTime: number): number {
    return Math.max(1, Math.round(reloadTime / TICK_DURATION_S));
  }

  /* ------------------------------------------------------------------------ */
  /*  Frames                                                                  */
  /* ------------------------------------------------------------------------ */

  /**
   * Build and send one snapshot per player.
   *
   * This is where Area of Interest and delta compression meet, so the shape is:
   *
   *  1. build every entity's wire record once (not once per viewer),
   *  2. for each player, ask AoI which ids are in range from *their* position,
   *  3. diff that against what the client was told last tick:
   *       - an entity that is new to the client, or whose fields changed, goes in,
   *       - an id that dropped out of view goes into `removed`,
   *  4. if nothing at all changed, skip the frame entirely — a stationary ship in
   *     empty water costs zero bytes.
   *
   * `full` is used for the first snapshot of a session and whenever AoI churn makes
   * a delta ambiguous, so a client can always recover from exactly one full frame.
   */
  #broadcastSnapshot(tick: number): void {
    const players = this.#world.snapshotEntities();

    // Built once and shared: `toSnapshotEntity` allocates, and at 100 players a
    // per-viewer rebuild would be 10 000 allocations per tick.
    const records = new Map<string, SnapshotEntity>();
    const positions = new Map<string, { id: string; x: number; y: number }>();
    for (const player of players) {
      const record = roundEntity(player.toSnapshotEntity());
      records.set(record.id, record);
      positions.set(record.id, { id: record.id, x: record.x, y: record.y });
    }

    for (const viewer of players) {
      const aoi = this.#aoiFor(viewer.id);
      const origin = positions.get(viewer.id);
      if (origin === undefined) continue;

      /* Prediction acknowledgement travels with the viewer's own entity, so it
         arrives exactly once per snapshot and cannot be missed. */
      const own = records.get(viewer.id);
      if (own !== undefined) {
        records.set(viewer.id, { ...own, ackSeq: viewer.lastInputSeq });
      }

      const result = updateAoi(aoi.state, this.#world.grid, positions, origin);

      /* --- decide full vs delta ------------------------------------------- */
      // A periodic keyframe bounds any desync to one second and gives the client a
      // guaranteed recovery point without needing an explicit request.
      const forceFull = aoi.state.needsFull || tick % SNAPSHOT_KEYFRAME_INTERVAL_TICKS === 0;
      const entities: SnapshotEntity[] = [];

      for (const entity of result.visible) {
        const record = records.get(entity.id);
        if (record === undefined) continue;

        const previous = aoi.state.lastSent.get(entity.id);
        const unchanged = isUnchanged(previous, record);
        if (unchanged && !forceFull) continue;

        entities.push(record);
      }

      const removed = forceFull ? [] : result.removed;

      // Nothing to say: the client's world is already correct.
      if (!forceFull && entities.length === 0 && removed.length === 0) continue;

      const message = {
        v: PROTOCOL_VERSION,
        t: MessageType.SNAPSHOT,
        tick,
        serverTime: Date.now(),
        full: forceFull,
        entities,
        ...(removed.length > 0 ? { removed } : {}),
      } as SnapshotMessage;

      this.#send(viewer.id, message);

      /* --- remember what this client now knows ---------------------------- */
      aoi.state.needsFull = false;
      for (const record of entities) {
        aoi.state.lastSent.set(record.id, record);
      }
      for (const gone of removed) {
        aoi.state.lastSent.delete(gone.id);
      }
    }
  }

  /**
   * Forget every client's AoI memory so the next tick emits `full` snapshots.
   *
   * Used when the world changes underneath the clients in a way that is not ordinary
   * movement — a test repositioning players, and later a respawn/teleport — so the
   * next frame is an unambiguous reset rather than a delta computed against stale
   * assumptions.
   */
  resetAoiMemory(): void {
    for (const entry of this.#aoi.values()) {
      entry.state.needsFull = true;
      entry.state.lastSent.clear();
    }
  }

  /** AoI memory for a player, created on first use. */
  #aoiFor(playerId: string): { state: AoiState } {
    let entry = this.#aoi.get(playerId);
    if (entry === undefined) {
      entry = { state: createAoiState() };
      this.#aoi.set(playerId, entry);
    }
    return entry;
  }

  #sendPlayerStates(tick: number): void {
    for (const player of this.#world.allPlayers()) {
      if (!player.isAlive) continue;

      const stats = computeShipStats(player.shipClass, player.upgrades);
      const upgrades: Partial<Record<UpgradeId, number>> = {};
      for (const [id, rank] of player.upgrades) upgrades[id] = rank;

      this.#send(player.id, buildPlayerState(player, stats.maxHp, tick, upgrades));
    }
  }

  /* ------------------------------------------------------------------------ */
  /*  Convenience used by the join flow                                       */
  /* ------------------------------------------------------------------------ */

  /** Announce a player to everyone else (and to themselves). */
  announceJoin(player: Player): void {
    this.#broadcast({
      v: PROTOCOL_VERSION,
      t: MessageType.EVENT,
      tick: this.#world.tick,
      kind: 'join',
      entityId: player.id,
      data: { shipClass: player.shipClass },
    });
    this.#log.debug('player joined world', { player: player.id, shipClass: player.shipClass });
  }

  /** Announce a departure. */
  announceLeave(playerId: string): void {
    this.#broadcast({
      v: PROTOCOL_VERSION,
      t: MessageType.EVENT,
      tick: this.#world.tick,
      kind: 'leave',
      entityId: playerId,
    });
  }

  /** Send a single player's private state immediately (used on join/respawn). */
  sendPlayerState(player: Player): void {
    const tick = this.#world.tick;
    this.#sendPlayerStatesInternal(tick, player);
  }

  #sendPlayerStatesInternal(tick: number, player: Player): void {
    const stats = computeShipStats(player.shipClass, player.upgrades);
    const upgrades: Partial<Record<UpgradeId, number>> = {};
    for (const [id, rank] of player.upgrades) upgrades[id] = rank;

    this.#send(player.id, buildPlayerState(player, stats.maxHp, tick, upgrades));
  }
}

/** Private per-player frame. Extracted so both call sites can never drift. */
function buildPlayerState(
  player: Player,
  maxHp: number,
  tick: number,
  upgrades: Partial<Record<UpgradeId, number>>,
): PlayerStateMessage {
  return {
    v: PROTOCOL_VERSION,
    t: MessageType.PLAYER_STATE,
    tick,
    entityId: player.id,
    shipClass: player.shipClass,
    hp: Math.round(player.hp),
    maxHp: Math.round(maxHp),
    level: levelFromXp(player.xp),
    xp: Math.round(player.xp),
    xpToNextLevel: xpToNextLevel(player.xp),
    scrap: Math.round(player.scrap),
    zone: player.zone,
    upgrades,
    lastFiredTick: player.lastFiredTick,
  };
}

/** Snapshot coordinates are rounded so frames stay small and diffs stay readable. */
function roundEntity(entity: SnapshotEntity): SnapshotEntity {
  const factor = 10 ** SNAPSHOT_COORDINATE_DECIMALS;
  return {
    id: entity.id,
    x: Math.round(entity.x * factor) / factor,
    y: Math.round(entity.y * factor) / factor,
    rotation: Math.round(entity.rotation * 1000) / 1000,
    hp: Math.round(entity.hp),
    shipClass: entity.shipClass,
  };
}
