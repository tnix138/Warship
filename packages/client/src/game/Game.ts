import { Application } from 'pixi.js';

import {
  CLIENT_INPUT_RATE,
  MVP_FLAGS,
  RENDER_BACKGROUND_COLOR,
  RENDER_MAX_DPR,
  ShipClass,
  type EventKind,
  type InputFrame,
  type PlayerStateMessage,
  type SnapshotMessage,
} from '@warship/shared';

import { ClientWorld } from './World';
import { InputController } from './Input';
import { Connection } from '../net/Connection';
import { loadTextures } from '../render/assets';
import { Camera } from '../render/camera';
import { CombatRenderer } from '../render/CombatRenderer';
import { EntityRenderer } from '../render/EntityRenderer';
import { Ocean } from '../render/ocean';
import { WorldObjects } from '../render/WorldObjects';
import { GameHud } from '../ui/GameHud';
import { Minimap } from '../ui/Minimap';
import { FA } from '../ui/strings.fa';

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

  /* The radar is DOM/Canvas, not Pixi: it lives beside the app rather than in the scene
     graph, because it must not pan, zoom or rotate with the camera. */
  const minimapCanvas = document.getElementById('minimap-canvas');
  const minimap = minimapCanvas instanceof HTMLCanvasElement ? new Minimap(minimapCanvas) : null;
  const onResize = (): void => {
    minimap?.resize();
  };
  window.addEventListener('resize', onResize);
  const world = new ClientWorld();
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
      },
      onSnapshot: (snapshot: SnapshotMessage) => {
        world.applySnapshot(snapshot);

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

    while (inputAccumulator >= inputIntervalS) {
      inputAccumulator -= inputIntervalS;
      sequence += 1;
      sampledFrame = input.snapshot();

      connection.sendInput(sequence, world.tick, sampledFrame);
      hud.setInputState(sampledFrame, sequence);
    }

    /* Clicks become target requests. Done here rather than in `Input` because only this
       layer has the camera and the current snapshot to hit-test against. */
    for (const click of input.drainClicks()) {
      const point = camera.screenToWorld(click.x, click.y);
      connection.sendTarget(world.npcAt(point.x, point.y));
    }

    /* No prediction: the local ship is drawn exactly where the server says it is. The
       camera still follows it, which is what keeps input feeling connected even though
       the pose is one tick old. */
    const focus = world.self;

    if (focus !== undefined && lastSelf?.dead !== true) {
      if (Math.hypot(camera.x - focus.x, camera.y - focus.y) > CAMERA_SNAP_DISTANCE) {
        camera.focusOn(focus.x, focus.y);
      } else {
        camera.follow(focus.x, focus.y, Math.min(deltaMS / 1000, 0.25));
      }
    }

    /* World feel: off in the MVP. */
    worldObjects?.update(now, camera.viewport, null);

    /* Draw the last snapshot verbatim. No interpolation, no prediction: the server is
       the only thing that decides where a ship is. */
    const renderList = world.renderEntitiesNow();
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
      },
      now,
    );

    minimap?.update(world, now);
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
      window.removeEventListener('resize', onResize);
      minimap?.destroy();
      hud.destroy();
      app.destroy(true, { children: true });
    },
  };
}

/** Short, player-facing text for a server event. */
function describeEvent(
  kind: EventKind,
  data: { readonly amount?: number; readonly level?: number } | undefined,
): string {
  switch (kind) {
    case 'kill': {
      return FA.evKill;
    }
    case 'levelup': {
      return FA.evLevelUp(data?.level ?? 0);
    }
    case 'damaged': {
      return FA.evDamaged(data?.amount ?? 0);
    }
    case 'pickup': {
      return FA.evPickup;
    }
    case 'join': {
      return FA.evJoin;
    }
    case 'leave': {
      return FA.evLeave;
    }
    default: {
      return kind;
    }
  }
}
