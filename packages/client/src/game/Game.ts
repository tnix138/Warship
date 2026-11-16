import { Application } from 'pixi.js';

import {
  CLIENT_INPUT_RATE,
  MVP_FLAGS,
  computeShipStats,
  RENDER_BACKGROUND_COLOR,
  RENDER_MAX_DPR,
  ShipClass,
  type EventKind,
  type InputFrame,
  type PlayerStateMessage,
  type SnapshotMessage,
} from '@warship/shared';

import { ClientWorld } from './World';
import { Prediction } from './Prediction';
import { InputController } from './Input';
import { Connection } from '../net/Connection';
import { loadTextures } from '../render/assets';
import { Camera } from '../render/camera';
import { CombatRenderer } from '../render/CombatRenderer';
import { EntityRenderer } from '../render/EntityRenderer';
import { Ocean } from '../render/ocean';
import { WorldObjects } from '../render/WorldObjects';
import { GameHud } from '../ui/GameHud';

/**
 * The client game.
 *
 * The MVP path is deliberately short. Once per frame:
 *
 *   input (WASD + pointer) ──20 Hz──▶ INPUT frames ──▶ server
 *   server ──20 Hz──▶ SNAPSHOT ──▶ ClientWorld ──▶ renderers ──▶ screen
 *
 * There is no prediction and no interpolation: every ship is drawn where the last
 * snapshot said it was, and the camera eases toward it. That is a conscious trade —
 * see `MVP_FLAGS` — and both subsystems still exist behind their flags for when the
 * game is playable enough to deserve them.
 */

export interface GameOptions {
  readonly canvas: HTMLCanvasElement;
  /** Ship class requested on join. */
  readonly shipClass?: ShipClass;
  /** Override the socket URL; defaults to same-origin `/ws`. */
  readonly socketUrl?: string;
}

export interface Game {
  destroy(): void;
}

/** Snap the camera instead of easing when the ship moves further than this. */
const CAMERA_SNAP_DISTANCE = 2_000;

