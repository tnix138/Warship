import {
  INPUT_STALE_AFTER_MS,
  MessageType,
  PLAYER_STATE_INTERVAL_TICKS,
  PROTOCOL_VERSION,
  SNAPSHOT_COORDINATE_DECIMALS,
  TICK_DURATION_S,
  computeHullStats,
  levelFromXp,
  stepMotion,
  wrapWorldPosition,
  xpToNextLevel,
  type InputFrame,
  type PlayerStateMessage,
  type ServerMessage,
  type SnapshotEntity,
  type UpgradeId,
} from '@warship/shared';

import type { Logger } from '../logger.js';
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
      const stats = computeHullStats(player.shipClass, player.upgrades);

      const next = stepMotion(
        { x: player.x, y: player.y, rotation: player.rotation, speed: player.speed },
        { turn: intent.turn, throttle: intent.throttle },
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

  #broadcastSnapshot(tick: number): void {
    const entities: SnapshotEntity[] = this.#world
      .snapshotEntities()
      .map((player) => roundEntity(player.toSnapshotEntity()));

    this.#broadcast({
      v: PROTOCOL_VERSION,
      t: MessageType.SNAPSHOT,
      tick,
      serverTime: Date.now(),
      entities,
    });
  }

  #sendPlayerStates(tick: number): void {
    for (const player of this.#world.allPlayers()) {
      if (!player.isAlive) continue;

      const stats = computeHullStats(player.shipClass, player.upgrades);
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
    const stats = computeHullStats(player.shipClass, player.upgrades);
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
