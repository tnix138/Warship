import './styles.css';

import { MVP_FLAGS, ShipClass } from '@warship/shared';

import { createGame } from './game/Game';
import { installErrorOverlay } from './util/overlay';

/**
 * Client entry point.
 *
 * Boots PixiJS, loads the textures, connects to the game server and hands control
 * to the game loop. Before Milestone 2 this file rendered a scripted demo ship;
 * now every ship on screen comes from a server snapshot.
 */

/** `?ship=speed|normal|power` picks the class to request on join. */
function requestedShipClass(): ShipClass {
  const requested = new URLSearchParams(window.location.search).get('ship');
  if (requested === 'speed') return ShipClass.Speed;
  if (requested === 'power') return ShipClass.Power;
  return ShipClass.Normal;
}

async function bootstrap(): Promise<void> {
  installErrorOverlay();

  const canvas = document.getElementById('game-canvas');
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error('#game-canvas is missing or is not a <canvas> element');
  }

  /* The debug panel is a development tool: hidden by default (it would otherwise sit on
     top of the radar), toggled with the backtick key. Production builds never mount it. */
  installDebugToggle();

  const game = await createGame({ canvas, shipClass: requestedShipClass() });

  // Vite HMR: tear the renderer down cleanly so we do not leak WebGL contexts.
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      game.destroy();
    });
  }
}

/**
 * Toggle the debug panel with the backtick key.
 *
 * A key rather than a visible button: this is a developer tool, and a permanent control
 * for it on a player's screen is clutter that never earns its space. `Backquote` is read
 * from `event.code` so it is the same physical key on every keyboard layout — the same
 * reason the movement keys use `code` and not `key`.
 */
function installDebugToggle(): void {
  const panel = document.getElementById('debug-panel');
  if (panel === null) return;

  if (!import.meta.env.DEV) return;

  window.addEventListener('keydown', (event) => {
    if (event.code !== 'Backquote') return;
    /* Never steal the key from a text field the HUD may add later. */
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable || target.tagName === 'INPUT')) {
      return;
    }
    event.preventDefault();
    panel.classList.toggle('is-open');
  });

  /* The advanced rows are a separate concern from the panel being open: the panel shows
     fps/entities/tick always, and the extra rows only with the `advancedDebug` flag. */
  if (MVP_FLAGS.advancedDebug) panel.classList.add('is-advanced');
}

void bootstrap();
