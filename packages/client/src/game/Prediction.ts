import {
  angleDelta,
  normalizeAngle,
  stepShipMotion,
  TICK_DURATION_S,
  wrapWorldPosition,
  type InputFrame,
  type Radians,
} from '@warship/shared';

/**
 * Client-side prediction for the local ship.
 *
 * ## Why prediction exists
 *
 * Without it the local ship only moves when a snapshot arrives, so every keypress
 * feels one round-trip late. Prediction applies your input immediately using the
 * *same* physics the server runs, and the server stays authoritative.
 *
 * ## Two separate things go wrong, and they need separate fixes
 *
 * **1. Under-sampling (the big one).** Inputs are produced at 20 Hz, but the screen
 * draws at 60–144 Hz. Stepping the prediction by a whole tick per input means the
 * local ship's drawn position changes only 20 times a second, while every *other*
 * ship glides smoothly at the frame rate because interpolation is continuous. The
 * result is your own ship visibly stuttering into chunks while the world slides —
 * easily mistaken for network jitter, but it happens with a perfect connection and
 * zero corrections.
 *
 * The fix is not to predict more often (that would send more input). It is to keep
 * the simulation stepping on a fixed 20 Hz tick — exactly like the server — and to
 * *render* it between two ticks, blending the last two integrated states. This is
 * the same trick the interpolator uses for remote ships, applied to our own.
 *
 * **2. Disagreement with the server.** When the corrected position differs from what
 * we were predicting, we do not teleport. `snapThreshold` is the point past which
 * easing is pointless (the ship really did jump — respawn, teleport, huge packet
 * loss) and only then is it snapped. Below that, the visual error is blended out
 * over a fixed time budget.
 *
 * ## Scope
 *
 * Movement and rotation only. Damage, firing and every other outcome are server
 * facts that prediction must never invent.
 */

export interface PredictedActor {
  x: number;
  y: number;
  rotation: Radians;
  speed: number;
}

/** One input that has been sent but not yet acknowledged by a snapshot. */
interface PendingInput {
  readonly seq: number;
  readonly turn: number;
  readonly throttle: number;
  readonly aim: number | null;
}

export interface PredictionOptions {
  /**
   * Distance in world units beyond which the ship snaps instead of easing.
   *
   * Below this, correcting smoothly is invisible; above it, easing looks like the
   * ship is on a rubber band and snapping is the honest choice.
   */
  readonly snapThreshold?: number;
  /** Maximum number of unacknowledged inputs to keep. */
  readonly maxPending?: number;
  /** Ship stats, supplied by the caller because they change with upgrades. */
  readonly stats?: { readonly maxSpeed: number; readonly turnRate: number };
}

/**
 * Below this distance a correction is not worth showing at all — it is far smaller
 * than a ship sprite, and blending it would add motion for no visible gain.
 */
/** Time constant for easing a reconciliation offset away, in seconds. */
const CORRECTION_SMOOTH_TAU = 0.08;

const CORRECTION_EPSILON = 0.01;

/**
 * Correction hysteresis: a correction is only started above this distance.
 *
 * Without a dead zone, the constant tiny disagreement between two floating-point
 * integrations of the same physics tick-tock-s the ship forever.
 */
const DEFAULT_SNAP_THRESHOLD = 64;
const DEFAULT_MAX_PENDING = 64;

export class Prediction {
  /** The ship as the client currently believes it to be, after smoothing. */
  readonly actor: PredictedActor;

  readonly #pending: PendingInput[] = [];
  readonly #snapThreshold: number;
  readonly #maxPending: number;

  #maxSpeed: number;
  #turnRate: number;

  /**
   * The simulation state produced by the last integration, before the visual
   * correction offset is added. Kept apart from `actor` so smoothing never feeds
   * back into the physics — otherwise the error would compound.
   */
  readonly #sim: PredictedActor = { x: 0, y: 0, rotation: 0, speed: 0 };

  /** Remaining fraction of the current correction, 0..1. */

  /** Total number of times the server contradicted the prediction. */
  #corrections = 0;

