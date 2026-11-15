import {
  PING_GOOD_MS,
  PING_WARN_MS,
  SHIP_CLASSES,
  type ConnectionState,
  type PlayerStateMessage,
  type ShipClass,
  type WelcomeMessage,
} from '@warship/shared';

/**
 * DOM HUD for the networked game.
 *
 * Every lookup is optional-chained: a missing element must degrade the HUD, never
 * crash the game. All writes are guarded by a change check, because touching
 * `textContent` 60 times a second is real layout work and the values only change
 * a few times per second.
 */

export interface DebugStats {
  readonly fps: number;
  readonly zoom: number;
  readonly cameraX: number;
  readonly cameraY: number;
  readonly rendererName: string;
  readonly entities: number;
  readonly tick: number;
  readonly buffered: number;
}

/** How long an event line stays on screen before it is removed. */
const EVENT_TTL_MS = 4_000;
/** Maximum number of event lines stacked at once. */
const EVENT_MAX_LINES = 5;

export class GameHud {
  readonly #hpLabel = document.getElementById('stat-hp');
  readonly #hpFill = document.getElementById('hp-fill');
  readonly #hpBar = document.querySelector<HTMLElement>('.hpbar');
  readonly #level = document.getElementById('stat-level');
  readonly #class = document.getElementById('stat-class');

  readonly #fps = document.getElementById('stat-fps');
  readonly #zoom = document.getElementById('stat-zoom');
  readonly #camera = document.getElementById('stat-camera');
  readonly #renderer = document.getElementById('stat-renderer');
  readonly #entities = document.getElementById('stat-entities');
  readonly #tick = document.getElementById('stat-tick');
  readonly #buffered = document.getElementById('stat-buffered');
  readonly #pending = document.getElementById('stat-pending');
  readonly #corrections = document.getElementById('stat-corrections');
  readonly #predictionError = document.getElementById('stat-prediction-error');
  readonly #input = document.getElementById('stat-input');
  readonly #sent = document.getElementById('stat-sent');

  readonly #netDot = document.getElementById('net-dot');
  readonly #netLabel = document.getElementById('net-label');
  readonly #eventLog = document.getElementById('event-log');

