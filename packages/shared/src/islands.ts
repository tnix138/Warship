import { SPAWN_CENTER_X, SPAWN_CENTER_Y, WORLD_HEIGHT, WORLD_WIDTH } from './constants.js';

export interface Island {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

/**
 * Deterministic island layout shared between the authoritative server and client.
 * Kept clear of the central spawn ring so ships never spawn on land.
 */
export const ISLANDS: readonly Island[] = [
  { id: 1, x: 1600, y: 1600, radius: 220 },
  { id: 2, x: 6400, y: 1600, radius: 260 },
  { id: 3, x: 1600, y: 6400, radius: 240 },
  { id: 4, x: 6400, y: 6400, radius: 210 },
  { id: 5, x: 2600, y: 3900, radius: 180 },
  { id: 6, x: 5400, y: 4100, radius: 190 },
  { id: 7, x: 4000, y: 2100, radius: 200 },
  { id: 8, x: 4000, y: 5900, radius: 200 },
  { id: 9, x: 900, y: 4000, radius: 170 },
  { id: 10, x: 7100, y: 4000, radius: 170 },
].filter((island) => {
  const dx = island.x - SPAWN_CENTER_X;
  const dy = island.y - SPAWN_CENTER_Y;
  const distSq = dx * dx + dy * dy;
  const minClear = island.radius + 500;
  return (
    distSq >= minClear * minClear &&
    island.x - island.radius > 0 &&
    island.x + island.radius < WORLD_WIDTH &&
    island.y - island.radius > 0 &&
    island.y + island.radius < WORLD_HEIGHT
  );
});

export function resolveIslandCollision(
  x: number,
  y: number,
  entityRadius: number,
  islands: readonly Island[] = ISLANDS,
): { x: number; y: number; collided: boolean } {
  let outX = x;
  let outY = y;
  let collided = false;

  for (const island of islands) {
    const dx = outX - island.x;
    const dy = outY - island.y;
    const minDist = island.radius + entityRadius;
    const distSq = dx * dx + dy * dy;
    if (distSq < minDist * minDist) {
      collided = true;
      const dist = Math.sqrt(distSq);
      if (dist > 0.0001) {
        const push = minDist / dist;
        outX = island.x + dx * push;
        outY = island.y + dy * push;
      } else {
        outX = island.x + minDist;
      }
    }
  }

  return { x: outX, y: outY, collided };
}