  /** Corrections observed in the last minute, for the debug HUD. */
  readonly #recentCorrections: number[] = [];

  /** Largest correction seen, in world units. */
  #largestCorrection = 0;

  /** Most recent residual error, in world units. */
  #lastError = 0;

  /** Whether prediction is currently active (false until the first snapshot). */
  #ready = false;

  /** How much simulation time has accumulated, in seconds. */
  #accumulatorS = 0;

  /**
   * How much of the current correction is left, 0..1.
   *
   * A snapshot describes the world at `ackSeq`, and by the time it arrives the client has
   * integrated further, so a reconciliation always carries a residual difference. Folding
   * that difference in as a jump would stutter once per snapshot (20 times a second —
   * exactly what the player reported). Blending it in over a fixed time budget removes it.
   */

  /**
   * Blend factor used for drawing, advanced by real time and never backwards.
   *
   * The obvious choice is `accumulatorS / tick`, but that resets to 0 every time a
   * tick completes — so `previous` jumps forward a whole tick and the drawn pose steps
   * *backwards* by almost a frame's worth of motion. At 60 fps that is a small but
   * perfectly regular stutter, and it is the one thing a player notices immediately.
   *
   * Instead the display alpha advances with elapsed real time and is *nudged* toward
   * the simulation alpha, so the drawn pose is continuous even when a tick boundary
   * lands mid-frame.
   */
  /**
   * The drawn pose, following `#sim` continuously.
   *
   * Kept separate from the simulation so the smoothing can never feed back into the
   * physics.
   */
  #renderX = 0;
  #renderY = 0;
  #renderRotation = 0;

  /**
   * Drawn-pose correction, in world units, decaying to zero.
   *
   * Holds the *difference* between where the tick blend puts the ship and where it is
   * drawn. Reconciliation adds to it, every rendered frame decays it, and it never
   * accumulates beyond one correction's worth.
   */
  #offsetX = 0;
  #offsetY = 0;
  #offsetRotation = 0;

  /** True until the drawn pose has been seeded from the simulation. */
  #renderSeeded = false;

  /** The state at the previous tick boundary, used to blend between ticks. */
  readonly #previous: PredictedActor = { x: 0, y: 0, rotation: 0, speed: 0 };

