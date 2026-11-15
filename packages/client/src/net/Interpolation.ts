import { angleDelta, INTERPOLATION_DELAY_MS, type EntityId, type Radians } from '@warship/shared';

/**
 * Snapshot interpolation.
 *
 * The server simulates at 20 Hz; the screen refreshes at 60–144 Hz. Drawing the
 * newest snapshot directly makes ships teleport once per tick. The fix is to render
 * *in the past*: hold a short buffer of snapshots and draw the world as it was
 * `INTERPOLATION_DELAY_MS` ago, interpolating between the two snapshots that
 * straddle that moment.
 *
 * ```
 *   server time ─────────────────────────────────────────▶
 *                 s1        s2        s3        s4
 *                          ▲         ▲
 *                          │ render  │
 *                    now - delay     │
 *                              (bracketed by s2 and s3)
 * ```
 *
 * The delay must exceed one tick interval (50 ms at 20 Hz) or the render clock would
 * sometimes outrun the buffer and have nothing to interpolate toward. 100 ms is two
 * ticks: one for the gap between snapshots, one for jitter.
 *
 * Everything here is pure: it takes snapshots and a time, and returns poses. That
 * makes it unit-testable without a socket or a renderer.
 */

/** One entity's state at one instant, after interpolation. */
export interface InterpolatedEntity {
  readonly id: EntityId;
  readonly x: number;
  readonly y: number;
  readonly rotation: Radians;
  readonly hp: number;
  readonly shipClass?: string;
}

/** An entity plus how much of its per-snapshot movement is left to blend out. */
export interface SnapshotFrame {
  readonly tick: number;
  /** Server wall clock when the snapshot was produced. */
  readonly serverTime: number;
  /** Local receive time, used when server and client clocks disagree. */
  readonly receivedAt: number;
  readonly entities: ReadonlyMap<EntityId, InterpolatedEntity>;
}

/** How many frames we are willing to hold before dropping the oldest. */
const MAX_BUFFERED_FRAMES = 32;

export class Interpolation {
  readonly #buffer: SnapshotFrame[] = [];

  /** Entities that left the world, with the local time they should stop being drawn. */
  readonly #fading = new Map<EntityId, { entity: InterpolatedEntity; until: number }>();

  /** Render this far behind the newest data, in milliseconds. */
  readonly delayMs: number;

  /** How long a removed entity lingers while fading, in milliseconds. */
  readonly fadeMs: number;

  constructor(options: { delayMs?: number; fadeMs?: number } = {}) {
    this.delayMs = options.delayMs ?? INTERPOLATION_DELAY_MS;
    this.fadeMs = options.fadeMs ?? 180;
  }

  /** Number of frames currently buffered, for diagnostics and tests. */
  get bufferedFrames(): number {
    return this.#buffer.length;
  }

  /** Oldest/newest tick in the buffer, or `-1` when empty. */
  get tickRange(): { oldest: number; newest: number } {
    if (this.#buffer.length === 0) return { oldest: -1, newest: -1 };
    return {
      oldest: this.#buffer[0]?.tick ?? -1,
      newest: this.#buffer[this.#buffer.length - 1]?.tick ?? -1,
    };
  }

  /**
   * Store a snapshot.
   *
   * `full` snapshots reset the entity set: everything currently in the buffer that
   * the full frame does not mention is genuinely gone, so it moves to the fade list
   * rather than vanishing mid-frame.
   */
  push(
    frame: { tick: number; serverTime: number; entities: readonly InterpolatedEntity[] },
    options: { full: boolean; removed?: readonly EntityId[]; now: number },
  ): void {
    const incoming = new Map<EntityId, InterpolatedEntity>();
    for (const entity of frame.entities) incoming.set(entity.id, entity);

    const merged = new Map<EntityId, InterpolatedEntity>();
    const previous = this.#buffer[this.#buffer.length - 1];

    if (options.full || previous === undefined) {
      for (const [id, entity] of incoming) merged.set(id, entity);
    } else {
      // Delta: carry forward everything the server did not restate.
      for (const [id, entity] of previous.entities) merged.set(id, entity);
      for (const [id, entity] of incoming) merged.set(id, entity);
    }

    for (const id of options.removed ?? []) {
      const stillHere = merged.get(id);
      if (stillHere !== undefined) this.#beginFade(stillHere, options.now);
      merged.delete(id);
    }

    // A full frame implies anything absent is gone; fade those out too.
    if (options.full && previous !== undefined) {
      for (const [id, entity] of previous.entities) {
        if (!merged.has(id)) this.#beginFade(entity, options.now);
      }
    }

    this.#buffer.push({
      tick: frame.tick,
      serverTime: frame.serverTime,
      receivedAt: options.now,
      entities: merged,
    });

