import { Container, Graphics } from 'pixi.js';

import { WORLD_HEIGHT, WORLD_WIDTH } from '@warship/shared';

import { buoysNear, type Buoy } from './buoys';

/**
 * Everything that makes the world feel like it is moving: sea marks, the ship's
 * wake, and a faint reference grid.
 *
 * All three solve the same complaint from different angles:
 *
 *  - **Buoys** are the primary cue. They live in world space and are fixed, so your
 *    motion is measured against them. The tiling water cannot do this because it is
 *    screen-space and identical everywhere.
 *  - **The wake** is a secondary cue attached to *you*: foam left behind, fading.
 *    Alone it would look like the ship is stationary and the foam is moving, but
 *    combined with buoys it reinforces speed and heading.
 *  - **The grid** is a tertiary cue for open water where no buoy is in view — a
 *    low-contrast lattice gives the eye something to track.
 *
 * Everything is drawn with `Graphics` primitives: no textures, no extra assets, and
 * the cost is independent of world size because only what is on screen is drawn.
 */

/** Grid line spacing, in world units. Faint enough to ignore, present enough to track. */
const GRID_STEP = 2_000;

/**
 * Wake particle lifetime.
 *
 * A short trail follows the stern and fades; anything longer and the ship drags a
 * permanent scar across the map.
 */
const WAKE_LIFETIME_MS = 1_400;

/** How often a new wake particle is emitted, in milliseconds. */
const WAKE_EMIT_INTERVAL_MS = 90;

/** Below this speed no wake is emitted — a stationary ship must not foam. */
const WAKE_MIN_SPEED = 12;

/** Hard cap on live wake particles, so a long session cannot grow the pool forever. */
const WAKE_MAX_PARTICLES = 40;

interface WakeParticle {
  readonly view: Graphics;
  x: number;
  y: number;
  /** Local time the particle was born; rewritten each time the slot is reused. */
  bornAt: number;
  radius: number;
  driftX: number;
  driftY: number;
  active: boolean;
}

const BUOY_COLORS: Record<Buoy['kind'], number> = {
  can: 0xf6c86b, // amber, like a lit channel marker
  cone: 0xff9e57, // orange
  sphere: 0xe8f4f8, // white
  spar: 0x4fd1c5, // the accent teal, so it reads as "structure"
};

export class WorldObjects {
  readonly view = new Container();

  readonly #buoyLayer = new Container();
  readonly #wakeLayer = new Container();
  readonly #grid = new Graphics();

  /** Reused across frames; the renderer only ever reads from it. */
  readonly #wake: WakeParticle[] = [];

