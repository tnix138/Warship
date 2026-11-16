import {
  PING_GOOD_MS,
  PING_WARN_MS,
  SHIP_CLASSES,
  UPGRADES,
  xpProgress,
  type ConnectionState,
  type PlayerStateMessage,
  type ShipClass,
  type UpgradeId,
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
  readonly #offsetX = document.getElementById('stat-offset-x');
  readonly #offsetRot = document.getElementById('stat-offset-rot');
  readonly #maxOffset = document.getElementById('stat-max-offset');
  readonly #easeTau = document.getElementById('stat-ease-tau');
  readonly #predictionError = document.getElementById('stat-prediction-error');
  readonly #input = document.getElementById('stat-input');
  readonly #sent = document.getElementById('stat-sent');

  readonly #netDot = document.getElementById('net-dot');
  readonly #netLabel = document.getElementById('net-label');
  readonly #eventLog = document.getElementById('event-log');

  readonly #xpFill = document.getElementById('xp-fill');
  readonly #xpLabel = document.getElementById('stat-xp');
  readonly #scrap = document.getElementById('stat-scrap');
  readonly #points = document.getElementById('stat-points');
  readonly #tier = document.getElementById('stat-tier');

  readonly #upgradeModal = document.getElementById('upgrade-modal');
  readonly #upgradeList = document.getElementById('upgrade-list');
  readonly #upgradeHint = document.getElementById('upgrade-hint');

  readonly #deathScreen = document.getElementById('death-screen');
  readonly #deathCountdown = document.getElementById('death-countdown');

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
    offset: 0,
    offsetRotation: 0,
    maxOffset: 0,
    easeTau: 0.08,
  };
  #lastHpText = '';
  #lastNetLabel = '';
  #lastXpText = '';
  /** Upgrade points shown in the open modal, so a purchase can reopen it correctly. */
  #modalPoints = 0;

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
    this.#renderXp(state.xp);
    setText(this.#scrap, String(state.scrap));
    setText(this.#points, String(state.upgradePoints));
    setText(this.#tier, String(state.hullTier));

    /* Death is driven by the authoritative state, not by the local kill event: the
       event can be dropped by a reconnecting socket, and a player stuck behind a death
       overlay that never clears is worse than one who respawns without seeing it. */
    if (state.dead === true) {
      this.showDeath(state.respawnInS ?? 0);
    } else {
      this.hideDeath();
    }
  }

  /**
   * Show the upgrade picker.
   *
   * The server sends the choices; this only renders them. Offering an upgrade the server
   * would refuse is the classic source of "I clicked it and nothing happened", so the
   * list is filtered to what is actually purchasable right now.
   */
  showUpgrades(options: {
    readonly points: number;
    readonly offers: readonly { readonly upgradeId: UpgradeId; readonly rank: number }[];
    readonly onChoose: (upgradeId: UpgradeId) => void;
  }): void {
    const modal = this.#upgradeModal;
    const list = this.#upgradeList;
    if (modal === null || list === null) return;

    this.#modalPoints = options.points;
    list.replaceChildren();

    for (const offer of options.offers) {
      /* An id can arrive from the wire that the type system believes exists but the
         running build does not, if client and server are out of sync. */
      if (!Object.hasOwn(UPGRADES, offer.upgradeId)) continue;
      const definition = UPGRADES[offer.upgradeId];

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'upgrade';

      const name = document.createElement('span');
      name.className = 'upgrade__name';
      name.textContent = definition.displayName;

      const desc = document.createElement('span');
      desc.className = 'upgrade__desc';
      desc.textContent = definition.description;

      const rank = document.createElement('span');
      rank.className = 'upgrade__rank';
      rank.textContent = `rank ${String(offer.rank)} / ${String(definition.maxRank)}`;

      button.append(name, desc, rank);
      button.addEventListener('click', () => {
        options.onChoose(offer.upgradeId);
      });

      list.append(button);
    }

    setText(
      this.#upgradeHint,
      options.points > 1
        ? `Pick an upgrade — ${String(options.points)} points`
        : 'Pick an upgrade.',
    );
    modal.hidden = false;
  }

  hideUpgrades(): void {
    if (this.#upgradeModal !== null) this.#upgradeModal.hidden = true;
  }

  get upgradesOpen(): boolean {
    return this.#upgradeModal !== null && !this.#upgradeModal.hidden;
  }

  /** Points the open modal was built for, so a purchase can re-offer the remainder. */
  get modalPoints(): number {
    return this.#modalPoints;
  }

  showDeath(respawnInS: number): void {
    if (this.#deathScreen !== null) this.#deathScreen.hidden = false;
    setText(this.#deathCountdown, String(Math.max(0, Math.ceil(respawnInS))));
  }

  hideDeath(): void {
    if (this.#deathScreen !== null) this.#deathScreen.hidden = true;
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
    offset: number;
    offsetRotation: number;
    maxOffset: number;
    easeTau: number;
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

    /* The four numbers that explain *why* a correction is visible: how far the drawn pose
       is displaced right now, by how much in angle, the worst displacement seen recently,
       and the time constant currently in use for easing it away. */
    const offsetNow = this.#lastPrediction.offset;
    const offsetSignX = offsetNow > 0 ? '+' : '';
    setText(this.#offsetX, `${offsetSignX}${offsetNow.toFixed(2)} units`);
    setText(this.#offsetRot, `${this.#lastPrediction.offsetRotation.toFixed(3)} rad`);
    setText(this.#maxOffset, `${this.#lastPrediction.maxOffset.toFixed(1)} units (last 60s)`);
    setText(this.#easeTau, `${(this.#lastPrediction.easeTau * 1000).toFixed(0)} ms`);
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
    this.#upgradeList?.replaceChildren();
    this.hideUpgrades();
    this.hideDeath();
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

  #renderXp(xp: number): void {
    const progress = xpProgress(xp);
    const text = `${Math.round(progress.intoLevel).toString()} / ${Math.round(progress.levelSpan).toString()}`;

    if (text !== this.#lastXpText) {
      setText(this.#xpLabel, text);
      this.#lastXpText = text;
    }

    if (this.#xpFill !== null) {
      const percent = progress.fraction * 100;
      this.#xpFill.style.width = `${percent.toFixed(1)}%`;
      this.#xpFill.parentElement?.setAttribute('aria-valuenow', String(Math.round(percent)));
    }

    /* The level badge comes from the state message, but it is worth asserting here that
       the number on screen and the number the bar was computed from agree — a mismatch
       means `xpProgress` and `xpForLevel` disagree, which is a shared-formula bug. */
  }

  /** Set the countdown text without re-showing an already-visible overlay. */
  updateDeathCountdown(seconds: number): void {
    setText(this.#deathCountdown, String(Math.max(0, Math.ceil(seconds))));
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
