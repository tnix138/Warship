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

  /**
   * The render clock, in local milliseconds.
   *
   * This is the entire difference between smooth and jittery remote motion. The
   * obvious implementation — `renderTime = now - delay` — inherits every hiccup in
   * packet arrival: a snapshot that is 20 ms late makes the world lurch forward, and
   * one that arrives early makes it stand still. Because snapshots are sampled, the
   * result is a visibly uneven crawl.
   *
   * Instead the render clock advances at exactly real time and is *nudged* toward the
   * target (`now - delay`) rather than assigned to it. Arrival jitter changes how fast
   * it converges, never the frame-to-frame motion.
   */
  #renderClockMs = 0;

  /**
   * Offset from the server clock to the render clock, in milliseconds.
   *
   * Snapshots are timestamped by the server; the renderer runs on local time. A fixed
   * offset lets us convert the render clock into *server* time, which is smooth,
   * instead of using arrival times, which are not. Estimated once and then held: it
   * only needs to absorb the difference between two machine clocks, which does not
   * drift meaningfully over a session.
   */
  #serverOffsetMs = 0;
  #serverOffsetReady = false;
  /** Local timestamp of the previous sample, for the real-time advance. */
  #lastNow = 0;
  #renderClockReady = false;

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

    /* Learn the server→local offset. Each frame gives one sample, but a sample taken
       from a late packet is biased, so take the *minimum* offset seen recently: the
       fastest-delivering frame is the least delayed and therefore the closest to
       truth. This is the standard one-way-delay trick and it is stable without any
       clock-sync exchange. */
    const sample = options.now - frame.serverTime;
    if (!this.#serverOffsetReady) {
      this.#serverOffsetMs = sample;
      this.#serverOffsetReady = true;
    } else if (sample < this.#serverOffsetMs) {
      this.#serverOffsetMs = sample;
    } else {
      // Drift upward very slowly, so a genuinely faster network is re-learned.
      this.#serverOffsetMs += (sample - this.#serverOffsetMs) * 0.002;
    }

    while (this.#buffer.length > MAX_BUFFERED_FRAMES) this.#buffer.shift();
  }

  /** Drop all buffered state (new session, reconnect). */
  clear(): void {
    this.#buffer.length = 0;
    this.#fading.clear();
    this.#renderClockReady = false;
    this.#serverOffsetReady = false;
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

    const renderTime = this.#advanceRenderClock(now);

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

  /**
   * Advance the render clock by real elapsed time, converging on `now - delay`.
   *
   * The convergence rate is deliberately slow (a fraction of the remaining error per
   * frame): the clock must never visibly jump, because a jump in the clock is a jump
   * in every interpolated entity at once. It is only there to stop the clock drifting
   * away from the buffer over minutes of play — for instance when the tab is
   * backgrounded and `now` skips forward.
   */
  #advanceRenderClock(now: number): number {
    const target = now - this.delayMs;

    if (!this.#renderClockReady) {
      // First sample: start where we want to be; there is no history to preserve.
      this.#renderClockMs = target;
      this.#lastNow = now;
      this.#renderClockReady = true;
      return this.#renderClockMs;
    }

    /* Advance by real elapsed time. This is the part that makes motion smooth: the
       clock is tied to the wall clock, not to when packets happened to arrive. */
    let elapsed = now - this.#lastNow;
    if (!Number.isFinite(elapsed) || elapsed < 0) elapsed = 0;
    // A backgrounded tab can produce a multi-second gap; cap it so the clock does not
    // leap forward and teleport every entity.
    if (elapsed > 250) elapsed = 250;
    this.#lastNow = now;
    this.#renderClockMs += elapsed;

    /* Then nudge it back toward the target so it cannot drift away over minutes.
       The nudge is a fraction of the remaining error, never the whole error: a jump
       in the clock is a jump in every interpolated entity at once. */
    const drift = target - this.#renderClockMs;
    const maxStep = 3; // ms per frame — enough to recover 100 ms of drift in ~0.5 s
    const correction = Math.max(-maxStep, Math.min(maxStep, drift)) * 0.35;
    this.#renderClockMs += correction;

    return this.#renderClockMs;
  }

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

    /* Convert the render clock into server time. This single line is what makes remote
       motion smooth.

       Arrival times are the obvious time base and the wrong one: they carry every
       network hiccup. A snapshot delivered 20 ms late would make the world slide
       slowly for a moment, then hop to catch up. Server timestamps advance perfectly
       evenly — one per tick — so blending on them is independent of how the packets
       travelled.

       The buffer is in arrival order, and `serverTime` increases with it, so a binary
       search places the render moment between two frames by simulation time. */
    const serverTime = renderTime - this.#serverOffsetMs;

    let low = 0;
    let high = this.#buffer.length - 1;

    if (serverTime <= (this.#buffer[0]?.serverTime ?? 0)) {
      // Predates the buffer: hold the oldest pose rather than extrapolate backwards.
      const from = this.#buffer[0];
      const to = this.#buffer[1];
      if (from === undefined || to === undefined) return null;
      return { from, to, alpha: 0 };
    }
    if (serverTime >= (this.#buffer[high]?.serverTime ?? 0)) {
      /* Past the newest frame: hold the last pair at alpha 1 rather than extrapolate.
         Extrapolation overshoots on every corner and then snaps back, which is a
         worse artefact than a few milliseconds of held pose. */
      const from = this.#buffer[high - 1];
      const to = this.#buffer[high];
      if (from === undefined || to === undefined) return null;
      return { from, to, alpha: 1 };
    }

    while (high - low > 1) {
      const mid = (low + high) >> 1;
      const frame = this.#buffer[mid];
      if (frame === undefined) break;
      if (frame.serverTime <= serverTime) {
        low = mid;
      } else {
        high = mid;
      }
    }

    const from = this.#buffer[low];
    const to = this.#buffer[high];
    if (from === undefined || to === undefined) return null;

    const span = to.serverTime - from.serverTime;
    const alpha = span <= 0 ? 1 : clamp01((serverTime - from.serverTime) / span);

    return { from, to, alpha };
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
