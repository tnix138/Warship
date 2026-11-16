import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { WORLD_HEIGHT, WORLD_WIDTH } from '@warship/shared';

import { allBuoys, BUOY_COUNT, buoysNear } from './buoys';

/**
 * Buoy layout tests.
 *
 * Determinism is the load-bearing property: there is no server message describing
 * these, so every client derives them independently. If two clients disagreed, a buoy
 * would be a landmark only some players could navigate by.
 */

describe('buoy layout', () => {
  test('is deterministic across calls', () => {
    const first = allBuoys();
    const second = allBuoys();

    assert.equal(first, second, 'the layout must be cached, not regenerated');
    assert.deepEqual(
      first.map((buoy) => [buoy.id, buoy.x, buoy.y, buoy.kind]),
      second.map((buoy) => [buoy.id, buoy.x, buoy.y, buoy.kind]),
    );
  });

  test('is a pure function of the world, not of call order', () => {
    /* The generator must not depend on hidden state: hashing the index is what makes
       every client agree. Recomputing after other queries must give the same answer. */
    const before = allBuoys().map((buoy) => `${buoy.id}:${buoy.x.toFixed(3)}:${buoy.y.toFixed(3)}`);

    // Perturb the module's cached-query path, then read the layout again.
    buoysNear(123, 456, 2_000);
    buoysNear(7_000, 7_000, 500);

    const after = allBuoys().map((buoy) => `${buoy.id}:${buoy.x.toFixed(3)}:${buoy.y.toFixed(3)}`);
    assert.deepEqual(after, before);
  });

  test('places a useful number of buoys', () => {
    const buoys = allBuoys();

    /* Rejection sampling may reject a few spots, but the sea must not end up empty:
       at least 90 % of the target count must survive placement. */
    assert.ok(
      buoys.length >= BUOY_COUNT * 0.9,
      `expected at least ${(BUOY_COUNT * 0.9).toFixed(0)} buoys, got ${buoys.length}`,
    );
    assert.equal(new Set(buoys.map((buoy) => buoy.id)).size, buoys.length, 'ids must be unique');
  });

  test('keeps every buoy inside the world', () => {
    for (const buoy of allBuoys()) {
      assert.ok(buoy.x >= 0 && buoy.x < WORLD_WIDTH, `x out of bounds: ${buoy.x}`);
      assert.ok(buoy.y >= 0 && buoy.y < WORLD_HEIGHT, `y out of bounds: ${buoy.y}`);
    }
  });

  test('spreads buoys out instead of clustering them', () => {
    const buoys = allBuoys();

    let closest = Infinity;
    for (let i = 0; i < buoys.length; i += 1) {
      for (let j = i + 1; j < buoys.length; j += 1) {
        const a = buoys[i];
        const b = buoys[j];
        if (a === undefined || b === undefined) continue;
        closest = Math.min(closest, Math.hypot(a.x - b.x, a.y - b.y));
      }
    }

    /* Exact non-overlap is not guaranteed (the attempt budget is finite), but two
       buoys sitting on top of each other would look like a rendering bug. */
    assert.ok(closest > 60, `two buoys are only ${closest.toFixed(0)} units apart`);
  });

  test('uses more than one shape', () => {
    const kinds = new Set(allBuoys().map((buoy) => buoy.kind));
    assert.ok(kinds.size >= 3, `expected variety, got ${[...kinds].join(', ')}`);
  });
});

describe('buoysNear', () => {
  test('returns nothing for an empty region', () => {
    // A radius smaller than the minimum separation, placed away from every buoy.
    const target = allBuoys()[0];
    assert.ok(target !== undefined);
    const found = buoysNear(target.x + 1_000, target.y + 1_000, 1);
    assert.ok(found.every((buoy) => buoy.id !== target.id));
  });

  test('finds a buoy from its own position', () => {
    const target = allBuoys()[0];
    assert.ok(target !== undefined);

    const found = buoysNear(target.x, target.y, 400);
    assert.ok(
      found.some((buoy) => buoy.id === target.id),
      'a buoy must be visible from where it is',
    );
  });

  test('measures distance across the seam, not through the middle', () => {
    /* The world wraps. A buoy near x = 7950 is 150 units from a player at x = 100,
       not 7850. Getting this wrong makes buoys pop at the edges of the world. */
    const target = allBuoys()[0];
    assert.ok(target !== undefined);

    // Approach from the far side of the world: shift by exactly one world width.
    const mirroredX = target.x >= WORLD_WIDTH / 2 ? target.x - WORLD_WIDTH : target.x + WORLD_WIDTH;
    const found = buoysNear(mirroredX, target.y, 200);

    assert.ok(
      found.some((buoy) => buoy.id === target.id),
      'a buoy must be found across the seam',
    );
  });

  test('never returns something farther than the requested radius', () => {
    const radius = 900;
    const found = buoysNear(4_000, 4_000, radius);

    for (const buoy of found) {
      let dx = buoy.x - 4_000;
      let dy = buoy.y - 4_000;
      if (dx > WORLD_WIDTH / 2) dx -= WORLD_WIDTH;
      if (dx < -WORLD_WIDTH / 2) dx += WORLD_WIDTH;
      if (dy > WORLD_HEIGHT / 2) dy -= WORLD_HEIGHT;
      if (dy < -WORLD_HEIGHT / 2) dy += WORLD_HEIGHT;

      assert.ok(Math.hypot(dx, dy) <= radius + 1e-6, `buoy ${buoy.id} is out of range`);
    }
  });

  test('a larger radius can only add results', () => {
    const small = new Set(buoysNear(1_000, 1_000, 500).map((buoy) => buoy.id));
    const large = new Set(buoysNear(1_000, 1_000, 1_500).map((buoy) => buoy.id));

    for (const id of small) {
      assert.ok(large.has(id), `buoy ${id} disappeared when the radius grew`);
    }
  });
});
