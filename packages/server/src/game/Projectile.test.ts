import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  PROJECTILE_LIFETIME_S,
  PROJECTILE_MAX_ALIVE,
  TICK_DURATION_S,
  WORLD_WIDTH,
} from '@warship/shared';

import { ProjectilePool } from './Projectile.js';

/**
 * Projectile pool tests.
 *
 * A fixed-capacity pool has two failure modes worth guarding: it grows past its cap under
 * load (which defeats the point of pooling), or it leaks slots so a long fight runs out of
 * ammunition that nothing can free. Both are invisible in a short playtest.
 */

function spawnAt(pool: ProjectilePool, x: number, y: number, angle = 0): void {
  pool.spawn({
    ownerId: 'p',
    ownerIsNpc: false,
    x,
    y,
    angle,
    damage: 10,
    shipMaxSpeed: 240,
  });
}

describe('Projectile — pool capacity', () => {
  test('the documented cap is the default', () => {
    assert.equal(new ProjectilePool().capacity, PROJECTILE_MAX_ALIVE);
  });

  test('heads stay in the cardinal direction they were fired', () => {
    const pool = new ProjectilePool(4);
    const east = pool.spawn({
      ownerId: 'p',
      ownerIsNpc: false,
      x: 0,
      y: 0,
      angle: 0,
      damage: 1,
      shipMaxSpeed: 240,
    });
    const north = pool.spawn({
      ownerId: 'p',
      ownerIsNpc: false,
      x: 0,
      y: 0,
      angle: Math.PI / 2,
      damage: 1,
      shipMaxSpeed: 240,
    });

    assert.notEqual(east, null);
    assert.notEqual(north, null);
    if (east === null || north === null) return;

    pool.advance();
    pool.advance();

    assert.ok(east.x > 0 && Math.abs(east.y) < 0.001, 'eastbound shot should not gain y');
    assert.ok(north.y > 0 && Math.abs(north.x) < 0.001, 'northbound shot should not gain x');
  });

  test('a full pool drops new shots instead of growing', () => {
    const pool = new ProjectilePool(3);
    for (let index = 0; index < 20; index += 1) spawnAt(pool, 0, 0);

    assert.equal(pool.liveCount, 3, 'the cap must hold under pressure');
    assert.equal(pool.droppedCount, 17, 'and every refusal must be counted, not silent');
  });

  test('dropped shots are not written into live slots', () => {
    /* The failure this catches: a full pool overwriting slot 0, so a shot in flight
       silently teleports to a new position and its owner's hit goes somewhere else. */
    const pool = new ProjectilePool(1);
    const first = pool.spawn({
      ownerId: 'p',
      ownerIsNpc: false,
      x: 100,
      y: 100,
      angle: 0,
      damage: 1,
      shipMaxSpeed: 240,
    });
    assert.notEqual(first, null);
    if (first === null) return;

    /* Remember what the slot held — `spawn` starts the shot clear of the muzzle, so the
       position is not the one passed in and the assertion has to compare against the
       actual start, not a hardcoded number. */
    const startX = first.x;
    const startY = first.y;

    spawnAt(pool, 5_000, 5_000);

    assert.equal(first.x, startX, 'the live shot must not have been overwritten');
    assert.equal(first.y, startY);
    assert.equal(first.ownerId, 'p');
  });
});

describe('Projectile — lifetime', () => {
  test('a shot expires after its lifetime', () => {
    const pool = new ProjectilePool(4);
    spawnAt(pool, 4_000, 4_000);

    const ticks = Math.ceil(PROJECTILE_LIFETIME_S / TICK_DURATION_S);
    for (let index = 0; index < ticks; index += 1) pool.advance();

    assert.equal(pool.liveCount, 0, 'the shot should be gone');
  });

  test('a shot is still alive just before its lifetime', () => {
    /* The boundary in both directions: a lifetime check that expires a tick early looks
       correct in casual play and quietly shortens every shot's reach. */
    const pool = new ProjectilePool(4);
    spawnAt(pool, 4_000, 4_000);

    const ticks = Math.floor(PROJECTILE_LIFETIME_S / TICK_DURATION_S) - 1;
    for (let index = 0; index < ticks; index += 1) pool.advance();

    assert.equal(pool.liveCount, 1, `should still be live after ${String(ticks)} ticks`);
  });

  test('a released slot is reusable at once', () => {
    const pool = new ProjectilePool(1);
    spawnAt(pool, 0, 0);
    const live = [...pool.live()];
    assert.equal(live.length, 1);

    const shot = live[0];
    assert.notEqual(shot, undefined);
    if (shot === undefined) return;
    pool.release(shot);

    assert.equal(pool.liveCount, 0);
    spawnAt(pool, 0, 0);
    assert.equal(pool.liveCount, 1, 'the freed slot should be picked up immediately');
  });

  test('releasing the same shot twice does not corrupt the count', () => {
    const pool = new ProjectilePool(2);
    spawnAt(pool, 0, 0);
    spawnAt(pool, 0, 0);
    const [first] = [...pool.live()];
    assert.notEqual(first, undefined);
    if (first === undefined) return;

    pool.release(first);
    pool.release(first);

    assert.equal(pool.liveCount, 1, 'a double release must not free a second, live slot');
  });
});