    while (this.#buffer.length > MAX_BUFFERED_FRAMES) this.#buffer.shift();
  }

  /** Drop all buffered state (new session, reconnect). */
  clear(): void {
    this.#buffer.length = 0;
    this.#fading.clear();
  }

  /**
   * The world as it should be drawn at `now`.
   *
   * Returns an empty array until there are two frames to interpolate between — the
   * alternative would be snapping the camera to a single sample, which looks worse
   * than one blank frame.
   */
  sample(now: number): readonly InterpolatedEntity[] {
    if (this.#buffer.length === 0) return [];

    const renderTime = now - this.delayMs;

    const to = this.#framePairFor(renderTime);
    if (to === null) {
      // Not enough data yet: show the oldest frame we have rather than nothing.
      return [...(this.#buffer[0]?.entities.values() ?? [])];
    }

    const { from, to: target, alpha } = to;

    const out: InterpolatedEntity[] = [];
    for (const [id, end] of target.entities) {
      const start = from.entities.get(id);

      if (start === undefined) {
        // Newly visible: no previous pose to blend from. Draw where it is.
        out.push(end);
        continue;
      }

      out.push({
        id,
        x: lerp(start.x, end.x, alpha),
        y: lerp(start.y, end.y, alpha),
        // Rotation must take the short way around: blending 3.1 rad to -3.1 rad
        // linearly would spin the ship almost a full turn backwards.
        rotation: start.rotation + angleDelta(start.rotation, end.rotation) * alpha,
        hp: lerp(start.hp, end.hp, alpha),
        shipClass: end.shipClass ?? start.shipClass,
      });
    }

    /* Fading entities are drawn at their last known pose with a shrinking alpha. */
    for (const [id, fading] of this.#fading) {
      if (now >= fading.until) {
        this.#fading.delete(id);
        continue;
      }
      out.push(fading.entity);
    }

    return out;
  }

  /** Fade progress in 0..1 for an id, or `null` if it is not fading. */
  fadeAlpha(id: EntityId, now: number): number | null {
    const fading = this.#fading.get(id);
    if (fading === undefined) return null;
    const remaining = Math.max(0, fading.until - now);
    return this.fadeMs === 0 ? 0 : remaining / this.fadeMs;
  }

  /** True while at least one frame is buffered. */
  get hasData(): boolean {
    return this.#buffer.length > 0;
  }

  /* ------------------------------------------------------------------------ */
  /*  Internals                                                               */
  /* ------------------------------------------------------------------------ */

  #beginFade(entity: InterpolatedEntity, now: number): void {
    if (this.fadeMs <= 0) return;
    this.#fading.set(entity.id, { entity, until: now + this.fadeMs });
  }

  /**
   * Find the two frames straddling `renderTime` and the blend factor between them.
   *
   * Timestamps come from the server, but the comparison uses *local receive time*
   * (shifted by the measured delay) so a client whose clock is off by minutes still
   * interpolates correctly. The server timestamp is only a tiebreaker.
   */
  #framePairFor(
    renderTime: number,
  ): { from: SnapshotFrame; to: SnapshotFrame; alpha: number } | null {
    if (this.#buffer.length < 2) return null;

    // Walk backwards to the newest frame received at or before renderTime.
    for (let index = this.#buffer.length - 2; index >= 0; index -= 1) {
      const from = this.#buffer[index];
      const to = this.#buffer[index + 1];
      if (from === undefined || to === undefined) continue;

      if (from.receivedAt <= renderTime) {
        const span = to.receivedAt - from.receivedAt;
        const alpha = span <= 0 ? 1 : clamp01((renderTime - from.receivedAt) / span);
        return { from, to, alpha };
      }
    }

    // renderTime predates the whole buffer: hold the oldest pose instead of
    // extrapolating backwards, which would jitter.
    const from = this.#buffer[0];
    const to = this.#buffer[1];
    if (from === undefined || to === undefined) return null;
    return { from, to, alpha: 0 };
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
