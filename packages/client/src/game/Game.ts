import { Application } from 'pixi.js';

import {
  CLIENT_INPUT_RATE,
  computeShipStats,
  RENDER_BACKGROUND_COLOR,
  RENDER_MAX_DPR,
  ShipClass,
  type EventKind,
  type SnapshotMessage,
} from '@warship/shared';

import { ClientWorld } from './World';
import { Prediction } from './Prediction';
import { InputController } from './Input';
import { Connection } from '../net/Connection';
import { loadTextures } from '../render/assets';
import { Camera } from '../render/camera';
import { EntityRenderer } from '../render/EntityRenderer';
import { Ocean } from '../render/ocean';
import { GameHud } from '../ui/GameHud';

/**
 * The client game.
 *
 * Once per frame:
 *
 *   input (WASD + pointer) ──20 Hz──▶ INPUT frames ──▶ server
 *   server ──20 Hz──▶ SNAPSHOT ──▶ ClientWorld ──▶ EntityRenderer ──▶ screen
 *
 * The client never simulates movement. It renders whatever the latest snapshot said,
 * which is exactly the "no interpolation, no prediction" scope of this milestone;
 * the camera eases toward the local ship so a 20 Hz feed still reads smoothly.
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

  const entities = new EntityRenderer(textures);
  camera.world.addChild(entities.view);

  const input = new InputController(options.canvas);

  /* Camera controls. Wheel zoom is the only one that composes with a following
     camera; see `Camera.attachZoom`. */
  const detachZoom = camera.attachZoom(options.canvas);

  let joined = false;
  let sequence = 0;
  let inputAccumulator = 0;
  const inputIntervalS = 1 / CLIENT_INPUT_RATE;

  const connection = new Connection({
    url: options.socketUrl,
    listeners: {
      onStateChange: (state) => {
        hud.setConnectionState(state);
      },
      onWelcome: (welcome) => {
        hud.setServerInfo(welcome);
        if (joined) return;
        joined = true;
        // The socket is live and the server has spoken v2: ask to enter the world.
        connection.join(options.shipClass ?? ShipClass.Normal);
      },
      onPlayerState: (state) => {
        // The first PLAYER_STATE tells us which entity is ours.
        world.selfId = state.entityId;
        hud.updateSelf(state);

        // Prediction must integrate with exactly the server's numbers, or the two
        // drift apart and every reconciliation becomes a correction.
        prediction.setStats({
          maxSpeed: computeShipStats(state.shipClass).maxSpeed,
          turnRate: computeShipStats(state.shipClass).turnRate,
        });
      },
      onSnapshot: (snapshot: SnapshotMessage) => {
        world.applySnapshot(snapshot);

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
          });
        }

        hud.setEntityCount(world.size, snapshot.tick, snapshot.full);
      },
      onEvent: (event) => {
        hud.pushEvent(describeEvent(event.kind, event.data));
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
    const deltaS = deltaMS / 1000;

    /* Viewport: the window can resize at any time. */
    const width = app.screen.width;
    const height = app.screen.height;
    camera.setViewport(width, height);
    ocean.resize(width, height);

    /* Input: sample the devices, ship at most one INPUT frame per tick. */
    inputAccumulator += deltaS;
    if (inputAccumulator > inputIntervalS * 4) inputAccumulator = inputIntervalS * 4;

    while (inputAccumulator >= inputIntervalS) {
      inputAccumulator -= inputIntervalS;
      sequence += 1;
      const frame = input.snapshot(aimAt(input, camera, world));

      // Predict the same input locally *before* it goes on the wire, so the ship
      // reacts on this frame rather than one round-trip later.
      prediction.applyInput(sequence, frame, now);
      connection.sendInput(sequence, world.tick, frame);
      hud.setInputState(frame, sequence);
    }

    /* Camera: follow the *predicted* ship, which is where the player believes they
       are; following the authoritative pose would lag one round-trip behind. */
    const authoritative = world.self;
    const predicted = prediction.ready
      ? { x: prediction.actor.x, y: prediction.actor.y }
      : authoritative;

    if (predicted !== undefined) {
      if (Math.hypot(camera.x - predicted.x, camera.y - predicted.y) > CAMERA_SNAP_DISTANCE) {
        camera.focusOn(predicted.x, predicted.y);
      } else {
        camera.follow(predicted.x, predicted.y, deltaS);
      }
    }

    /* Draw: interpolated poses for everyone else, predicted pose for us. */
    const renderList = world.renderEntities(now, prediction.ready ? prediction.actor : undefined);
    entities.update(renderList, now);
    ocean.update(deltaMS);
    hud.updateDebug(
      {
        fps: app.ticker.FPS,
        zoom: camera.zoom,
        cameraX: camera.x,
        cameraY: camera.y,
        rendererName: app.renderer.name,
        entities: entities.drawnCount,
        tick: world.tick,
        buffered: world.interpolation.bufferedFrames,
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
