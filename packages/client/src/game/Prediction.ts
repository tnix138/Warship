import {
  angleDelta,
  normalizeAngle,
  stepMotion,
  TICK_DURATION_S,
  type InputFrame,
  type Radians,
} from '@warship/shared';

/**
 * Client-side prediction for the local ship.
 *
 * Without prediction the local ship only moves when a snapshot arrives, so every
 * keypress feels one round-trip late. Prediction fixes that by applying your own
 * input immediately, using the *same* physics function the server runs
 * (`stepMotion` from `@warship/shared`) — the two can never drift apart because
 * there is one implementation.
 *
 * The server stays authoritative. Reconciliation works like this:
 *
 * ```
 *  pending = [i1, i2, i3, i4]        // inputs sent but not yet acknowledged
 *  on snapshot:
 *     drop every input with seq <= ackSeq
 *     position = server position      // trust the authority, always
 *     replay the remaining inputs      // so the ship keeps moving smoothly
 * ```
 *
 * If the corrected position is further from where we were predicting than
 * `snapThreshold`, the ship is snapped rather than eased: easing a large error
 * looks like the ship is dragging a rubber band, while snapping is invisible at
 * speed.
 *
 * Scope: **movement and rotation only.** Damage, firing and every other outcome are
 * server-side facts that prediction must never invent.
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
  /** Local time the input was created, for the extrapolation budget. */
  readonly at: number;
}

export interface PredictionOptions {
  /** Distance in world units beyond which the ship snaps instead of easing. */
  readonly snapThreshold?: number;
  /** Maximum number of unacknowledged inputs to keep. */
  readonly maxPending?: number;
  /** Ship stats, supplied by the caller because they change with upgrades. */
  readonly stats?: { readonly maxSpeed: number; readonly turnRate: number };
}

const DEFAULT_SNAP_THRESHOLD = 64;
const DEFAULT_MAX_PENDING = 64;

export class Prediction {
  /** The ship as the client currently believes it to be. */
  readonly actor: PredictedActor;

  readonly #pending: PendingInput[] = [];
  readonly #snapThreshold: number;
  readonly #maxPending: number;

  #maxSpeed: number;
  #turnRate: number;

  /** Total number of times the server contradicted the prediction. */
  #corrections = 0;

  /** Largest correction seen, in world units — surfaced for the debug HUD. */
  #largestCorrection = 0;

  /** Whether prediction is currently active (false until the first snapshot). */
  #ready = false;

  constructor(
    initial: Partial<PredictedActor> = {},
    options: PredictionOptions & {
      stats?: { readonly maxSpeed: number; readonly turnRate: number };
    } = {},
  ) {
    this.actor = {
      x: initial.x ?? 0,
      y: initial.y ?? 0,
      rotation: initial.rotation ?? 0,
      speed: initial.speed ?? 0,
    };
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

  /** Update the physics budget when the ship class or upgrades change. */
  setStats(stats: { readonly maxSpeed: number; readonly turnRate: number }): void {
    this.#maxSpeed = stats.maxSpeed;
    this.#turnRate = stats.turnRate;
  }

  /**
   * Apply an input locally and remember it for replay.
   *
   * Call this at the same moment the input is sent to the server, with the same
   * `seq`, so acknowledgement lines up exactly.
   */
  applyInput(seq: number, input: InputFrame, now: number): void {
    if (!this.#ready) return;

    this.#pending.push({ seq, turn: input.turn, throttle: input.throttle, at: now });
    while (this.#pending.length > this.#maxPending) this.#pending.shift();

    this.#step({ turn: input.turn, throttle: input.throttle }, TICK_DURATION_S);
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
      this.actor.x = server.x;
      this.actor.y = server.y;
      this.actor.rotation = server.rotation;
      this.actor.speed = server.speed ?? 0;
      return { corrected: false, error: 0 };
    }

    // Drop everything the server has already accounted for.
    while (this.#pending.length > 0 && (this.#pending[0]?.seq ?? Infinity) <= ackSeq) {
      this.#pending.shift();
    }

    const before = { x: this.actor.x, y: this.actor.y, rotation: this.actor.rotation };

    // Trust the authority, then replay the inputs it has not seen yet.
    this.actor.x = server.x;
    this.actor.y = server.y;
    this.actor.rotation = server.rotation;
    this.actor.speed = server.speed ?? this.actor.speed;

    for (const pending of this.#pending) {
      this.#step({ turn: pending.turn, throttle: pending.throttle }, TICK_DURATION_S);
    }

    const error = Math.hypot(this.actor.x - before.x, this.actor.y - before.y);
    const rotationError = Math.abs(angleDelta(before.rotation, this.actor.rotation));

    if (error > this.#snapThreshold) {
      /* Large disagreement: the ship teleported (respawn, big packet loss, an
         anti-cheat correction). Snapping is honest; easing would smear it. */
      this.#corrections += 1;
      this.#largestCorrection = Math.max(this.#largestCorrection, error);
      return { corrected: true, error };
    }

    if (error > 0.5 || rotationError > 0.05) {
      this.#corrections += 1;
      this.#largestCorrection = Math.max(this.#largestCorrection, error);
    }

    return { corrected: false, error };
  }

  /** Forget pending inputs (on death, respawn or reconnect). */
  reset(actor?: Partial<PredictedActor>): void {
    this.#pending.length = 0;
    if (actor === undefined) return;
    this.actor.x = actor.x ?? this.actor.x;
    this.actor.y = actor.y ?? this.actor.y;
    this.actor.rotation = actor.rotation ?? this.actor.rotation;
    this.actor.speed = actor.speed ?? 0;
  }

  /** One fixed-step integration using the shared physics. */
  #step(intent: { turn: number; throttle: number }, dt: number): void {
    const next = stepMotion(
      {
        x: this.actor.x,
        y: this.actor.y,
        rotation: this.actor.rotation,
        speed: this.actor.speed,
      },
      { turn: intent.turn, throttle: intent.throttle },
      { speed: this.#maxSpeed, turnRate: this.#turnRate },
      dt,
    );

    this.actor.x = next.x;
    this.actor.y = next.y;
    this.actor.rotation = normalizeAngle(next.rotation);
    this.actor.speed = next.speed;
  }
}
