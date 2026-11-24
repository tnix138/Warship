import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { SPAWN_CENTER_X, SPAWN_CENTER_Y } from './constants.js';
import { ISLANDS, resolveIslandCollision } from './islands.js';

describe('islands', () => {
  test('islands are clear of the central spawn area', () => {
    assert.ok(ISLANDS.length > 0);
    for (const island of ISLANDS) {
      const dx = island.x - SPAWN_CENTER_X;
      const dy = island.y - SPAWN_CENTER_Y;
      const dist = Math.hypot(dx, dy);
      assert.ok(dist >= island.radius + 500);
    }
  });

  test('resolveIslandCollision pushes overlapping entity outside island', () => {
    const island = ISLANDS[0]!;
    const res = resolveIslandCollision(island.x + 10, island.y, 20);
    assert.equal(res.collided, true);
    const dist = Math.hypot(res.x - island.x, res.y - island.y);
    assert.ok(Math.abs(dist - (island.radius + 20)) < 0.001);
  });

  test('resolveIslandCollision leaves non-overlapping entity untouched', () => {
    const res = resolveIslandCollision(SPAWN_CENTER_X, SPAWN_CENTER_Y, 20);
    assert.equal(res.collided, false);
    assert.equal(res.x, SPAWN_CENTER_X);
    assert.equal(res.y, SPAWN_CENTER_Y);
  });
});
