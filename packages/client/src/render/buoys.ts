import { WORLD_HEIGHT, WORLD_WIDTH } from '@warship/shared';

/**
 * Sea marks scattered across the world.
 *
 * ## Why these exist
 *
 * The water is a tiling texture in *screen* space, so it looks identical no matter
 * where the ship is. With nothing else in the world, the only cue that you are moving
 * is your own sprite against a background that never changes — the ship appears to
 * sit still while the ocean slides under it. That is the "no sense of motion"
 * problem, and it is a rendering problem, not a simulation one.
 *
 * Fixed world-space landmarks solve it: when you drive past a buoy, it goes past
 * *you*, and only then does the movement read as movement.
 *
 * ## Determinism
 *
 * Every client must see the same buoys in the same places, otherwise two players
 * disagree about the world and a buoy becomes a landmark that only some players can
 * navigate by. There is no server message for them and no seeded RNG dependency:
 * each buoy is derived purely from its index by a hash-style scramble, so any client,
 * in any language, computes the identical layout.
 *
 * ## Why not entities?
 *
 * Buoys are decoration. Sending them through the snapshot stream would cost bandwidth,
 * inflate the AoI entity count, and force the server to track objects that never
 * move or interact. Generating them client-side from a constant keeps them free.
 */

/** The distinct buoy looks; index-selected so the sea is not monotonous. */
export type BuoyKind = 'can' | 'cone' | 'sphere' | 'spar';

export interface Buoy {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly kind: BuoyKind;
  readonly radius: number;
}

/**
 * How many buoys the world holds.
 *
 * Density matters more than count: 120 across 8000×8000 is roughly one per
 * 730×730 units. At 240 u/s a player passes one every couple of seconds, which is
 * frequent enough to read as motion without turning the sea into an obstacle course.
 */
export const BUOY_COUNT = 120;

/**
 * Smallest distance allowed between two buoys.
 *
 * Pure random placement clusters badly (clumps and voids — the classic Poisson
 * problem). Rejection sampling with a fixed iteration budget keeps the layout tidy
 * while remaining fully deterministic.
 */
const MIN_SEPARATION = 260;

/** Keep buoys off the extreme edges so the first thing you see is not a wall of them. */
const MARGIN = 200;

const KINDS: readonly BuoyKind[] = ['can', 'cone', 'sphere', 'spar'];

/**
 * Deterministic 32-bit scramble.
 *
 * A plain LCG would put consecutive buoys on a visible lattice line; hashing the index
 * with a large-odd-multiplier mix scatters it. `>>> 0` keeps everything an unsigned
 * 32-bit integer so the result is identical on every engine.
 */
function hash32(value: number, salt: number): number {
  let x = (value * 0x9e37_79b9 + salt * 0x85eb_ca6b) >>> 0;
  x ^= x >>> 15;
  x = (x * 0x2c1b_3c6d) >>> 0;
  x ^= x >>> 12;
  x = (x * 0x297a_2d39) >>> 0;
  x ^= x >>> 15;
  return x >>> 0;
}

/** Map a hash to 0..1 with full 32-bit precision. */
function unit(value: number, salt: number): number {
  return hash32(value, salt) / 0x1_0000_0000;
}

/**
 * Build the buoy layout.
 *
 * Computed once and cached: the layout is immutable, and regenerating it per frame
 * would defeat the point of it being cheap.
 */
function generate(): readonly Buoy[] {
  const buoys: Buoy[] = [];

  for (let index = 0; index < BUOY_COUNT; index += 1) {
    let placed: Buoy | null = null;

    // A few attempts to find a spot away from the others, then accept whatever we
    // have. The budget is fixed, so the result stays deterministic.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const salt = attempt * 977;
      const x = MARGIN + unit(index, salt + 1) * (WORLD_WIDTH - MARGIN * 2);
      const y = MARGIN + unit(index, salt + 2) * (WORLD_HEIGHT - MARGIN * 2);

      const crowded = buoys.some(
        (other) => Math.abs(other.x - x) < MIN_SEPARATION && Math.abs(other.y - y) < MIN_SEPARATION,
      );
      if (crowded) continue;

      placed = {
        id: index,
        x,
        y,
        kind: KINDS[hash32(index, 7) % KINDS.length] ?? 'can',
        radius: 9 + unit(index, 3) * 5,
      };
      break;
    }

    if (placed !== null) buoys.push(placed);
  }

  return buoys;
}

let cached: readonly Buoy[] | null = null;

/** Every buoy in the world, in stable order. */
export function allBuoys(): readonly Buoy[] {
  cached ??= generate();
  return cached;
}

/**
 * Buoys whose centre is within `radius` of `(x, y)`.
 *
 * The world wraps, so distances must be measured across the seam — a buoy at
 * `(7900, y)` is close to a player at `(100, y)`. `Math.abs` alone would miss it and
 * buoys would pop in and out at the edges.
 *
 * A flat scan over 120 entries is faster than maintaining an index, and it runs once
 * per frame rather than once per buoy.
 */
export function buoysNear(x: number, y: number, radius: number): readonly Buoy[] {
  const halfW = WORLD_WIDTH / 2;
  const halfH = WORLD_HEIGHT / 2;
  const limit = radius * radius;
  const out: Buoy[] = [];

  for (const buoy of allBuoys()) {
    // Shortest wrapped delta on each axis.
    let dx = buoy.x - x;
    let dy = buoy.y - y;
    if (dx > halfW) dx -= WORLD_WIDTH;
    if (dx < -halfW) dx += WORLD_WIDTH;
    if (dy > halfH) dy -= WORLD_HEIGHT;
    if (dy < -halfH) dy += WORLD_HEIGHT;

    if (dx * dx + dy * dy <= limit) out.push(buoy);
  }

  return out;
}
