import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  AOI_INTEREST_RADIUS,
  GRID_COLUMNS,
  GRID_SIZE,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  gridCellOf,
} from '@warship/shared';

import {
  cellsSpannedBy,
  createAoiState,
  entitiesNear,
  isUnchanged,
  updateAoi,
  wrappedDistanceSquared,
  type AoiEntity,
} from './AoI.js';
import { SpatialGrid } from './Grid.js';

/**
 * AoI unit tests.
 *
 * AoI is the one place in the server where a subtle mistake is invisible in play:
 * a ship that should be visible simply never appears. So these tests pin down the
 * geometry (cells, radius, the toroidal seam) rather than just "it returns something".
 */

/** Build a grid + position map from a list of entities. */
function build(entities: readonly AoiEntity[]): {
  grid: SpatialGrid;
  positions: Map<string, AoiEntity>;
} {
  const grid = new SpatialGrid();
  const positions = new Map<string, AoiEntity>();
  for (const entity of entities) {
    grid.upsert(entity);
    positions.set(entity.id, entity);
  }
  return { grid, positions };
}

describe('AoI grid geometry', { concurrency: 1 }, () => {
  test('a radius larger than one cell spans 5x5 cells, not 3x3', () => {
    // 3000 / 2000 = 1.5 -> ceil 2 -> (2*2+1)^2 = 25 cells.
    assert.equal(cellsSpannedBy(AOI_INTEREST_RADIUS), 25);
    // A radius below the cell size still touches the 3x3 neighbourhood.
    assert.equal(cellsSpannedBy(GRID_SIZE), 9);
    assert.equal(cellsSpannedBy(1), 9);
  });

  test('cells wrap around the world seam', () => {
    const { grid, positions } = build([
      // x=10 is in column 0; x=7990 is in column 3. They are 20 units apart because
      // the world is a torus.
      { id: 'left', x: 10, y: 4_000 },
      { id: 'right', x: 7_990, y: 4_000 },
    ]);

    const seen = entitiesNear(grid, positions, { id: 'left', x: 10, y: 4_000 }, 100);
    const ids = seen.map((entity) => entity.id);

    assert.ok(ids.includes('left'));
    assert.ok(ids.includes('right'), 'the torus seam must not hide a neighbour 20 units away');
  });

  test('wrappedDistanceSquared measures across the seam, not through the middle', () => {
    // 20 units apart across the seam...
    const near = wrappedDistanceSquared({ x: 10, y: 0 }, { x: WORLD_WIDTH - 10, y: 0 });
    assert.equal(near, 400);

    // ...and the naive straight-line distance would be ~7980.
    const naive = Math.abs(10 - (WORLD_WIDTH - 10));
    assert.ok(naive > 7_000, 'sanity: the unwrapped distance really is huge');

    // A point on the opposite side is half a world away.
    const far = wrappedDistanceSquared({ x: 0, y: 0 }, { x: WORLD_WIDTH / 2, y: 0 });
    assert.equal(far, (WORLD_WIDTH / 2) ** 2);
  });

  test('the result is a circle, not a square block of cells', () => {
    const origin = { id: 'me', x: 4_000, y: 4_000 };

    // A point inside the cell block but outside the radius (corner of a covered
    // cell, ~2800 units on each axis -> 3960 diagonal > 3000).
    const corner = { id: 'corner', x: 4_000 + 2_800, y: 4_000 + 2_800 };
    // A point directly at 90% of the radius.
    const inside = { id: 'inside', x: 4_000 + 2_700, y: 4_000 };

    const { grid, positions } = build([origin, corner, inside]);
    const ids = entitiesNear(grid, positions, origin).map((entity) => entity.id);

    assert.ok(ids.includes('inside'), 'a point within the radius must be visible');
    assert.ok(
      !ids.includes('corner'),
      'a point in the covered cells but outside the circle must not',
    );
  });

  test('an entity exactly on the radius boundary is included', () => {
    const origin = { id: 'me', x: 4_000, y: 4_000 };
    const edge = { id: 'edge', x: 4_000 + AOI_INTEREST_RADIUS, y: 4_000 };

    const { grid, positions } = build([origin, edge]);
    const ids = entitiesNear(grid, positions, origin).map((entity) => entity.id);

    assert.ok(ids.includes('edge'), 'the boundary belongs to the area of interest');
  });
});