export async function createGame(options: GameOptions): Promise<Game> {
  const textures = await loadTextures();

  const app = new Application();
  await app.init({
    canvas: options.canvas,
    antialias: true,
    backgroundColor: RENDER_BACKGROUND_COLOR,
    resolution: Math.min(window.devicePixelRatio, RENDER_MAX_DPR),
    autoDensity: true,
    resizeTo: window,
  });

  const hud = new GameHud();
  const world = new ClientWorld();
  const prediction = new Prediction();
  const camera = new Camera();
  const ocean = new Ocean(textures.water, app.screen.width, app.screen.height);

  app.stage.addChild(ocean.view, camera.world);

  /* Parallax off: the water is a still colour. */
  if (!MVP_FLAGS.worldDecoration) ocean.freeze();

  /* Sea marks, wake and grid: off in the MVP. They exist to make speed legible, but
     the water is a still colour without the parallax that gave them something to move
     against, so they would be decoration on decoration. */
  let worldObjects: WorldObjects | null = null;
  if (MVP_FLAGS.worldDecoration) {
    worldObjects = new WorldObjects();
    camera.world.addChild(worldObjects.view);
  }

  const entities = new EntityRenderer(textures);
  camera.world.addChild(entities.view);

  /* NPC hulls, shots and crates. Above the ships so a tracer reads as passing over a
     deck, and in world space so they pan and zoom with everything else. */
  const combat = new CombatRenderer();
  camera.world.addChild(combat.view);

  const input = new InputController(options.canvas);

  /* Camera controls. Wheel zoom is the only one that composes with a following
     camera; see `Camera.attachZoom`. */
  const detachZoom = camera.attachZoom(options.canvas);

  let joined = false;
  /** Newest private state, for the upgrade modal's rank labels. */
  let lastSelf: PlayerStateMessage | null = null;
  /** Seconds spent dead, for a smooth countdown between sparse PLAYER_STATE frames. */
  let deadForS = 0;
  let sequence = 0;
  let inputAccumulator = 0;
  const inputIntervalS = 1 / CLIENT_INPUT_RATE;

  const connection = new Connection({
    url: options.socketUrl,
    listeners: {
      onStateChange: (state) => {
        hud.setConnectionState(state);

        /* A fatal close (protocol mismatch, server full) must be shown verbatim:
           the ship controls silently stop working otherwise, which looks exactly
           like an input bug. */
        const fatal = connection.fatalReason;
        if (fatal !== null) hud.setConnectionError(fatal);
      },
      onWelcome: (welcome) => {
        hud.setServerInfo(welcome);
        if (joined) return;
        joined = true;
        // The socket is live and the server has spoken: ask to enter the world.
        connection.join(options.shipClass ?? ShipClass.Normal);
      },
      onPlayerState: (state) => {
        // The first PLAYER_STATE tells us which entity is ours.
        world.selfId = state.entityId;
        /* Re-anchor the death clock on every authoritative state: this is what keeps
           the countdown honest if a packet is late or lost. */
        lastSelf = state;
        deadForS = 0;
        hud.updateSelf(state);

        // Prediction must integrate with exactly the server's numbers, or the two
        // drift apart and every reconciliation becomes a correction.
        if (MVP_FLAGS.prediction) {
          prediction.setStats({
            maxSpeed: computeShipStats(state.shipClass).maxSpeed,
            turnRate: computeShipStats(state.shipClass).turnRate,
          });
        }
      },
      onSnapshot: (snapshot: SnapshotMessage) => {
        world.applySnapshot(snapshot);

        if (MVP_FLAGS.prediction) {
          /* Reconcile prediction against the authority. `ackSeq` rides on our own
             entity, so it arrives exactly once per snapshot. */
          const self = world.self;
          if (self !== undefined) {
            const result = prediction.reconcile(
              { x: self.x, y: self.y, rotation: self.rotation },
              self.ackSeq ?? 0,
            );
            hud.setPredictionStats({
              pending: prediction.pendingCount,
              corrections: prediction.correctionCount,
              error: result.error,
              largest: prediction.largestCorrection,
              recent: prediction.recentCorrections,
              buffered: world.interpolation.bufferedFrames,
              delayMs: world.interpolation.delayMs,
              correcting: prediction.correcting,
              offset: prediction.offset,
              offsetRotation: prediction.offsetRotation,
              maxOffset: prediction.maxOffset,
              easeTau: prediction.easeTau,
            });
          }
        }

        hud.setEntityCount(world.size, snapshot.tick, snapshot.full);
      },
      onEvent: (event) => {
        hud.pushEvent(describeEvent(event.kind, event.data));

        /* A level-up is the one event that needs a decision, so it opens the picker.
           The server sent the choices; the HUD only renders them. */
        if (event.kind === 'levelup') {
          const choices = event.data?.choices ?? [];
          const owned = event.data?.upgrades ?? lastSelf?.upgrades ?? {};
          hud.showUpgrades({
            points: event.data?.upgradePoints ?? 1,
            offers: choices.map((id) => ({
              upgradeId: id,
              rank: (owned[id] ?? 0) + 1,
            })),
            onChoose: (upgradeId) => {
              connection.sendUpgrade(upgradeId);
              hud.hideUpgrades();
            },
          });
        }
      },
      onError: (error) => {
        // A dropped socket is recoverable (the connection retries); never fatal.
        console.warn('[net]', error.message);
      },
    },
  });

  connection.connect();

  /* ------------------------------------------------------------------------ */
  /*  Frame loop                                                              */
  /* ------------------------------------------------------------------------ */

  let lastNow = performance.now();

  const tick = (): void => {
    const now = performance.now();
    const deltaMS = Math.min(now - lastNow, 250); // clamp after a background tab
    lastNow = now;

    /* Viewport: the window can resize at any time. */
    const width = app.screen.width;
    const height = app.screen.height;
    camera.setViewport(width, height);
    ocean.resize(width, height);

    /* Death countdown: interpolated locally between PLAYER_STATE frames so the number
       ticks down smoothly. Each frame we step it, and the next authoritative state
       re-anchors it, so a dropped packet cannot leave it stuck. */
    if (lastSelf?.dead === true) {
      deadForS += deltaMS / 1000;
      hud.updateDeathCountdown(Math.max(0, (lastSelf.respawnInS ?? 0) - deadForS));
    }

    /* Input: sample the devices, ship at most one INPUT frame per tick. */
    inputAccumulator += Math.min(deltaMS / 1000, 0.25);
    if (inputAccumulator > inputIntervalS * 4) inputAccumulator = inputIntervalS * 4;

    let sampledFrame: InputFrame | null = null;
    let sampledSeq = sequence;

    while (inputAccumulator >= inputIntervalS) {
      inputAccumulator -= inputIntervalS;
      sequence += 1;
      sampledFrame = input.snapshot(aimAt(input, camera, world));
      sampledSeq = sequence;

      connection.sendInput(sequence, world.tick, sampledFrame);
      hud.setInputState(sampledFrame, sequence);
    }

    /* Prediction: off in the MVP, so the local ship is drawn where the server says it
       is. The camera still follows it, which is what keeps input feeling connected
       even though the pose is one tick old. */
    if (MVP_FLAGS.prediction) {
      prediction.update(Math.min(deltaMS / 1000, 0.25), sampledFrame, sampledSeq);
    }

    const authoritative = world.self;
    const focus = MVP_FLAGS.prediction && prediction.ready ? prediction.actor : authoritative;

    if (focus !== undefined && lastSelf?.dead !== true) {
      if (Math.hypot(camera.x - focus.x, camera.y - focus.y) > CAMERA_SNAP_DISTANCE) {
        camera.focusOn(focus.x, focus.y);
      } else {
        camera.follow(focus.x, focus.y, Math.min(deltaMS / 1000, 0.25));
      }
    }

    /* World feel: off in the MVP. */
    worldObjects?.update(now, camera.viewport, MVP_FLAGS.prediction ? prediction.actor : null);

    /* Draw: interpolated poses when enabled, otherwise the last snapshot verbatim. */
    const renderList = MVP_FLAGS.prediction
      ? world.renderEntities(now, prediction.actor)
      : world.renderEntitiesNow();
    entities.update(renderList, now);
    combat.update(renderList, now);
    /* Feed the ship's speed so the surface streams past in proportion to travel. With
       decoration off the parallax is stilled below, so this is a no-op. */
    ocean.update(deltaMS, 0);

    hud.updateDebug(
      {
        fps: app.ticker.FPS,
        zoom: camera.zoom,
        cameraX: camera.x,
        cameraY: camera.y,
        rendererName: app.renderer.name,
        entities: entities.drawnCount + combat.drawnCount,
        tick: world.tick,
        buffered: MVP_FLAGS.interpolation ? world.interpolation.bufferedFrames : 0,
      },
      now,
    );

    app.render();
  };

  app.ticker.add(tick);

  return {
    destroy(): void {
      connection.disconnect();
      detachZoom();
      input.destroy();
      entities.destroy();
      combat.destroy();
      worldObjects?.destroy();
      hud.destroy();
      app.destroy(true, { children: true });
    },
  };
}

/** Project the pointer into world space and turn it into an aim angle. */
function aimAt(input: InputController, camera: Camera, world: ClientWorld): number | null {
  const self = world.self;
  if (self === undefined || !input.pointer.inside) return null;

  const target = camera.screenToWorld(input.pointer.x, input.pointer.y);
  return Math.atan2(target.y - self.y, target.x - self.x);
}

/** Short, player-facing text for a server event. */
function describeEvent(
  kind: EventKind,
  data: { readonly amount?: number; readonly level?: number } | undefined,
): string {
  switch (kind) {
    case 'kill': {
      return 'Ship destroyed';
    }
    case 'levelup': {
      return `Level up → ${String(data?.level ?? '?')}`;
    }
    case 'damaged': {
      return `-${String(data?.amount ?? 0)} hull`;
    }
    case 'pickup': {
      return 'Box collected';
    }
    case 'join': {
      return 'Ship entered the water';
    }
    case 'leave': {
      return 'Ship left the water';
    }
    default: {
      return kind;
    }
  }
}