describe('Projectile — world wrapping', () => {
  test('a shot crossing the seam reappears on the far side', () => {
    const pool = new ProjectilePool(1);
    /* Start far enough inside the east edge that the muzzle is still in this world: the
       muzzle offset alone would otherwise place the shot past the seam, and the test
       would be observing the offset rather than the wrap. */
    const shot = pool.spawn({
      ownerId: 'p',
      ownerIsNpc: false,
      x: WORLD_WIDTH - 200,
      y: 500,
      angle: 0,
      damage: 1,
      shipMaxSpeed: 240,
    });
    assert.notEqual(shot, null);
    if (shot === null) return;

    /* 720 u/s for one 50 ms tick is 36 units, so from 7 800 it takes five ticks to pass
       the seam at 8 000. */
    for (let index = 0; index < 6; index += 1) pool.advance();

    assert.ok(shot.x < 1_000, `expected the shot to wrap, x is ${String(shot.x)}`);
    assert.ok(shot.x >= 0, 'and to stay inside the world');
  });

  test('the previous position is the pre-wrap one, so the sweep still crosses the seam', () => {
    /* Collision resolves against the segment, so a wrapped shot whose `previousX` was
       also wrapped would be tested as a tiny segment on the wrong side of the map. */
    const pool = new ProjectilePool(1);
    const shot = pool.spawn({
      ownerId: 'p',
      ownerIsNpc: false,
      x: WORLD_WIDTH - 200,
      y: 500,
      angle: 0,
      damage: 1,
      shipMaxSpeed: 240,
    });
    assert.notEqual(shot, null);
    if (shot === null) return;

    /* Step until the position actually wraps — `previousX` only ever holds the single
       most recent step, so advancing past the crossing would overwrite the very value
       under test. If `previousX` were wrapped too, the collision segment would be a stub
       at the west edge instead of a line crossing the seam. */
    let wrappedOn = -1;
    for (let index = 0; index < 20 && wrappedOn < 0; index += 1) {
      pool.advance();
      if (shot.x < 1_000) wrappedOn = index;
    }

    assert.ok(wrappedOn >= 0, 'the shot should have wrapped');
    assert.ok(
      shot.previousX > WORLD_WIDTH - 100,
      `previousX is ${String(shot.previousX)}, expected it just inside the east edge`,
    );
  });
});

describe('Projectile — clearing', () => {
  test('clear frees every slot', () => {
    const pool = new ProjectilePool(8);
    for (let index = 0; index < 8; index += 1) spawnAt(pool, 0, 0);
    assert.equal(pool.liveCount, 8);

    pool.clear();

    assert.equal(pool.liveCount, 0);
    for (const shot of pool.live()) assert.equal(shot.active, false);
  });

  test('clear does not touch the drop counter, which is a lifetime statistic', () => {
    /* Deliberate: `droppedCount` is how many shots the pool has ever refused, which is
       the number to look at when tuning capacity. Resetting it on a world reset would
       hide the one measurement it exists to provide. */
    const pool = new ProjectilePool(1);
    spawnAt(pool, 0, 0);
    spawnAt(pool, 0, 0);
    assert.equal(pool.droppedCount, 1);

    pool.clear();
    assert.equal(pool.droppedCount, 1);
  });

  test('snapshot entities carry the fields the client needs', () => {
    const pool = new ProjectilePool(1);
    const shot = pool.spawn({
      ownerId: 'p',
      ownerIsNpc: false,
      x: 1_234.5,
      y: 678.25,
      angle: 0,
      damage: 1,
      shipMaxSpeed: 240,
    });
    assert.notEqual(shot, null);
    if (shot === null) return;

    /* Compared against the slot, not the spawn arguments: the shot starts clear of the
       muzzle, so its position is nudged along the firing direction. */
    const entity = pool.toSnapshotEntity(shot);
    assert.equal(entity.id, shot.id);
    assert.ok(Math.abs(entity.x - shot.x) < 1e-9);
    assert.ok(Math.abs(entity.y - shot.y) < 1e-9);
    assert.ok(entity.x > 1_234.5, 'the muzzle offset should have pushed it along +x');
  });
});