  #lastEmitAt = 0;
  #lastGridKey = '';
  #lastBuoyKey = '';
  constructor() {
    // Draw order: grid under everything, buoys above it, wake above buoys so foam
    // sits on top of whatever it overlaps.
    this.view.addChild(this.#grid, this.#buoyLayer, this.#wakeLayer);
    this.view.eventMode = 'none';

    this.#buildWakePool();
  }

  /**
   * Bring the world objects up to date for one frame.
   *
   * @param now frame timestamp in ms.
   * @param deltaS seconds since the previous frame.
   * @param camera the visible region, in world units.
   * @param self the local ship, or `null` before the first snapshot.
   */
  update(
    now: number,
    camera: {
      readonly x: number;
      readonly y: number;
      readonly zoom: number;
      readonly width: number;
      readonly height: number;
    },
    self: {
      readonly x: number;
      readonly y: number;
      readonly rotation: number;
      readonly speed: number;
    } | null,
  ): void {
    this.#updateGrid(camera);
    this.#updateBuoys(camera);
    this.#updateWake(now, self);
  }

  destroy(): void {
    for (const particle of this.#wake) particle.view.destroy();
    this.#wake.length = 0;
    this.view.destroy({ children: true });
  }

  /* ------------------------------------------------------------------------ */
  /*  Grid                                                                    */
  /* ------------------------------------------------------------------------ */

  /**
   * The grid is rebuilt only when the camera moves far enough to change which lines
   * are visible. Repainting 8 lines every frame would be wasted work; keying on the
   * visible line indices makes it a few times per second at most.
   */
  #updateGrid(camera: {
    readonly x: number;
    readonly y: number;
    readonly zoom: number;
    readonly width: number;
    readonly height: number;
  }): void {
    const halfW = camera.width / 2 / camera.zoom;
    const halfH = camera.height / 2 / camera.zoom;

    /* The world wraps, so the visible span can legitimately exceed the world size at
       low zoom. Clamp the line range and wrap the offset instead of drawing an
       unbounded number of lines. */
    const firstX = Math.floor((camera.x - halfW) / GRID_STEP);
    const lastX = Math.ceil((camera.x + halfW) / GRID_STEP);
    const firstY = Math.floor((camera.y - halfH) / GRID_STEP);
    const lastY = Math.ceil((camera.y + halfH) / GRID_STEP);

    const key = `${String(firstX)}:${String(lastX)}:${String(firstY)}:${String(lastY)}:${String(Math.round(camera.zoom * 10))}`;
    if (key === this.#lastGridKey) return;
    this.#lastGridKey = key;

    const lines = this.#grid.clear();
    const span = Math.min(64, Math.max(0, lastX - firstX) + Math.max(0, lastY - firstY));
    if (span === 0) return;

    /* Wrap each line back into the world so a line at x = -2000 is drawn at x = 6000
       (the torus seam), where the camera will actually look for it. */
    for (let ix = firstX; ix <= lastX; ix += 1) {
      const x = wrap(ix * GRID_STEP, WORLD_WIDTH);
      lines.moveTo(x, 0).lineTo(x, WORLD_HEIGHT);
    }
    for (let iy = firstY; iy <= lastY; iy += 1) {
      const y = wrap(iy * GRID_STEP, WORLD_HEIGHT);
      lines.moveTo(0, y).lineTo(WORLD_WIDTH, y);
    }
    lines.stroke({ color: 0x8fd9e8, alpha: 0.05, width: 2 });
  }

  /* ------------------------------------------------------------------------ */
  /*  Buoys                                                                   */
  /* ------------------------------------------------------------------------ */

  #updateBuoys(camera: {
    readonly x: number;
    readonly y: number;
    readonly zoom: number;
    readonly width: number;
    readonly height: number;
  }): void {
    const halfW = camera.width / 2 / camera.zoom;
    const halfH = camera.height / 2 / camera.zoom;
    // Generous margin so a buoy is already drawn before it scrolls into view.
    const radius = Math.hypot(halfW, halfH) + 200;

    const visible = buoysNearCached(camera.x, camera.y, radius);

    /* Rebuild the layer only when the visible set changes. Each buoy is a handful of
       vector commands, so even a full rebuild is cheap — but doing it at 60 Hz for a
       set that changes a few times a second is still waste. */
    const key = visible.map((buoy) => buoy.id).join(',');
    if (key === this.#lastBuoyKey) return;
    this.#lastBuoyKey = key;

    for (const child of this.#buoyLayer.removeChildren()) child.destroy();

    for (const buoy of visible) {
      this.#buoyLayer.addChild(drawBuoy(buoy));
    }
  }

  /* ------------------------------------------------------------------------ */
  /*  Wake                                                                    */
  /* ------------------------------------------------------------------------ */

  #buildWakePool(): void {
    for (let index = 0; index < WAKE_MAX_PARTICLES; index += 1) {
      const view = new Graphics();
      view.visible = false;
      this.#wakeLayer.addChild(view);
      this.#wake.push({
        view,
        x: 0,
        y: 0,
        bornAt: 0,
        radius: 10,
        driftX: 0,
        driftY: 0,
        active: false,
      });
    }
  }

  /**
   * Emit foam behind the ship and fade what is already there.
   *
   * Only the local player emits: doing this for every visible ship would multiply the
   * particle count by the number of players on screen for a decoration the player
   * barely registers on other hulls.
   */
  #updateWake(
    now: number,
    self: {
      readonly x: number;
      readonly y: number;
      readonly rotation: number;
      readonly speed: number;
    } | null,
  ): void {
    /* Emit at a fixed cadence rather than per frame: the trail should look the same
       at 30 and 144 fps, and a frame-rate-dependent emitter would not. */
    if (self !== null && Math.abs(self.speed) > WAKE_MIN_SPEED) {
      if (now - this.#lastEmitAt >= WAKE_EMIT_INTERVAL_MS) {
        this.#lastEmitAt = now;
        this.#emit(self, now);
      }
    }

    for (const particle of this.#wake) {
      if (!particle.active) continue;

      const age = now - particle.bornAt;
      if (age >= WAKE_LIFETIME_MS) {
        particle.active = false;
        particle.view.visible = false;
        continue;
      }

      const t = age / WAKE_LIFETIME_MS;
      // Foam spreads and thins as it disperses.
      const radius = particle.radius * (1 + t * 2.2);
      const alpha = (1 - t) * 0.5;

      particle.x += particle.driftX;
      particle.y += particle.driftY;

      particle.view.clear().circle(particle.x, particle.y, radius).fill({ color: 0xdff4fb, alpha });
    }
  }

  #emit(
    self: {
      readonly x: number;
      readonly y: number;
      readonly rotation: number;
      readonly speed: number;
    },
    now: number,
  ): void {
    const slot = this.#wake.find((particle) => !particle.active);
    if (slot === undefined) return; // pool full: quietly skip, never grow

    /* Emit from the stern, not the centre. Rotation 0 faces +x, so the stern is at
       -x relative to the hull. */
    const back = 26;
    const sternX = self.x - Math.cos(self.rotation) * back;
    const sternY = self.y - Math.sin(self.rotation) * back;

    // Slight lateral spread so the trail reads as disturbed water, not a string of beads.
    const jitter = (Math.random() - 0.5) * 14;

    slot.active = true;
    slot.x = sternX + Math.cos(self.rotation + Math.PI / 2) * jitter;
    slot.y = sternY + Math.sin(self.rotation + Math.PI / 2) * jitter;
    slot.bornAt = now;
    slot.radius = 5 + Math.random() * 3;
    slot.view.visible = true;
    slot.driftX = 0;
    slot.driftY = 0;
  }
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/** Wrap a world coordinate into `[0, size)`. */
function wrap(value: number, size: number): number {
  return ((value % size) + size) % size;
}