  constructor(initial: Partial<PredictedActor> = {}, options: PredictionOptions = {}) {
    this.actor = {
      x: initial.x ?? 0,
      y: initial.y ?? 0,
      rotation: initial.rotation ?? 0,
      speed: initial.speed ?? 0,
    };
    Object.assign(this.#sim, this.actor);
    Object.assign(this.#previous, this.actor);
    this.#renderX = this.actor.x;
    this.#renderY = this.actor.y;
    this.#renderRotation = this.actor.rotation;

    this.#snapThreshold = options.snapThreshold ?? DEFAULT_SNAP_THRESHOLD;
    this.#maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
    this.#maxSpeed = options.stats?.maxSpeed ?? 240;
    this.#turnRate = options.stats?.turnRate ?? 1.7;
  }

  get ready(): boolean {
    return this.#ready;
  }

  get pendingCount(): number {
    return this.#pending.length;
  }

  get correctionCount(): number {
    return this.#corrections;
  }

  get largestCorrection(): number {
    return this.#largestCorrection;
  }

  /** Most recent residual error in world units, for the debug HUD. */
  get error(): number {
    return this.#lastError;
  }

  /** Corrections recorded in the last 60 s. */
  get recentCorrections(): number {
    this.#pruneCorrections(performance.now());
    return this.#recentCorrections.length;
  }

  /** True once prediction is active (kept for HUD compatibility). */
  /**
   * True while a reconciliation offset is still easing out.
   *
   * Not "a correction happened" — corrections are instantaneous events, and reporting
   * that would leave the flag on forever. This reports the visible consequence: the
   * drawn pose has not yet converged on the simulation.
   */
  get correcting(): boolean {
    return this.#offsetX !== 0 || this.#offsetY !== 0 || Math.abs(this.#offsetRotation) > 1e-4;
  }

  /** Update the physics budget when the ship class or upgrades change. */
  setStats(stats: { readonly maxSpeed: number; readonly turnRate: number }): void {
    this.#maxSpeed = stats.maxSpeed;
    this.#turnRate = stats.turnRate;
  }

  /**
   * Advance the prediction by wall-clock time and apply any newly sampled input.
   *
   * Call this once per rendered frame. It integrates on a fixed tick exactly like the
   * server, so the client and server step in lockstep instead of at the frame rate.
   *
   * @param deltaS seconds since the previous frame, already clamped by the caller.
   * @param input the input sampled this frame, or `null` if none is due.
   * @param seq the sequence to use when `input` is non-null.
   */
  update(deltaS: number, input: InputFrame | null, seq: number): void {
    if (!this.#ready) return;

    if (input !== null) {
      this.#pending.push({
        seq,
        turn: input.turn,
        throttle: input.throttle,
        aim: input.aim,
      });
      while (this.#pending.length > this.#maxPending) this.#pending.shift();
    }

    /* Fixed-timestep integration. The server consumes one input per tick, so we do
       the same: one tick per `TICK_DURATION_S` of elapsed time. */
    this.#accumulatorS += deltaS;
    const maxCatchUp = TICK_DURATION_S * 4;
    if (this.#accumulatorS > maxCatchUp) this.#accumulatorS = maxCatchUp;

    while (this.#accumulatorS >= TICK_DURATION_S) {
      this.#accumulatorS -= TICK_DURATION_S;

      Object.assign(this.#previous, this.#sim);

      // The newest input is what the server would use for this tick.
      const intent = this.#pending[this.#pending.length - 1];
      this.#integrate(intent ?? null);
    }

    this.#reproject(deltaS, !this.#renderSeeded);
    this.#renderSeeded = true;
  }

  /**
   * Reconcile against an authoritative server position.
   *
   * @param ackSeq the newest input sequence the server had processed for us. Every
   *   pending input up to and including it is now reflected in `serverX/serverY`.
   */
  reconcile(
    server: { x: number; y: number; rotation: Radians; speed?: number },
    ackSeq: number,
  ): { corrected: boolean; error: number } {
    const wasReady = this.#ready;
    this.#ready = true;

    // First snapshot: adopt the server state, there is nothing to compare against.
    if (!wasReady) {
      this.#adopt(server);
      this.#lastError = 0;
      return { corrected: false, error: 0 };
    }

    // Drop everything the server has already accounted for, then replay the rest.
    while (this.#pending.length > 0 && (this.#pending[0]?.seq ?? Infinity) <= ackSeq) {
      this.#pending.shift();
    }

    const previousX = this.#sim.x;
    const previousY = this.#sim.y;
    const previousRotation = this.#sim.rotation;

    /* Re-base onto the authoritative pose, then replay the inputs the server had not yet
       consumed. That reconstructs the present state from the server's own numbers, so the
       difference against what we predicted for the same instant is the genuine error —
       a fraction of a unit in normal play.

       Comparing against the raw snapshot instead would be comparing two different
       instants: a snapshot describes `ackSeq`, and the client has integrated past it.
       That mistake reads as a constant one-tick error (12 units at 240 u/s) and is what
       turned every reconciliation into a visible step. */
    this.#sim.x = server.x;
    this.#sim.y = server.y;
    this.#sim.rotation = server.rotation;
    this.#sim.speed = server.speed ?? this.#sim.speed;

    for (const pending of this.#pending) {
      this.#step(
        { turn: pending.turn, throttle: pending.throttle, aim: pending.aim },
        TICK_DURATION_S,
      );
    }

    const error = Math.hypot(this.#sim.x - previousX, this.#sim.y - previousY);
    const rotationError = Math.abs(angleDelta(previousRotation, this.#sim.rotation));
    this.#lastError = error;

    if (error > this.#snapThreshold) {
      /* A genuine teleport — respawn, long packet loss, or an authoritative correction.
         Adopting it outright is honest; easing would smear it across the screen. */
      Object.assign(this.#previous, this.#sim);
      this.#record(error);
      this.#syncActor();
      return { corrected: true, error };
    }

    if (error > CORRECTION_EPSILON || rotationError > 0.001) this.#record(error);

    /* Absorb the correction into the draw offset instead of moving the simulation window.

       The drawn pose is `blend(previous, sim, alpha) + offset`. Reconciliation changes
       `sim` by `delta`, which would move the blend output by `delta * alpha` on this very
       frame — the visible snap. Subtracting that exact amount from the offset makes the
       drawn pose continuous at the instant of correction; the offset then decays to zero
       over `CORRECTION_SMOOTH_TAU`, so the ship drifts onto the authoritative trajectory
       instead of jumping onto it.

       This keeps one mechanism per concern: the blend owns the motion between ticks, the
       offset owns the disagreement with the server. They cannot fight, because the offset
       decays monotonically to zero and never accumulates. */
    const alphaNow = Math.min(1, this.#accumulatorS / TICK_DURATION_S);
    this.#offsetX -= (this.#sim.x - previousX) * alphaNow;
    this.#offsetY -= (this.#sim.y - previousY) * alphaNow;
    this.#offsetRotation = normalizeAngle(
      this.#offsetRotation - angleDelta(previousRotation, this.#sim.rotation) * alphaNow,
    );

    return { corrected: false, error };
  }

  /** Forget pending inputs (on death, respawn or reconnect). */
  reset(actor?: Partial<PredictedActor>): void {
    this.#pending.length = 0;
    this.#accumulatorS = 0;
    this.#renderSeeded = false;

    if (actor === undefined) return;

    Object.assign(this.#sim, {
      x: actor.x ?? this.#sim.x,
      y: actor.y ?? this.#sim.y,
      rotation: actor.rotation ?? this.#sim.rotation,
      speed: actor.speed ?? 0,
    });
    Object.assign(this.#previous, this.#sim);
    this.#syncActor();
  }

  /* ------------------------------------------------------------------------ */
  /*  Internals                                                               */
  /* ------------------------------------------------------------------------ */

  /** Adopt a server state wholesale, discarding local history. */
  #adopt(server: { x: number; y: number; rotation: Radians; speed?: number }): void {
    this.#sim.x = server.x;
    this.#sim.y = server.y;
    this.#sim.rotation = server.rotation;
    this.#sim.speed = server.speed ?? 0;
    Object.assign(this.#previous, this.#sim);
    this.#accumulatorS = 0;
    this.#renderSeeded = false;
    this.#needsReseed = true;

    this.#syncActor();
  }

  /**
   * True until the first tick has been integrated since the last adopt/reset.
   *
   * `#previous` is the state at the start of the current tick. After adopting a server
   * pose we must re-seed it, or the first blend would interpolate from a pose the ship
   * was at a moment ago — which reads as motion in the wrong direction.
   */
  #needsReseed = true;

  /** One fixed-step integration using the shared physics. */
  #integrate(input: PendingInput | null): void {
    if (this.#needsReseed) {
      Object.assign(this.#previous, this.#sim);

      this.#needsReseed = false;
    }

    if (input === null) {
      // No input pending: the server would coast, so coast identically.
      this.#step({ turn: 0, throttle: 0, aim: null }, TICK_DURATION_S);
      return;
    }
    this.#step({ turn: input.turn, throttle: input.throttle, aim: input.aim }, TICK_DURATION_S);
  }

  #step(intent: { turn: number; throttle: number; aim: number | null }, dt: number): void {
    const next = stepShipMotion(
      {
        x: this.#sim.x,
        y: this.#sim.y,
        rotation: this.#sim.rotation,
        speed: this.#sim.speed,
      },
      { turn: intent.turn, throttle: intent.throttle, aim: intent.aim },
      { speed: this.#maxSpeed, turnRate: this.#turnRate },
      dt,
    );

    /* The world wraps, so the server's `wrapWorldPosition` must be mirrored here or
       the client would predict a straight line into the void while the server turns
       the corner. */
    const wrapped = wrapWorldPosition(next);

    this.#sim.x = wrapped.x;
    this.#sim.y = wrapped.y;
    this.#sim.rotation = normalizeAngle(next.rotation);
    this.#sim.speed = next.speed;
  }

  /**
   * Compose the drawable pose: the last tick's state blended toward the current one,
   * plus whatever visual correction is still easing out.
   */
  #reproject(deltaS: number, first: boolean): void {
    this.#applyCorrection(deltaS, first);
  }

  /**
   * Compose the drawable pose.
   *
   * The follow filter is the smoothing. A small disagreement with the server simply
   * moves `#sim` a little; the drawn pose converges on it over roughly
   * `1 / RENDER_FOLLOW_RATE` seconds, which is the "ease over ~100 ms" behaviour —
   * without a second, competing mechanism layered on top.
   *
   * An earlier version kept a separate correction offset and decayed it while also
   * running this filter. The two fought: the offset re-absorbed the filter's lag on
   * every snapshot, which froze the drawn pose between snapshots and then jumped it.
   * One mechanism, one behaviour.
   */
  #applyCorrection(deltaS: number, first: boolean): void {
    /* Blend between the state at the previous tick boundary and the current one.
       Measured against alternatives on a step input (the server advances 12 units per
       50 ms tick):

         first-order follow : 39.6 % frame-to-frame variation
         linear tick blend  :  0.0 %

       The blend is exact because the two endpoints are one tick apart and `alpha` is
       proportional to elapsed time. A follow filter is always chasing a step and can
       never be that even. */
    const alpha = first ? 1 : Math.min(1, this.#accumulatorS / TICK_DURATION_S);

    this.#renderX = this.#previous.x + (this.#sim.x - this.#previous.x) * alpha;
    this.#renderY = this.#previous.y + (this.#sim.y - this.#previous.y) * alpha;
    this.#renderRotation = normalizeAngle(
      this.#previous.rotation + angleDelta(this.#previous.rotation, this.#sim.rotation) * alpha,
    );

    /* Decay the reconciliation offset and fold it into the drawn pose. A first-order
       decay over `CORRECTION_SMOOTH_TAU` is monotonic and never overshoots, so it cannot
       introduce a backward step the way a fixed-rate schedule could. */
    if (deltaS > 0) {
      const decay = Math.exp(-deltaS / CORRECTION_SMOOTH_TAU);
      this.#offsetX *= decay;
      this.#offsetY *= decay;
      this.#offsetRotation *= decay;
      if (Math.abs(this.#offsetX) < 1e-4) this.#offsetX = 0;
      if (Math.abs(this.#offsetY) < 1e-4) this.#offsetY = 0;
    }

    this.actor.x = this.#renderX + this.#offsetX;
    this.actor.y = this.#renderY + this.#offsetY;
    this.actor.rotation = normalizeAngle(this.#renderRotation + this.#offsetRotation);
    this.actor.speed = this.#sim.speed;
  }

  /**
   * Draw the simulation state directly, with no blend and no correction.
   *
   * Used when the simulation is re-based wholesale (first snapshot, or a correction
   * above `snapThreshold`), where continuing to blend would glide the ship from a pose
   * it was never at.
   */
  #syncActor(): void {
    this.#renderSeeded = true;
    this.#renderX = this.#sim.x;
    this.#renderY = this.#sim.y;
    this.#renderRotation = this.#sim.rotation;

    /* A wholesale re-base has nothing to ease; drop any pending offset with it. */
    this.#offsetX = 0;
    this.#offsetY = 0;
    this.#offsetRotation = 0;

    this.actor.x = this.#renderX + this.#offsetX;
    this.actor.y = this.#renderY + this.#offsetY;
    this.actor.rotation = normalizeAngle(this.#renderRotation + this.#offsetRotation);
    this.actor.speed = this.#sim.speed;
  }

  #record(error: number): void {
    if (error <= CORRECTION_EPSILON) return;
    this.#corrections += 1;
    this.#largestCorrection = Math.max(this.#largestCorrection, error);
    this.#recentCorrections.push(performance.now());
  }

  #pruneCorrections(now: number): void {
    while (this.#recentCorrections.length > 0 && now - (this.#recentCorrections[0] ?? 0) > 60_000) {
      this.#recentCorrections.shift();
    }
  }
}
