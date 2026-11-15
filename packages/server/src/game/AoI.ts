import {
  AOI_INTEREST_RADIUS,
  GRID_SIZE,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  gridCellKey,
  gridCellsInRadius,
  type GridCell,
  type RemovedEntity,
  type SnapshotEntity,
} from '@warship/shared';

/**
 * Area of Interest on the server.
 *
 * A player is only told about entities within `AOI_INTEREST_RADIUS` of their ship.
 * That turns the snapshot problem from O(players²) into roughly
 * O(players × entities_in_view), which is what makes 100 players in one shard
 * affordable.
 *
 * Two things here are worth understanding, because they are where the subtle bugs
 * live:
 *
 * 1. **Radius, not neighbourhood.** The interest radius (3000) is larger than one
 *    grid cell (2000), so a ship sitting near a cell corner reaches *two* cells out.
 *    Walking `gridCellsInRadius` rather than assuming a 3×3 block is the difference
 *    between "usually right" and "right".
 *
 * 2. **Visibility is a set difference.** The client only learns that an entity
 *    vanished if it is told. So every player carries the set of ids they were told
 *    about last tick; anything that left it becomes an explicit `removed` entry.
 *    Without that bookkeeping an entity would simply freeze on screen forever when
 *    it walked out of range.
 */

/** A positionable entity the AoI needs to know about. */
export interface AoiEntity {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

/** Per-player AoI memory: what this client currently believes exists. */
export interface AoiState {
  /** Entity ids the client was told about last tick. */
  visible: Set<string>;
  /**
   * Cached wire records from the previous tick, used to decide whether an entity
   * actually changed and therefore whether it belongs in a delta.
   */
  lastSent: Map<string, SnapshotEntity>;
  /** True until the client has received at least one full snapshot. */
  needsFull: boolean;
}

/** Result of one player's culling pass. */
export interface AoiResult {
  /** Entities inside the interest radius, in stable id order. */
  readonly visible: readonly AoiEntity[];
  /** Ids that were visible last tick and are not any more. */
  readonly removed: readonly RemovedEntity[];
}

export function createAoiState(): AoiState {
  return { visible: new Set(), lastSent: new Map(), needsFull: true };
}

/**
 * Everything within the interest radius of `origin`.
 *
 * The grid is queried cell-by-cell because the radius can span several cells; the
 * final distance filter is what makes the result a circle rather than a block.
 */
export function entitiesNear(
  grid: { idsInCells(cells: Iterable<GridCell>): readonly string[] },
  positions: ReadonlyMap<string, AoiEntity>,
  origin: AoiEntity,
  radius: number = AOI_INTEREST_RADIUS,
): AoiEntity[] {
  const cells = gridCellsInRadius(origin, radius);
  const candidateIds = grid.idsInCells(cells);

  const radiusSquared = radius * radius;
  const found: AoiEntity[] = [];

  for (const id of candidateIds) {
    const entity = positions.get(id);
    if (entity === undefined) continue;

    // Toroidal distance: the world wraps, so walking off the right edge brings you
    // out on the left. Measuring straight-line distance without wrapping would make
    // a ship at x=7999 blind to one at x=1 even though they are 2 units apart.
    if (wrappedDistanceSquared(origin, entity) <= radiusSquared) {
      found.push(entity);
    }
  }

  // Stable order keeps delta diffs deterministic and makes tests readable.
  found.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return found;
}

/**
 * Apply culling for one player and update their AoI memory in place.
 *
 * Returns what is in view and what just left it. The caller decides how to pack
 * that into a snapshot.
 */
export function updateAoi(
  state: AoiState,
  grid: { idsInCells(cells: Iterable<GridCell>): readonly string[] },
  positions: ReadonlyMap<string, AoiEntity>,
  origin: AoiEntity,
  radius: number = AOI_INTEREST_RADIUS,
): AoiResult {
  const visible = entitiesNear(grid, positions, origin, radius);
  const visibleIds = new Set(visible.map((entity) => entity.id));

  const removed: RemovedEntity[] = [];
  for (const id of state.visible) {
    if (!visibleIds.has(id)) removed.push({ id, reason: 'aoi' });
  }

  state.visible = visibleIds;

  return { visible, removed };
}

/**
 * True when `next` is identical to what the client was already told.
 *
 * `shipClass` is deliberately ignores: it only ever changes on respawn, which also
 * changes position and hp, so comparing the mutable fields is sufficient and keeps
 * this cheap.
 */
export function isUnchanged(previous: SnapshotEntity | undefined, next: SnapshotEntity): boolean {
  if (previous === undefined) return false;
  return (
    previous.x === next.x &&
    previous.y === next.y &&
    previous.rotation === next.rotation &&
    previous.hp === next.hp
  );
}

/**
 * How many grid cells a given radius spans, for diagnostics and tests.
 *
 * A radius of exactly one cell still touches up to 3×3 cells when the origin sits on
 * a boundary, which is why this ceilings the ratio and doubles it.
 */
export function cellsSpannedBy(radius: number, cellSize: number = GRID_SIZE): number {
  const reach = Math.ceil(radius / cellSize);
  return (reach * 2 + 1) ** 2;
}

/** Squared distance between two positions on the wrapped world. */
export function wrappedDistanceSquared(
  a: { x: number; y: number },
  b: { x: number; y: number },
  worldWidth: number = WORLD_WIDTH,
  worldHeight: number = WORLD_HEIGHT,
): number {
  const dx = toroidalDelta(a.x - b.x, worldWidth);
  const dy = toroidalDelta(a.y - b.y, worldHeight);
  return dx * dx + dy * dy;
}

function toroidalDelta(delta: number, size: number): number {
  const half = size / 2;
  if (delta > half) return delta - size;
  if (delta < -half) return delta + size;
  return delta;
}

/** Cell keys a radius covers, exported so the grid can be indexed in one pass. */
export function cellsFor(origin: AoiEntity, radius: number): number[] {
  return gridCellsInRadius(origin, radius).map(gridCellKey);
}