/** Draw one buoy as a filled shape with a reflective top. */
function drawBuoy(buoy: Buoy): Graphics {
  const color = BUOY_COLORS[buoy.kind];
  const g = new Graphics();
  g.position.set(buoy.x, buoy.y);

  switch (buoy.kind) {
    case 'can': {
      // Flat-topped cylinder: a rectangle with a rounded cap.
      g.roundRect(-buoy.radius, -buoy.radius, buoy.radius * 2, buoy.radius * 2, 3)
        .fill({ color, alpha: 0.9 })
        .stroke({ color: 0x04121e, alpha: 0.5, width: 2 });
      break;
    }
    case 'cone': {
      // Triangle pointing up — the classic port-hand marker.
      g.moveTo(0, -buoy.radius * 1.3)
        .lineTo(buoy.radius, buoy.radius)
        .lineTo(-buoy.radius, buoy.radius)
        .closePath()
        .fill({ color, alpha: 0.9 })
        .stroke({ color: 0x04121e, alpha: 0.5, width: 2 });
      break;
    }
    case 'sphere': {
      g.circle(0, 0, buoy.radius)
        .fill({ color, alpha: 0.9 })
        .stroke({ color: 0x04121e, alpha: 0.5, width: 2 });
      break;
    }
    case 'spar': {
      // Tall thin post with a crossbar.
      g.rect(-2.5, -buoy.radius * 1.6, 5, buoy.radius * 2.6)
        .fill({ color, alpha: 0.9 })
        .rect(-buoy.radius, -buoy.radius * 1.6, buoy.radius * 2, 4)
        .fill({ color: 0xe8f4f8, alpha: 0.85 })
        .stroke({ color: 0x04121e, alpha: 0.5, width: 1.5 });
      break;
    }
  }

  return g;
}

/* Cache the last query so the buoy layer is not rebuilt from a fresh array every
   frame when the camera has not moved. */
let lastQuery = { x: Number.NaN, y: Number.NaN, radius: 0 };
let lastResult: readonly Buoy[] = [];

function buoysNearCached(x: number, y: number, radius: number): readonly Buoy[] {
  if (
    lastQuery.x === x &&
    lastQuery.y === y &&
    lastQuery.radius === radius &&
    lastResult.length > 0
  ) {
    return lastResult;
  }
  lastQuery = { x, y, radius };
  lastResult = buoysNear(x, y, radius);
  return lastResult;
}
