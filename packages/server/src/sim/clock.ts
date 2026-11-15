/**
 * Fixed-step simulation clock.
 *
 * The authoritative simulation must advance in equal steps regardless of how long a
 * tick took, otherwise physics diverges from what the client predicts. This clock
 * therefore:
 *
 *  - schedules each tick against an **absolute deadline**, so timer latency never
 *    accumulates into drift (a naive `setInterval` slowly falls behind),
 *  - counts how many steps are owed when the event loop is late,
 *  - never runs more than `maxCatchUpTicks` steps in one wake-up, so a stalled
 *    process degrades into dropped time instead of a "spiral of death",
 *  - reports both the nominal step (`dt`) and the measured wall time, so the caller
 *    can choose whether to trust the tick or the clock.
 */

export interface SimulationClockOptions {
  readonly tickRate: number;
  /** Called once per simulated step. `deltaMs` is the *nominal* step length. */
  readonly onTick?: (tick: number, deltaMs: number) => void;
  /** Called with housekeeping stats roughly once per second. */
  readonly onStats?: (stats: ClockStats) => void;
  /** Upper bound on steps executed in a single wake-up. */
  readonly maxCatchUpTicks?: number;
  /** Injectable time source; tests pass a fake clock. */
  readonly now?: () => number;
}

/** Rolling statistics, useful for spotting a server that cannot keep up. */
export interface ClockStats {
  readonly tick: number;
  /** How far behind the ideal deadline the clock is, in ms. */
  readonly driftMs: number;
  /** Steps dropped because the server could not keep up. */
  readonly droppedTicks: number;
  /** Worst observed lateness in the last reporting window, in ms. */
  readonly maxLatenessMs: number;
}

const STATS_WINDOW_MS = 1_000;

export class SimulationClock {
  readonly tickDurationMs: number;

  #tick = 0;
  #running = false;
  #timer: NodeJS.Timeout | null = null;
  /** Absolute time (per `now()`) at which the next tick is due. */
  #nextDeadline = 0;
  #droppedTicks = 0;
  #latenessWindowMax = 0;
  #lastStatsAt = 0;

  readonly #onTick: ((tick: number, deltaMs: number) => void) | undefined;
  readonly #onStats: ((stats: ClockStats) => void) | undefined;
  readonly #maxCatchUpTicks: number;
  readonly #now: () => number;

  constructor(options: SimulationClockOptions) {
    if (!Number.isFinite(options.tickRate) || options.tickRate <= 0) {
      throw new RangeError(
        `tickRate must be a positive number, received ${String(options.tickRate)}`,
      );
    }
    this.tickDurationMs = 1000 / options.tickRate;
    this.#onTick = options.onTick;
    this.#onStats = options.onStats;
    this.#maxCatchUpTicks = Math.max(1, options.maxCatchUpTicks ?? 5);
    this.#now = options.now ?? ((): number => performance.now());
  }

  /** Monotonic tick counter — the only notion of time the simulation trusts. */
  get tick(): number {
    return this.#tick;
  }

  get running(): boolean {
    return this.#running;
  }

  /** How far behind schedule the clock currently is (0 when healthy). */
  get driftMs(): number {
    return Math.max(0, this.#now() - this.#nextDeadline);
  }

  get droppedTicks(): number {
    return this.#droppedTicks;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;

    const now = this.#now();
    this.#nextDeadline = now + this.tickDurationMs;
    this.#lastStatsAt = now;
    this.#schedule();
  }

  stop(): void {
    this.#running = false;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Run exactly one tick immediately, ignoring the timer.
   *
   * Used by tests and by tooling that wants to advance the world deterministically
   * (e.g. a replay or a benchmark) without waiting for real time to pass.
   */
  stepOnce(): void {
    this.#tick += 1;
    this.#onTick?.(this.#tick, this.tickDurationMs);
  }

  /** Reset counters. Only valid while stopped. */
  reset(): void {
    if (this.#running) throw new Error('cannot reset a running clock');
    this.#tick = 0;
    this.#droppedTicks = 0;
    this.#latenessWindowMax = 0;
    this.#nextDeadline = 0;
    this.#lastStatsAt = 0;
  }

  #schedule(): void {
    if (!this.#running) return;

    // setTimeout only accepts integer-ish delays; never schedule in the past with a
    // negative delay, and never sleep past the deadline by rounding.
    const delay = Math.max(0, this.#nextDeadline - this.#now());
    this.#timer = setTimeout(() => {
      this.#advance();
      this.#schedule();
    }, delay);
  }

  #advance(): void {
    const now = this.#now();
    let steps = 0;

    while (now >= this.#nextDeadline && steps < this.#maxCatchUpTicks) {
      this.#tick += 1;
      this.#onTick?.(this.#tick, this.tickDurationMs);
      this.#nextDeadline += this.tickDurationMs;
      steps += 1;

      const lateness = now - this.#nextDeadline;
      if (lateness > this.#latenessWindowMax) this.#latenessWindowMax = lateness;
    }

    // Still behind after the catch-up budget: drop the debt instead of trying to
    // fast-forward, which would make the server simulate a burst of stale time.
    if (now >= this.#nextDeadline) {
      const owed = Math.floor((now - this.#nextDeadline) / this.tickDurationMs) + 1;
      this.#droppedTicks += owed;
      this.#nextDeadline = now + this.tickDurationMs;
    }

    if (this.#onStats !== undefined && now - this.#lastStatsAt >= STATS_WINDOW_MS) {
      this.#lastStatsAt = now;
      this.#onStats({
        tick: this.#tick,
        driftMs: this.driftMs,
        droppedTicks: this.#droppedTicks,
        maxLatenessMs: this.#latenessWindowMax,
      });
      this.#latenessWindowMax = 0;
    }
  }
}