describe('AoI visibility tracking', { concurrency: 1 }, () => {
  test('an entity that leaves range is reported as removed exactly once', () => {
    const state = createAoiState();
    const origin = { id: 'me', x: 4_000, y: 4_000 };

    // Initial view: a neighbour right next to us.
    const near = build([origin, { id: 'other', x: 4_100, y: 4_000 }]);
    const first = updateAoi(state, near.grid, near.positions, origin);
    assert.equal(first.visible.length, 2);
    assert.equal(first.removed.length, 0);

    // The neighbour runs away, far outside the interest radius.
    const far = build([origin, { id: 'other', x: 4_000, y: 4_000 + AOI_INTEREST_RADIUS + 1_000 }]);
    const second = updateAoi(state, far.grid, far.positions, origin);

    assert.equal(second.visible.length, 1, 'only the viewer remains visible');
    assert.deepEqual(
      second.removed.map((entry) => entry.id),
      ['other'],
      'the departing entity must be named in `removed`',
    );

    // And it must not be repeated on the following tick.
    const third = updateAoi(state, far.grid, far.positions, origin);
    assert.equal(third.removed.length, 0, 'a removal is reported once, not every tick');
  });

  test('staying in range never produces a removal', () => {
    const state = createAoiState();
    const origin = { id: 'me', x: 4_000, y: 4_000 };

    for (let step = 0; step < 10; step += 1) {
      const built = build([origin, { id: 'other', x: 4_100 + step, y: 4_000 }]);
      const result = updateAoi(state, built.grid, built.positions, origin);
      assert.equal(result.removed.length, 0);
      assert.equal(result.visible.length, 2);
    }
  });

  test('crowding 20 players only shows the ones inside the radius', () => {
    const origin = { id: 'me', x: 4_000, y: 4_000 };
    const entities: AoiEntity[] = [origin];

    // 10 players in a tight cluster (well inside the radius)...
    for (let index = 0; index < 10; index += 1) {
      entities.push({ id: `near-${String(index)}`, x: 4_000 + index * 100, y: 4_000 });
    }
    // ...and 9 players scattered outside it.
    for (let index = 0; index < 9; index += 1) {
      entities.push({
        id: `far-${String(index)}`,
        x: 4_000,
        y: 4_000 + AOI_INTEREST_RADIUS + 500 + index * 100,
      });
    }

    const { grid, positions } = build(entities);
    const visible = entitiesNear(grid, positions, origin);

    assert.equal(visible.length, 11, 'the viewer plus the 10 nearby players');
    assert.ok(visible.length < entities.length, 'and strictly fewer than everyone');
    assert.ok(
      !visible.some((entity) => entity.id.startsWith('far-')),
      'nobody outside the radius may leak in',
    );
  });

  test('the visible list is in stable id order so deltas are deterministic', () => {
    const origin = { id: 'me', x: 4_000, y: 4_000 };
    const entities: AoiEntity[] = [
      origin,
      { id: 'zeta', x: 4_100, y: 4_000 },
      { id: 'alpha', x: 4_200, y: 4_000 },
      { id: 'mike', x: 4_300, y: 4_000 },
    ];

    const first = build(entities);
    const second = build([...entities].reverse());

    const a = entitiesNear(first.grid, first.positions, origin).map((entity) => entity.id);
    const b = entitiesNear(second.grid, second.positions, origin).map((entity) => entity.id);

    assert.deepEqual(a, b, 'insertion order must not change the output order');
    assert.deepEqual([...a].sort(), a, 'the order must be sorted by id');
  });

  test('the world corners are neighbours of each other', () => {
    // A player at the top-left corner can see someone at the bottom-right one,
    // because (0,0) and (8000,8000) are the same point on the torus.
    const origin = { id: 'me', x: 5, y: 5 };
    const other = { id: 'other', x: WORLD_WIDTH - 5, y: WORLD_HEIGHT - 5 };

    const { grid, positions } = build([origin, other]);
    const ids = entitiesNear(grid, positions, origin).map((entity) => entity.id);

    assert.ok(ids.includes('other'), 'the torus corner must connect');
  });
});

describe('AoI change detection', { concurrency: 1 }, () => {
  test('identical records count as unchanged', () => {
    const record = {
      id: 'a',
      x: 1,
      y: 2,
      rotation: 0.5,
      hp: 100,
      shipClass: 'normal' as const,
    };

    assert.equal(isUnchanged(undefined, record), false, 'a new entity is always a change');
    assert.equal(isUnchanged(record, { ...record }), true);
  });

  test('any of position, rotation or hp changing counts as changed', () => {
    const base = { id: 'a', x: 1, y: 2, rotation: 0.5, hp: 100, shipClass: 'normal' as const };

    assert.equal(isUnchanged(base, { ...base, x: 2 }), false);
    assert.equal(isUnchanged(base, { ...base, y: 3 }), false);
    assert.equal(isUnchanged(base, { ...base, rotation: 0.6 }), false);
    assert.equal(isUnchanged(base, { ...base, hp: 99 }), false);
  });
});

describe('SpatialGrid cell indexing', { concurrency: 1 }, () => {
  test('cellOf matches the shared grid maths', () => {
    const grid = new SpatialGrid();
    assert.deepEqual(grid.cellOf(0, 0), gridCellOf({ x: 0, y: 0 }));
    assert.deepEqual(grid.cellOf(2_500, 5_100), { col: 1, row: 2 });

    // x=WORLD_WIDTH wraps to column 0, which is what keeps the torus closed.
    assert.deepEqual(grid.cellOf(WORLD_WIDTH, WORLD_HEIGHT), { col: 0, row: 0 });
    assert.deepEqual(grid.cellOf(WORLD_WIDTH - 1, WORLD_HEIGHT - 1), {
      col: GRID_COLUMNS - 1,
      row: gridCellOf({ x: 0, y: WORLD_HEIGHT - 1 }).row,
    });
  });

  test('idsInCells dedupes and tolerates empty cells', () => {
    const grid = new SpatialGrid();
    grid.upsert({ id: 'a', x: 100, y: 100 });

    const ids = grid.idsInCells([
      { col: 0, row: 0 },
      { col: 0, row: 0 }, // same cell twice
      { col: 3, row: 3 }, // empty
    ]);

    assert.deepEqual(ids, ['a']);
  });

  test('rebuild replaces stale contents', () => {
    const grid = new SpatialGrid();
    grid.upsert({ id: 'old', x: 100, y: 100 });

    grid.rebuild([{ id: 'new', x: 100, y: 100 }]);

    const ids = grid.idsInCells([{ col: 0, row: 0 }]);
    assert.ok(ids.includes('new'));
    assert.ok(!ids.includes('old'), 'rebuild must not keep entities that moved away');
  });
});
