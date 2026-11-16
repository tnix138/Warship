import {
  GRID_COLUMNS,
  GRID_ROWS,
  GRID_SIZE,
  gridCellKey,
  gridCellOf,
  type GridCell,
} from '@warship/shared';

/**
 * Spatial hash over the world.
 *
 * The MVP does **not** cull yet — every client still receives every entity. This
 * class exists now so that the moment Area-of-Interest lands, the loop can ask
 * "who is near this player?" without a rewrite, and so that NPC search and
 * collision broad-phase have a home.
 *
 * The grid wraps with the world: column `-1` is column `GRID_COLUMNS - 1`, which
 * keeps the torus consistent across the seam.
 */

export interface GridEntry {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

/** What the grid needs from a positionable thing. */
export interface Positioned {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

export class SpatialGrid {
  /** `cellKey -> entity ids` currently in that cell. */
  readonly #buckets = new Map<number, Set<string>>();

  /** Number of occupied cells, for diagnostics. */
  get occupiedCellCount(): number {
    return this.#buckets.size;
  }

  /** Cell a world position belongs to. */
  cellOf(x: number, y: number): GridCell {
    return gridCellOf({ x, y });
  }

  /** Insert or move an entity. Idempotent for the same cell. */
  upsert(entity: Positioned): GridCell {
    const cell = gridCellOf(entity);
    const key = gridCellKey(cell);

    const bucket = this.#buckets.get(key);
    if (bucket === undefined) {
      this.#buckets.set(key, new Set([entity.id]));
      return cell;
    }

    bucket.add(entity.id);
    return cell;
  }

  /**
   * Rebuild the whole grid from a snapshot of entities.
   *
   * Simpler and faster than tracking every move on small populations, and it can
   * never go stale. At 100 players this is a handful of microseconds per tick.
   */
  rebuild(entities: Iterable<Positioned>): void {
    this.#buckets.clear();
    for (const entity of entities) {
      this.upsert(entity);
    }
  }

  /** Remove an entity from the grid entirely (player left). */
  remove(entity: Positioned | { id: string; x: number; y: number }): void {
    const cell = gridCellOf(entity);
    this.#buckets.get(gridCellKey(cell))?.delete(entity.id);
  }

  /** Ids sharing a cell with `position`. Included so AOI can start here. */
  idsInCell(position: { x: number; y: number }): readonly string[] {
    const bucket = this.#buckets.get(gridCellKey(gridCellOf(position)));
    return bucket === undefined ? [] : [...bucket];
  }

  /**
   * Ids in an arbitrary set of cells, each id once.
   *
   * This is the AoI entry point: the interest radius spans more cells than a 3×3
   * block, so the caller computes the cells (`gridCellsInRadius`) and this walks
   * them. Dedupe matters because the radius walk can name the same wrapped cell
   * twice on a small world.
   */
  idsInCells(cells: Iterable<GridCell>): readonly string[] {
    const seen = new Set<string>();
    for (const cell of cells) {
      const bucket = this.#buckets.get(gridCellKey(cell));
      if (bucket === undefined) continue;
      for (const id of bucket) seen.add(id);
    }
    return [...seen];
  }

  /** Ids in the cell plus its eight neighbours, with the torus applied. */
  idsInNeighbourhood(position: { x: number; y: number }): readonly string[] {
    const { col, row } = gridCellOf(position);
    const ids: string[] = [];

    for (let dRow = -1; dRow <= 1; dRow += 1) {
      for (let dCol = -1; dCol <= 1; dCol += 1) {
        const wrappedCol = (((col + dCol) % GRID_COLUMNS) + GRID_COLUMNS) % GRID_COLUMNS;
        const wrappedRow = (((row + dRow) % GRID_ROWS) + GRID_ROWS) % GRID_ROWS;
        const bucket = this.#buckets.get(gridCellKey({ col: wrappedCol, row: wrappedRow }));
        if (bucket === undefined) continue;
        ids.push(...bucket);
      }
    }

    return ids;
  }

  /** World units covered by one grid cell. Exposed for tests and HUDs. */
  static get cellSize(): number {
    return GRID_SIZE;
  }
}
