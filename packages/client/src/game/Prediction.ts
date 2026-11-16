import {
  angleDelta,
  normalizeAngle,
  stepShipMotion,
  TICK_DURATION_S,
  wrappedDelta,
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

/**
 * Time constant used once the offset is large, in seconds.
 *
 * A fixed 80 ms ease is tuned for the routine sub-unit disagreement of a healthy
 * connection. Forcing a several-unit offset through it makes the correction itself a
 * visible lurch — the ease moves the ship faster than its own top speed. Stretching the
 * time constant keeps the *speed* of the correction bounded, which is the thing the eye
 * actually judges.
 */
const CORRECTION_SMOOTH_TAU_FAR = 0.15;

/** Offset magnitude, in world units, above which the far time constant applies. */
const CORRECTION_TAU_THRESHOLD = 6;

/**
 * Hard ceiling on the positional offset, in world units.
 *
 * Past this the correction is a teleport, not a drift, and easing it would drag the ship
 * across the map. The excess is absorbed directly instead.
 */
const CORRECTION_OFFSET_MAX = 50;

/**
 * Longest frame the prediction will integrate in one call, in seconds.
 *
 * A garbage-collection pause or a background tab produces a huge `deltaS`. Integrating
 * it whole forces several catch-up ticks in a single frame, which is a jump by
 * definition. Clamping means a long frame loses a little simulation time instead of
 * producing a visible lurch; the server remains authoritative, so the lost time is
 * corrected on the next snapshot rather than accumulating.
 */
const MAX_FRAME_DELTA_S = 0.05;

const CORRECTION_EPSILON = 0.01;

/**
 * Distance beyond which a correction is snapped rather than eased.
 *
 * The genuinely large disagreements are teleports — respawn, reconnect, a long packet
 * loss — and easing one drags the ship across the screen. Everything below this is real
 * drift and eases out; measured worst-case drift at the frame level is ~5 units, so 16
 * carries roughly a 3x margin over anything the player can actually produce.
 */
const DEFAULT_SNAP_THRESHOLD = 16;
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

  /**
   * Largest positional offset since the last 60 s prune, in world units.
   *
   * `largestCorrection` records the disagreement found at reconcile time; this records
   * what the *drawn* pose actually had to absorb, which is a different number whenever
   * two corrections land in the same frame.
   */
  #maxOffset = 0;

  /** Time constant chosen for the offset now decaying, in seconds. */
  #offsetTau = CORRECTION_SMOOTH_TAU;

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

  /** Current horizontal draw offset, in world units. Debug/HUD only. */
  get offsetX(): number {
    return this.#offsetX;
  }

  /** Current vertical draw offset, in world units. Debug/HUD only. */
  get offsetY(): number {
    return this.#offsetY;
  }

  /** Magnitude of the positional draw offset, in world units. */
  get offset(): number {
    return Math.hypot(this.#offsetX, this.#offsetY);
  }

  /** Angular draw offset, in radians. */
  get offsetRotation(): number {
    return this.#offsetRotation;
  }

  /** Largest positional offset seen in the last 60 s, in world units. */
  get maxOffset(): number {
    return this.#maxOffset;
  }

  /** Time constant currently in use for easing the offset, in seconds. */
  get easeTau(): number {
    return this.#offsetTau;
  }

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
  update(rawDeltaS: number, input: InputFrame | null, seq: number): void {
    if (!this.#ready) return;

    const deltaS = Math.min(Math.max(rawDeltaS, 0), MAX_FRAME_DELTA_S);

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

    const beforeX = this.#sim.x;
    const beforeY = this.#sim.y;
    const beforeRotation = this.#sim.rotation;

    /* Advance the authoritative pose to *now*: start from the server's pose at `ackSeq`
       and apply every input the server had not consumed yet.

       The pose is expressed *relative to where we already are*, not adopted raw. The
       server canonicalises both coordinates (`wrapWorldPosition` into the first tile) and
       heading (`normalizeAngle` into (-π, π]), while the simulation deliberately runs
       unwrapped and continuous. Assigning the raw values would make a ship at x = 7 990
       re-based to x = 10 look like an 8 000-unit teleport, and a heading of 3.1 rad
       reported as -3.1 look like a 6.2 rad spin. Applying only the shortest delta keeps
       the blend window one tick wide across both seams. */
    const rebase = wrappedDelta({ x: beforeX, y: beforeY }, { x: server.x, y: server.y });
    this.#sim.x = beforeX + rebase.x;
    this.#sim.y = beforeY + rebase.y;
    this.#sim.rotation = normalizeAngle(
      beforeRotation + angleDelta(beforeRotation, server.rotation),
    );
    this.#sim.speed = server.speed ?? this.#sim.speed;

    for (const pending of this.#pending) {
      if (pending.seq <= ackSeq) continue;
      this.#step(
        { turn: pending.turn, throttle: pending.throttle, aim: pending.aim },
        TICK_DURATION_S,
      );
    }

    /* Error is the disagreement at the acknowledged instant, not the distance the replay
       moved us.

       The re-based pose is advanced over the inputs the server had not consumed, so `sim`
       legitimately ends up a full tick ahead of `beforeX` even when prediction was
       perfect — one tick at 240 u/s is 12 units. Reporting that as the error would show a
       permanent 12-unit "correction" and send anyone debugging this chasing a phase
       offset that is not a defect.

       The like-for-like reference is the pose the re-based state had *before* the replay,
       which is exactly `server` — so the real disagreement is between the served pose and
       the pose our own prediction had reached at that tick. `#previous` is that pose: it
       is one tick behind `#sim` and therefore sits at the acknowledged boundary. */
    const gap = wrappedDelta(this.#previous, server);
    const error = Math.hypot(gap.x, gap.y);
    const rotationError = Math.abs(angleDelta(this.#previous.rotation, server.rotation));
    this.#lastError = error;

    // The server has consumed these; their effect is already in the pose we were handed.
    while (this.#pending.length > 0 && (this.#pending[0]?.seq ?? Infinity) <= ackSeq) {
      this.#pending.shift();
    }

    if (error > this.#snapThreshold) {
      /* A genuine teleport — respawn, long packet loss, or an authoritative correction.
         Adopting it outright is honest; easing would smear it across the screen. */
      Object.assign(this.#previous, this.#sim);
      this.#record(error);
      this.#syncActor();
      return { corrected: true, error };
    }

    if (error > CORRECTION_EPSILON || rotationError > 0.001) this.#record(error);

    /* Translate the whole blend window, then cancel it in the offset.

       The drawn pose is `blend(previous, sim, alpha) + offset`. Moving `sim` alone would
       change the *width* of the window, and that width is what sets the draw speed — a
       full tick of correction doubles it and the ship lurches at twice its top speed for
       a frame (measured: 574 u/s on a 240 u/s hull). Moving neither endpoint leaves the
       error unapplied. Translating both keeps the width, and cancelling the translation
       in the offset keeps the drawn pose continuous:

         drawn = blend(prev + d, sim + d, a) + (off - d)
               = blend(prev, sim, a) + off

       The offset then decays, so the ship drifts onto the authoritative trajectory
       instead of jumping onto it. */
    const delta = wrappedDelta({ x: beforeX, y: beforeY }, this.#sim);
    const deltaX = delta.x;
    const deltaY = delta.y;
    const deltaRotation = angleDelta(beforeRotation, this.#sim.rotation);

    /* Move the *start* of the blend window, keeping its width.

       The window is what the drawn pose interpolates across, and its width is the only
       thing that sets the draw speed — so the start has to move by exactly the same
       delta as the end. Computing it as `sim - unchanged width` (rather than by adding
       to a value that may sit on a different angle branch or a different copy of the
       map) keeps both seams honest: the width is one tick by construction, never 7 980
       units and never 6.2 radians. */
    const widthX = beforeX - this.#previous.x;
    const widthY = beforeY - this.#previous.y;
    const widthRotation = angleDelta(this.#previous.rotation, beforeRotation);

    /* Both poses are expressed relative to `#sim` using wrapped deltas, so they always
       land in the same copy of the map and the same angle branch. Deriving `#previous`
       by arithmetic that ignores the seam leaves the two on different copies — one at
       x = 5 334 and one at x = 7 996 — and the blend then draws the ship partway across
       the world (measured: a 2 662-unit jump on a 4.5-unit frame). */
    const back = wrappedDelta({ x: 0, y: 0 }, { x: -widthX, y: -widthY });
    this.#previous.x = this.#sim.x + back.x;
    this.#previous.y = this.#sim.y + back.y;
    this.#previous.rotation = normalizeAngle(this.#sim.rotation - widthRotation);

    this.#offsetX -= deltaX;
    this.#offsetY -= deltaY;
    this.#offsetRotation = normalizeAngle(this.#offsetRotation - deltaRotation);

    this.#noteOffset();

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
    /* Adopt the pose nearest to where the simulation already is, rather than the
       server's canonical tile. The simulation runs unwrapped, so adopting x = 10 while
       the ship sits at x = 7 990 would make the first blend interpolate the whole world. */
    const near = wrappedDelta(this.#sim, server);
    this.#sim.x += near.x;
    this.#sim.y += near.y;
    this.#sim.rotation = normalizeAngle(
      this.#sim.rotation + angleDelta(this.#sim.rotation, server.rotation),
    );
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

    /* Deliberately *not* wrapped.

       The server canonicalises positions into the first tile, but the client keeps its
       own simulation continuous. Wrapping here makes `#sim` jump from 7 999 to 1 while
       `#previous` still holds 7 999, so the blend interpolates 7 998 units backwards
       across the map on the frame the ship crosses the seam — measured as a 2 666-unit
       jump. Keeping the simulation unwrapped means the tick-to-tick delta is always the
       real one, and only the drawn pose is folded into the world for rendering. */
    this.#sim.x = next.x;
    this.#sim.y = next.y;
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
       decay over the chosen time constant is monotonic and never overshoots, so it cannot
       introduce a backward step the way a fixed-rate schedule could. */
    if (deltaS > 0) {
      const magnitude = Math.hypot(this.#offsetX, this.#offsetY);
      const tau =
        magnitude > CORRECTION_TAU_THRESHOLD ? CORRECTION_SMOOTH_TAU_FAR : CORRECTION_SMOOTH_TAU;
      this.#offsetTau = tau;

      const decay = Math.exp(-deltaS / tau);
      this.#offsetX *= decay;
      this.#offsetY *= decay;
      this.#offsetRotation *= decay;

      if (Math.abs(this.#offsetX) < 1e-4) this.#offsetX = 0;
      if (Math.abs(this.#offsetY) < 1e-4) this.#offsetY = 0;
      if (Math.abs(this.#offsetRotation) < 1e-5) this.#offsetRotation = 0;

      this.#noteOffset();
    }

    this.#writeActor();
  }

  /**
   * Fold the drawn pose into the world and publish it.
   *
   * The simulation runs in a continuous frame so its deltas stay real; rendering needs the
   * canonical tile, because that is where the camera and every other entity live.
   */
  #writeActor(): void {
    const drawn = wrapWorldPosition({
      x: this.#renderX + this.#offsetX,
      y: this.#renderY + this.#offsetY,
    });
    this.actor.x = drawn.x;
    this.actor.y = drawn.y;
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

    this.#writeActor();
  }

  /**
   * Track the largest offset the drawn pose has had to absorb, for the debug HUD.
   *
   * Also enforces `CORRECTION_OFFSET_MAX`: the excess is dropped rather than eased, so a
   * pathological correction cannot drag the ship across the screen over a tenth of a
   * second.
   */
  #noteOffset(): void {
    const magnitude = Math.hypot(this.#offsetX, this.#offsetY);
    if (magnitude > this.#maxOffset) this.#maxOffset = magnitude;

    if (magnitude > CORRECTION_OFFSET_MAX) {
      const scale = CORRECTION_OFFSET_MAX / magnitude;
      this.#offsetX *= scale;
      this.#offsetY *= scale;
    }
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