  #lastDebugUpdate = 0;
  #lastPrediction = {
    pending: 0,
    corrections: 0,
    error: 0,
    largest: 0,
    recent: 0,
    buffered: 0,
    delayMs: 0,
    correcting: false,
  };
  #lastHpText = '';
  #lastNetLabel = '';

  #maxHp = 1;
  #hp = 1;

  /* ------------------------------------------------------------------------ */
  /*  Connection status                                                       */
  /* ------------------------------------------------------------------------ */

  setConnectionState(state: ConnectionState): void {
    const label = describeState(state);
    this.#setNetLabel(label);

    const dotClass =
      state === 'connected'
        ? 'dot dot--online'
        : state === 'disconnected'
          ? 'dot dot--error'
          : 'dot dot--offline';

    if (this.#netDot) this.#netDot.className = dotClass;
  }

  /**
   * Show a fatal connection error prominently.
   *
   * Rendered in the status area *and* as a persistent event line, because the
   * top-right status text is small and easy to miss while the player is busy
   * pressing keys that appear to do nothing.
   */
  setConnectionError(message: string): void {
    this.#setNetLabel('error — see console');
    if (this.#netDot) this.#netDot.className = 'dot dot--error';
    this.pushEvent(message);
    console.error('[net]', message);
  }

  /** Show the shard, tick rate and world size once the handshake completes. */
  setServerInfo(welcome: WelcomeMessage): void {
    this.#setNetLabel(`${welcome.shardId} · ${String(welcome.tickRate)} Hz`);
  }

  /* ------------------------------------------------------------------------ */
  /*  Vitals                                                                  */
  /* ------------------------------------------------------------------------ */

  updateSelf(state: PlayerStateMessage): void {
    this.#hp = state.hp;
    this.#maxHp = Math.max(1, state.maxHp);
    this.#renderHp();
    setText(this.#level, String(state.level));
    setText(this.#class, SHIP_CLASSES[state.shipClass].displayName);
  }

  /** Keep the bar honest between PLAYER_STATE frames by using the snapshot's hp. */
  setHp(hp: number, maxHp: number): void {
    this.#hp = hp;
    this.#maxHp = Math.max(1, maxHp);
    this.#renderHp();
  }

  /* ------------------------------------------------------------------------ */
  /*  Counters                                                                */
  /* ------------------------------------------------------------------------ */

  setEntityCount(count: number, tick: number, full = false): void {
    setText(this.#entities, full ? `${String(count)} (full)` : String(count));
    setText(this.#tick, String(tick));
  }

  /** Interpolation buffer depth, refreshed with the debug panel's 4 Hz cadence. */
  setBufferDepth(frames: number): void {
    setText(this.#buffered, String(frames));
  }

  /**
   * Show the intent currently being sent, and how many INPUT frames have gone out.
   *
   * This is the fastest way to tell "keys are not arriving" apart from "keys arrive
   * but the server ignores them": `sent` climbing with `input` showing `thr 1` means
   * the client is fine; `input –` while pressing W means the listener never fired.
   */
  setInputState(frame: { turn: number; throttle: number; firing: boolean }, sent: number): void {
    const parts: string[] = [];
    if (frame.throttle > 0) parts.push('thr +1');
    else if (frame.throttle < 0) parts.push('thr -1');
    if (frame.turn > 0) parts.push('turn +1');
    else if (frame.turn < 0) parts.push('turn -1');
    if (frame.firing) parts.push('fire');

    setText(this.#input, parts.length === 0 ? '–' : parts.join(' '));
    setText(this.#sent, String(sent));
  }

  /** Prediction health: unacknowledged inputs, corrections and worst error. */
  setPredictionStats(stats: {
    pending: number;
    corrections: number;
    error: number;
    largest: number;
    recent: number;
    buffered: number;
    delayMs: number;
    correcting: boolean;
  }): void {
    this.#lastPrediction = stats;
  }

  /** Throttled to ~4 Hz: DOM writes every frame would be wasted layout work. */
  updateDebug(stats: DebugStats, now: number): void {
    if (now - this.#lastDebugUpdate < 250) return;
    this.#lastDebugUpdate = now;

    setText(this.#fps, stats.fps.toFixed(0));
    setText(this.#zoom, `${stats.zoom.toFixed(2)}×`);
    setText(this.#camera, `${stats.cameraX.toFixed(0)}, ${stats.cameraY.toFixed(0)}`);
    setText(this.#renderer, stats.rendererName);
    /* The three numbers that actually explain a jitter complaint:
       how deep the interpolation buffer is, how far ahead/behind our own prediction
       sits, and how many corrections have been applied recently. */
    const buffered = String(this.#lastPrediction.buffered);
    setText(this.#buffered, `${buffered} frames (${String(this.#lastPrediction.delayMs)}ms)`);

    setText(this.#pending, String(this.#lastPrediction.pending));
    setText(this.#predictionError, `${this.#lastPrediction.error.toFixed(2)} units`);
    setText(
      this.#corrections,
      `${String(this.#lastPrediction.recent)} (last 60s) · max ${this.#lastPrediction.largest.toFixed(1)}u`,
    );
  }

  /* ------------------------------------------------------------------------ */
  /*  Events                                                                  */
  /* ------------------------------------------------------------------------ */

  pushEvent(text: string): void {
    const log = this.#eventLog;
    if (log === null) return;

    const line = document.createElement('div');
    line.className = 'hud-event';
    line.textContent = text;
    log.append(line);

    window.setTimeout(() => {
      line.remove();
    }, EVENT_TTL_MS);

    while (log.childElementCount > EVENT_MAX_LINES) {
      log.firstElementChild?.remove();
    }
  }

  /* ------------------------------------------------------------------------ */
  /*  Lifecycle                                                               */
  /* ------------------------------------------------------------------------ */

  destroy(): void {
    this.#eventLog?.replaceChildren();
  }

  /* ------------------------------------------------------------------------ */
  /*  Internals                                                               */
  /* ------------------------------------------------------------------------ */

  #renderHp(): void {
    const fraction = Math.max(0, Math.min(1, this.#hp / this.#maxHp));
    const text = `${Math.round(this.#hp).toString()} / ${Math.round(this.#maxHp).toString()}`;

    if (text !== this.#lastHpText) {
      setText(this.#hpLabel, text);
      this.#lastHpText = text;
    }

    if (this.#hpFill) {
      this.#hpFill.style.width = `${(fraction * 100).toFixed(1)}%`;
      // Green → amber → red, matching the in-world health bars.
      this.#hpFill.dataset.level = fraction > 0.6 ? 'good' : fraction > 0.3 ? 'warn' : 'bad';
    }

    if (this.#hpBar) {
      this.#hpBar.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
    }
  }

  #setNetLabel(label: string): void {
    if (label === this.#lastNetLabel) return;
    this.#lastNetLabel = label;
    setText(this.#netLabel, label);
  }
}

function describeState(state: ConnectionState): string {
  switch (state) {
    case 'idle': {
      return 'idle';
    }
    case 'connecting': {
      return 'connecting…';
    }
    case 'handshaking': {
      return 'handshaking…';
    }
    case 'joining': {
      return 'joining world…';
    }
    case 'connected': {
      return 'online';
    }
    case 'reconnecting': {
      return 'reconnecting…';
    }
    case 'disconnected': {
      return 'disconnected';
    }
  }
}

function setText(element: HTMLElement | null, value: string): void {
  if (element && element.textContent !== value) element.textContent = value;
}

/** Colour thresholds the HUD uses for the ping readout. */
export function pingClass(rttMs: number): string {
  if (rttMs <= PING_GOOD_MS) return 'ping ping--good';
  if (rttMs <= PING_WARN_MS) return 'ping ping--warn';
  return 'ping ping--bad';
}

/** Unused today, kept so the class picker can label its buttons consistently. */
export function shipClassLabel(shipClass: ShipClass): string {
  return SHIP_CLASSES[shipClass].displayName;
}
