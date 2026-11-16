import './styles.css';

import { ShipClass } from '@warship/shared';

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

  // The debug panel is a development tool; production builds ship without it.
  if (!import.meta.env.DEV) {
    document.getElementById('debug-panel')?.setAttribute('hidden', '');
  }

  const game = await createGame({ canvas, shipClass: requestedShipClass() });

  // Vite HMR: tear the renderer down cleanly so we do not leak WebGL contexts.
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      game.destroy();
    });
  }
}

void bootstrap();
