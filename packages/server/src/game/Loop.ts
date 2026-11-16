import {
  AOI_INTEREST_RADIUS,
  BoxKind,
  EntityKind,
  EventKind,
  INPUT_STALE_AFTER_MS,
  MessageType,
  PLAYER_STATE_INTERVAL_TICKS,
  SNAPSHOT_KEYFRAME_INTERVAL_TICKS,
  PROTOCOL_VERSION,
  SNAPSHOT_COORDINATE_DECIMALS,
  RESPAWN_DELAY_S,
  TICK_DURATION_S,
  UPGRADE_CHOICES,
  computeShipStats,
  levelFromXp,
  stepShipMotion,
  wrappedDelta,
  wrapWorldPosition,
  xpToNextLevel,
  zoneAt,
  NpcState,
  type InputFrame,
  type PlayerStateMessage,
  type ServerMessage,
  type SnapshotMessage,
  type SnapshotEntity,
  MVP_FLAGS,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  NPC_TIER_LEVEL,
  type UpgradeId,
} from '@warship/shared';

import type { Logger } from '../logger.js';
import { createAoiState, isUnchanged, updateAoi, type AoiState } from './AoI.js';
import {
  applyDamage,
  isPickupInRange,
  killReward,
  lootForKill,
  repairAmount,
  resolveHits,
  type Damageable,
} from './Combat.js';
import type { Npc } from './Npc.js';
import type { Projectile } from './Projectile.js';
import type { Player } from './Player.js';
import { addXp, hullTierForLevel, purchasableUpgrades, purchaseUpgrade } from './Progression.js';
import { canFire, selectTarget } from './Targeting.js';
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

  /** Player id that last damaged each NPC, for kill attribution. */
  readonly #lastNpcAttacker = new Map<string, string | null>();
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

    /* Order is the simulation's contract, and combat is why it matters:
         1. respawn whoever is due — before movement, so a revived ship moves this tick,
         2. players and NPCs move,
         3. projectiles advance, so their swept segment is this tick's displacement,
         4. hits resolve against the *post-move* poses — the state the snapshot describes,
         5. deaths, loot and pickups,
         6. spatial index, snapshots, private state. */
    this.#processRespawns(tick);
    this.#stepPlayers(dt, tick);
    this.#stepNpcs(tick);
    this.#world.projectiles.advance();
    this.#resolveCombat(tick);
    this.#processDeaths(tick);
    this.#processPickups(tick);
    this.#world.boxes.advance();
    this.#world.maintainNpcs();
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

    /* One list of shootable things for every player this tick. With 100 players against
       50 NPCs, rebuilding it per player would be 5 000 allocations per tick for an answer
       that is identical for all of them. */
    const candidates: { id: string; x: number; y: number }[] = [];
    for (const npc of this.#world.npcs.values()) {
      if (!npc.isAlive) continue;
      candidates.push({ id: npc.id, x: npc.x, y: npc.y });
    }

    for (const player of this.#world.allPlayers()) {
      if (!player.isAlive) {
        /* A dead ship holds no lock. Not strictly necessary — `die` already clears it —
           but this keeps the invariant true from the outside: a `targetId` in a snapshot
           always belongs to a ship that could actually shoot at it. */
        player.targetId = null;
        continue;
      }

      // A stale intent (packet loss, tab in the background) must not keep pushing
      // the ship forever: the ship coasts instead of running on autopilot.
      const intent = this.#effectiveIntent(player, now);
      const stats = computeShipStats(player.shipClass, player.upgrades);

      /* Movement is keyboard only now: `turn` and `throttle`, nothing else. The old
         `aim` field swung the hull toward the cursor, which is exactly the thing
         mouse-aim removal was meant to delete. */
      const next = stepShipMotion(
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

      /* Targeting and firing are one decision, server-side, every tick. The client sends
         a target *request*; this is where it becomes or fails to become a shot. */
      const target = selectTarget({
        owner: player,
        candidates,
        manualTargetId: player.manualTargetId,
        range: stats.range,
        worldWidth: WORLD_WIDTH,
        worldHeight: WORLD_HEIGHT,
      });

      player.targetId = target.id;

      /* Clear a manual selection the moment it stops qualifying. Doing it here rather
         than in the selection function keeps the selection pure, and means the client
         sees the lock drop on the same frame the guns go quiet. */
      if (player.manualTargetId !== null && player.manualTargetId !== target.id) {
        player.manualTargetId = null;
      }

      if (target.id === null) continue;

      /* Fire automatically at whatever is selected. `canFire` applies both gates: the
         weapon's cycle time and the hull's sustained rate. */
      if (
        !canFire({
          tick,
          lastFiredTick: player.lastFiredTick,
          reloadTime: stats.reloadTime,
          fireRate: stats.fireRate,
          tickDurationS: TICK_DURATION_S,
        })
      ) {
        continue;
      }

      /* The gun points at the target, not along the hull: with mouse aim gone the hull
         cannot be expected to face the enemy, and requiring it would mean "steer at the
         thing you are shooting" again by another name. Firing along the line to the
         target is what makes `W` + a click a complete way to play.
         `wrappedDelta` so a shot at something across the seam leaves the right way. */
      const bearing = wrappedDelta(player, this.#targetPoint(target.id) ?? player);
      const spawnAngle = Math.atan2(bearing.y, bearing.x);

      const shot = this.#world.projectiles.spawn({
        ownerId: player.id,
        ownerIsNpc: false,
        x: player.x,
        y: player.y,
        angle: spawnAngle,
        damage: stats.damage,
        shipMaxSpeed: stats.maxSpeed,
        range: stats.range,
      });
      /* A refused spawn (pool full) must not silently consume the cooldown. */
      if (shot !== null) player.lastFiredTick = tick;
    }
  }

  /**
   * Step every NPC's brain and motion, and let them fire.
   *
   * The AI returns an intent rather than acting, so the reload gate and the projectile
   * cap are enforced in exactly one place per faction — here and in `#stepPlayers` — and
   * an NPC can never bypass them.
   */
  #stepNpcs(tick: number): void {
    /* Targets are gathered once per tick rather than per NPC: with 50 NPCs against 100
       players a per-NPC scan is 5 000 distance checks, which is affordable but pointless
       when the answer is the same list. */
    const targets: { id: string; x: number; y: number }[] = [];
    for (const player of this.#world.allPlayers()) {
      if (!player.isAlive) continue;
      /* A shielded ship is not a valid target.
         This is the other half of the spawn-shield fix, and the half that actually
         matters: `#resolveHits` already drops damage aimed at a shielded player, but the
         NPC still *chose* them, closed in, and was sitting at point-blank when the shield
         expired. Skipping them here means the AI never commits in the first place, so
         protection ends with the player alone rather than with a volley already in the
         air. Without this, 3 s of invulnerability just delays the first hit by 3 s. */
      if (player.shieldSeconds(tick) > 0) continue;
      /* Nor is a player who has never asked to move.
         Spawn rings are finite and the sea is full of NPCs, so "clear of every enemy" is
         not something the spawn point can promise — an NPC that happened to be patrolling
         nearby will find a stationary ship in under a minute no matter where it appeared.
         The only reliable way to keep the first minute quiet is to make motion the
         opt-in: until the player presses a key, they are scenery as far as the AI is
         concerned. This cannot be abused either — the moment they steer, every NPC that
         already had them in range still has them. */
      if (!player.hasTakenControl) continue;
      targets.push({ id: player.id, x: player.x, y: player.y });
    }

    for (const npc of this.#world.npcs.values()) {
      if (!npc.isAlive) continue;

      const intent = npc.step(targets);
      if (!intent.wantsToFire) continue;

      /* Same two gates the player's gun goes through: the AI asks, this decides. */
      if (
        !canFire({
          tick,
          lastFiredTick: npc.lastFiredTick,
          reloadTime: npc.stats.reloadTime,
          fireRate: npc.stats.fireRate,
          tickDurationS: TICK_DURATION_S,
        })
      ) {
        continue;
      }

      const shot = this.#world.projectiles.spawn({
        ownerId: npc.id,
        ownerIsNpc: true,
        x: npc.x,
        y: npc.y,
        angle: npc.rotation,
        damage: npc.stats.damage,
        shipMaxSpeed: npc.stats.maxSpeed,
        /* The NPC fires along its hull, so its shot must not out-reach the range its AI
           thinks it has — otherwise it damages ships it has already decided are out of
           engagement. */
        range: npc.stats.range,
      });
      if (shot !== null) npc.lastFiredTick = tick;
    }
  }

  /**
   * Resolve every live shot against every damageable target.
   *
   * Shielded players are skipped entirely rather than taking zero damage: a spawn shield
   * that still consumed projectiles would let a camper clear their own line of fire.
   */
  #resolveCombat(tick: number): void {
    const shots = [...this.#world.projectiles.live()].map((projectile) => ({
      id: projectile.id,
      ownerId: projectile.ownerId,
      ownerIsNpc: projectile.ownerIsNpc,
      x: projectile.x,
      y: projectile.y,
      previousX: projectile.previousX,
      previousY: projectile.previousY,
      damage: projectile.damage,
    }));

    if (shots.length === 0) return;

    const targets: (Damageable & { readonly isNpc: boolean })[] = [];
    for (const player of this.#world.allPlayers()) {
      if (!player.isAlive || player.shieldSeconds(tick) > 0) continue;
      targets.push({
        id: player.id,
        x: player.x,
        y: player.y,
        radius: computeShipStats(player.shipClass, player.upgrades).radius,
        isNpc: false,
      });
    }
    for (const npc of this.#world.npcs.values()) {
      if (!npc.isAlive) continue;
      targets.push({ id: npc.id, x: npc.x, y: npc.y, radius: npc.radius, isNpc: true });
    }

    const hits = resolveHits({ shots, targets });

    for (const hit of hits) {
      const projectile = this.#findProjectile(hit.projectileId);
      if (projectile !== undefined) this.#world.projectiles.release(projectile);

      const npc = this.#world.npcs.get(hit.targetId);
      if (npc !== undefined) {
        const dealt = npc.applyDamage(hit.damage);
        if (dealt > 0) {
          /* Remember who last drew blood. Attribution is only needed at the moment of
             death, and the alternative — threading an owner through the projectile and
             out the other side of `resolveHits` — is more machinery than one string
             per NPC. Last hit wins, which is the simplest rule a player will accept. */
          this.#lastNpcAttacker.set(npc.id, projectile?.ownerId ?? null);
          this.#broadcast({
            v: PROTOCOL_VERSION,
            t: MessageType.EVENT,
            tick,
            kind: EventKind.Damaged,
            entityId: npc.id,
            data: { amount: Math.round(dealt) },
          });
        }
        continue;
      }

      const player = this.#world.players.get(hit.targetId);
      if (player === undefined) continue;

      const armor = computeShipStats(player.shipClass, player.upgrades).armor;
      const dealt = player.applyDamage(applyDamage({ damage: hit.damage, armor, shieldS: 0 }));
      if (dealt > 0) {
        this.#send(player.id, {
          v: PROTOCOL_VERSION,
          t: MessageType.EVENT,
          tick,
          kind: EventKind.Damaged,
          entityId: player.id,
          data: { amount: Math.round(dealt) },
        });
      }
    }
  }

  /** Wire record for a box, including its payload kind for the client's icon. */
  #boxRecord(id: string): SnapshotEntity | null {
    for (const box of this.#world.boxes.live()) {
      if (box.id !== id) continue;
      return {
        id: box.id,
        x: box.x,
        y: box.y,
        rotation: 0,
        hp: 1,
        kind: EntityKind.Box,
        boxKind: box.kind,
      };
    }
    return null;
  }

  /** Projectile by slot id. Linear, but the pool is capped at 500 and only on a hit. */
  #findProjectile(id: string): Projectile | undefined {
    for (const projectile of this.#world.projectiles.live()) {
      if (projectile.id === id) return projectile;
    }
    return undefined;
  }

  /**
   * Turn deaths into loot, XP and respawn timers.
   *
   * NPCs are removed from play immediately and respawned by `maintainNpcs`; players stay
   * as a dead record so their connection, level and XP survive, and are revived by
   * `#processRespawns`.
   */
  #processDeaths(tick: number): void {
    for (const npc of this.#world.npcs.values()) {
      if (npc.hp > 0 || npc.state === NpcState.Dead) continue;
      npc.kill(tick);
      this.#onNpcKilled(npc, tick);
    }

    for (const player of this.#world.allPlayers()) {
      if (player.hp > 0 || player.diedAtTick !== null) continue;
      player.die(tick);

      this.#send(player.id, {
        v: PROTOCOL_VERSION,
        t: MessageType.EVENT,
        tick,
        kind: EventKind.Kill,
        entityId: player.id,
        data: { victimId: player.id, respawnInS: RESPAWN_DELAY_S },
      });
      this.#broadcast({
        v: PROTOCOL_VERSION,
        t: MessageType.EVENT,
        tick,
        kind: EventKind.Kill,
        entityId: player.id,
        data: { victimId: player.id },
      });
    }
  }

  /** Award XP for an NPC kill and scatter its loot. */
  #onNpcKilled(npc: Npc, tick: number): void {
    const zone = zoneAt({ x: npc.x, y: npc.y });

    /* The last player to damage the wreck gets the reward; anyone else within interest
       range gets a share. Paying only the killer would make a two-player fight worse
       than two solo fights, and paying everyone in the *world* would make proximity
       irrelevant. */
    const killerId = this.#lastNpcAttacker.get(npc.id) ?? null;
    this.#lastNpcAttacker.delete(npc.id);

    for (const player of this.#world.allPlayers()) {
      if (!player.isAlive) continue;

      const distanceSquared = wrappedDelta(player, npc);
      if (Math.hypot(distanceSquared.x, distanceSquared.y) > AOI_INTEREST_RADIUS) continue;

      const earned = killReward({
        tier: npc.tier,
        baseXp: npc.stats.xp,
        zone,
        playerLevel: levelFromXp(player.xp),
        /* The tier *is* the challenge level. Deriving one from the XP value
           (`levelFromXp(xp * 40)`) put a Coastal at level 8, so a level-1 player took a
           50% level-gap penalty for fighting the weakest enemy in the game — the reward
           curve was inverted for exactly the players who needed it most. */
        npcLevel: NPC_TIER_LEVEL[npc.tier],
      });

      /* Assist pay is a fraction, so the killer is always the best-rewarded participant
         and the incentive to land the final blow survives. */
      const credit = player.id === killerId ? 1 : 0.5;
      this.#grantXp(player, Math.round(earned * credit), tick);
    }

    for (const drop of lootForKill({ tier: npc.tier, x: npc.x, y: npc.y, sourceId: npc.id })) {
      const box = this.#world.boxes.spawn({
        x: npc.x,
        y: npc.y,
        kind: drop.kind,
        value: drop.value,
        sourceId: npc.id,
        angle: drop.angle,
        distance: drop.distance,
      });
      if (box === null) break; // pool full: stop rather than spin

      this.#broadcast({
        v: PROTOCOL_VERSION,
        t: MessageType.EVENT,
        tick,
        kind: EventKind.BoxSpawn,
        entityId: box.id,
        data: { boxId: box.id, boxKind: box.kind },
      });
    }

    this.#broadcast({
      v: PROTOCOL_VERSION,
      t: MessageType.EVENT,
      tick,
      kind: EventKind.Kill,
      entityId: npc.id,
      data: { victimId: npc.id, npcTier: npc.tier, ...(killerId === null ? {} : { killerId }) },
    });
  }

  /**
   * Add XP to a player and announce any level-up.
   *
   * The announcement carries the upgrade *choices* so the client's modal can render from
   * the server's own validated list instead of guessing and being refused on submit.
   */
  #grantXp(player: Player, amount: number, tick: number): void {
    if (amount <= 0) return;

    const before = levelFromXp(player.xp);
    const outcome = addXp(player.xp, amount, player.upgradePoints);

    player.xp = outcome.xp;
    player.level = outcome.level;
    player.upgradePoints = outcome.upgradePoints;

    if (outcome.result === null) return;

    const choices = purchasableUpgrades(player.upgrades, player.upgradePoints).slice(
      0,
      UPGRADE_CHOICES,
    );

    this.#send(player.id, {
      v: PROTOCOL_VERSION,
      t: MessageType.EVENT,
      tick,
      kind: EventKind.LevelUp,
      entityId: player.id,
      data: {
        level: outcome.result.newLevel,
        xp: Math.round(player.xp),
        xpToNext: xpToNextLevel(player.xp),
        choices,
        upgradePoints: player.upgradePoints,
        upgrades: Object.fromEntries(player.upgrades),
      },
    });

    this.#log.info('player levelled up', {
      player: player.id,
      from: before,
      to: outcome.result.newLevel,
      points: outcome.result.pointsGranted,
      hullTier: outcome.result.hullTier,
    });
  }

  /** Revive everyone whose respawn timer has elapsed. */
  #processRespawns(tick: number): void {
    for (const player of this.#world.allPlayers()) {
      if (player.diedAtTick === null) continue;
      if (player.respawnInSeconds(tick) > 0) continue;

      this.#world.respawnPlayer(player);
      this.#log.debug('player respawned', { player: player.id, tick });
    }

    /* NPC spawn slots are refilled on their own cadence so a kill does not instantly
       repopulate the zone the player just cleared. */
    this.#world.maintainNpcs();
  }

  /**
   * Collect any box a player is standing on.
   *
   * Automatic rather than key-triggered: the player already has both hands on steering
   * and the mouse, and a manual pickup in a game where everything else is a movement
   * decision would be the only interaction in the game. The `PICKUP` frame still exists
   * for a deliberate future pickup and is handled separately.
   */
  #processPickups(tick: number): void {
    for (const box of [...this.#world.boxes.live()]) {
      for (const player of this.#world.allPlayers()) {
        if (!player.isAlive) continue;
        if (!isPickupInRange(box, player)) continue;

        this.#applyBox(player, box.kind, box.value, tick);
        this.#world.boxes.release(box);

        this.#send(player.id, {
          v: PROTOCOL_VERSION,
          t: MessageType.EVENT,
          tick,
          kind: EventKind.Pickup,
          entityId: box.id,
          data: { boxId: box.id, boxKind: box.kind, amount: box.value },
        });
        this.#broadcast({
          v: PROTOCOL_VERSION,
          t: MessageType.EVENT,
          tick,
          kind: EventKind.BoxClaimed,
          entityId: box.id,
          data: { boxId: box.id, killerId: player.id },
        });
        break;
      }
    }
  }

  #applyBox(player: Player, kind: BoxKind, value: number, tick: number): void {
    switch (kind) {
      case BoxKind.Scrap: {
        player.scrap += value;
        return;
      }
      case BoxKind.Repair: {
        player.heal(repairAmount(player.stats.maxHp));
        return;
      }
      case BoxKind.Part: {
        this.#grantXp(player, value, tick);
        return;
      }
    }
  }

  /**
   * Claim a specific box on a player's behalf.
   *
   * Returns false when the box does not exist, is out of range, or the player is dead.
   * Range is re-checked here rather than trusted from the client, because "which box"
   * is a client-supplied id and the client is not authoritative about anything.
   */
  claimBox(player: Player, boxId: string): boolean {
    if (!player.isAlive) return false;

    for (const box of this.#world.boxes.live()) {
      if (box.id !== boxId) continue;
      if (!isPickupInRange(box, player)) return false;

      this.#applyBox(player, box.kind, box.value, this.#world.tick);
      this.#world.boxes.release(box);

      this.#send(player.id, {
        v: PROTOCOL_VERSION,
        t: MessageType.EVENT,
        tick: this.#world.tick,
        kind: EventKind.Pickup,
        entityId: box.id,
        data: { boxId: box.id, boxKind: box.kind, amount: box.value },
      });
      return true;
    }

    return false;
  }

  /**
   * Buy one rank of an upgrade.
   *
   * Returns the new rank, or `null` when the purchase is illegal. Every rule lives in
   * `purchaseUpgrade`, so a client cannot buy past the point cap, past a rank cap, or
   * without a point — no matter what it sends.
   */
  purchaseUpgrade(player: Player, upgradeId: UpgradeId): number | null {
    const outcome = purchaseUpgrade({
      upgradeId,
      owned: player.upgrades,
      upgradePoints: player.upgradePoints,
    });
    if (outcome === null) return null;

    player.upgrades.set(upgradeId, outcome.rank);
    player.upgradePoints = outcome.upgradePoints;

    /* Stats may have changed (a hull upgrade raises max HP), so clamp the current hull
       to the new maximum rather than leaving it above. */
    const stats = computeShipStats(player.shipClass, player.upgrades);
    player.maxHp = stats.maxHp;
    player.hp = Math.min(player.hp, player.maxHp);

    this.sendPlayerState(player);
    return outcome.rank;
  }

  /** Neutral intent when the player has not sent anything recently. */
  #effectiveIntent(player: Player, now: number): InputFrame {
    if (player.intent === null) {
      return { turn: 0, throttle: 0 };
    }
    if (now - player.lastInputAt > INPUT_STALE_AFTER_MS) {
      return { turn: 0, throttle: 0 };
    }
    return player.intent;
  }

  /** Live position of an NPC by id, or `null` if it has gone. */
  #targetPoint(id: string): { x: number; y: number } | null {
    const npc = this.#world.npcs.get(id);
    return npc?.isAlive === true ? { x: npc.x, y: npc.y } : null;
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
    const world = this.#world.snapshotEntities();

    /* Every entity's wire record is built once and shared by all viewers. At 100 players
       plus 50 NPCs plus a few dozen projectiles, a per-viewer rebuild would be tens of
       thousands of allocations every 50 ms — and those allocations land inside the tick
       the player's own prediction is sensitive to. */
    const records = new Map<string, SnapshotEntity>();
    const positions = new Map<string, { id: string; x: number; y: number }>();

    const consider = (record: SnapshotEntity): void => {
      records.set(record.id, record);
      positions.set(record.id, { id: record.id, x: record.x, y: record.y });
    };

    for (const player of world.players) consider(roundEntity(player.toSnapshotEntity(tick)));

    for (const npc of world.npcs) {
      const base = npc.toSnapshotEntity();
      consider(
        roundEntity({
          ...base,
          kind: EntityKind.Npc,
          npcTier: npc.tier,
        }),
      );
    }

    for (const projectile of world.projectiles) {
      consider(
        roundEntity({
          id: projectile.id,
          x: projectile.x,
          y: projectile.y,
          rotation: 0,
          hp: 1,
          kind: EntityKind.Projectile,
        }),
      );
    }

    for (const box of world.boxes) {
      const live = this.#boxRecord(box.id);
      if (live !== null) consider(roundEntity(live));
    }

    /* MVP path: one full frame, every entity, every viewer.
       `MVP_FLAGS.interestManagement` off means no grid walk, no AoI memory and no delta
       diff — the loop simply sends the world. At this scale a full frame is a few KB per
       tick, and the trade is deliberate: an entire class of "why can't I see it" bugs
       stops existing. The AoI path below is untouched and still runs when the flag is
       on. */
    if (!MVP_FLAGS.interestManagement) {
      for (const viewer of world.players) {
        const own = records.get(viewer.id);
        if (own !== undefined) {
          records.set(viewer.id, { ...own, ackSeq: viewer.lastInputSeq });
        }

        this.#send(viewer.id, {
          v: PROTOCOL_VERSION,
          t: MessageType.SNAPSHOT,
          tick,
          serverTime: Date.now(),
          full: true,
          entities: [...records.values()],
        });
      }
      return;
    }

    for (const viewer of world.players) {
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
  const dead = player.diedAtTick !== null;

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
    /* The wire field stays a plain number so the client's reload indicator does not
       have to model "never fired" — `-1` is safely in the past for any tick. */
    lastFiredTick: player.lastFiredTick ?? -1,
    hullTier: hullTierForLevel(levelFromXp(player.xp)),
    upgradePoints: player.upgradePoints,
    shieldS: Math.round(player.shieldSeconds(tick) * 10) / 10,
    dead,
    ...(dead ? { respawnInS: Math.ceil(player.respawnInSeconds(tick)) } : {}),
  };
}

/** Snapshot coordinates are rounded so frames stay small and diffs stay readable. */
function roundEntity(entity: SnapshotEntity): SnapshotEntity {
  const factor = 10 ** SNAPSHOT_COORDINATE_DECIMALS;
  /* Spread first, then override the quantised fields. Rebuilding the object field by
     field silently drops anything added later, and it did: `kind`, `npcTier`, `boxKind`
     and `shield` were all lost here, so the client could not tell an NPC from a player
     and every hull lost its spawn-shield indicator. */
  return {
    ...entity,
    x: Math.round(entity.x * factor) / factor,
    y: Math.round(entity.y * factor) / factor,
    rotation: Math.round(entity.rotation * 1000) / 1000,
    hp: Math.round(entity.hp),
  };
}
