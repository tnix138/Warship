import {
  MVP_FLAGS,
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

import { FA, ltr } from './strings.fa';

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
}

/** How long an event line stays on screen before it is removed. */
const EVENT_TTL_MS = 4_000;
/** Maximum number of event lines stacked at once. */
const EVENT_MAX_LINES = 5;

export class GameHud {
  readonly #hpLabel = document.getElementById('stat-hp');
  readonly #hpFill = document.getElementById('hp-fill');
  readonly #hpBar = document.querySelector<HTMLElement>('.meter--hull');
  readonly #level = document.getElementById('stat-level');
  readonly #class = document.getElementById('stat-class');

  readonly #fps = document.getElementById('stat-fps');
  readonly #zoom = document.getElementById('stat-zoom');
  readonly #camera = document.getElementById('stat-camera');
  readonly #renderer = document.getElementById('stat-renderer');
  readonly #entities = document.getElementById('stat-entities');
  readonly #tick = document.getElementById('stat-tick');
  readonly #input = document.getElementById('stat-input');
  readonly #sent = document.getElementById('stat-sent');

  readonly #netDot = document.getElementById('net-dot');
  readonly #netLabel = document.getElementById('net-label');
  readonly #eventLog = document.getElementById('event-log');

  readonly #xpFill = document.getElementById('xp-fill');
  readonly #xpLabel = document.getElementById('stat-xp');
  readonly #scrap = document.getElementById('stat-scrap');
  readonly #points = document.getElementById('stat-points');
  readonly #zone = document.getElementById('stat-zone');
  readonly #danger = document.getElementById('stat-danger');
  readonly #rank = document.getElementById('status-rank');

  readonly #upgradeModal = document.getElementById('upgrade-modal');
  readonly #upgradeList = document.getElementById('upgrade-list');
  readonly #upgradeHint = document.getElementById('upgrade-hint');

  readonly #deathScreen = document.getElementById('death-screen');
  readonly #deathCountdown = document.getElementById('death-countdown');

  #lastDebugUpdate = 0;
  #lastHpText = '';
  #lastNetLabel = '';
  #lastXpText = '';
  /** Upgrade points shown in the open modal, so a purchase can reopen it correctly. */
  #modalPoints = 0;

  #maxHp = 1;
  #hp = 1;

  constructor() {
    /* Hide rather than omit: the markup stays for when `advancedDebug` is switched back
       on, and the panel does not render empty rows in the meantime. */
    if (!MVP_FLAGS.advancedDebug) {
      for (const row of document.querySelectorAll('.debug__row--adv')) {
        (row as HTMLElement).hidden = true;
      }
    }
  }

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
    this.#setNetLabel(FA.disconnect);
    if (this.#netDot) this.#netDot.className = 'dot dot--error';
    this.pushEvent(message);
    console.error('[net]', message);
  }

  /** Show the shard, tick rate and world size once the handshake completes. */
  setServerInfo(welcome: WelcomeMessage): void {
    this.#setNetLabel(`${FA.online} · ${ltr(welcome.tickRate)} Hz`);
  }

  /* ------------------------------------------------------------------------ */
  /*  Vitals                                                                  */
  /* ------------------------------------------------------------------------ */

  updateSelf(state: PlayerStateMessage): void {
    this.#hp = state.hp;
    this.#maxHp = Math.max(1, state.maxHp);
    this.#renderHp();
    setText(this.#level, toPersianDigits(state.level));
    setText(this.#class, shipClassName(state.shipClass));
    this.#renderXp(state.xp);
    setText(this.#scrap, toPersianDigits(state.scrap));
    setText(this.#points, toPersianDigits(state.upgradePoints ?? 0));
    setText(this.#zone, zoneName(state.zone));
    setText(this.#danger, toPersianDigits(dangerFor(state.zone)));
    setText(this.#rank, rankLine(state.level));

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
      name.textContent = upgradeName(offer.upgradeId);

      const desc = document.createElement('span');
      desc.className = 'upgrade__desc';
      desc.textContent =
        `${upgradeDescription(offer.upgradeId)} · ${FA.rank} ` +
        `${toPersianDigits(offer.rank)}/${toPersianDigits(definition.maxRank)}`;

      const cost = document.createElement('span');
      cost.className = 'upgrade__cost';
      /* The server prices upgrades; the client only displays the number it was told. */
      cost.textContent = ltr(toPersianDigits(definition.cost));

      button.append(name, desc, cost);
      button.addEventListener('click', () => {
        options.onChoose(offer.upgradeId);
      });

      list.append(button);
    }

    setText(
      this.#upgradeHint,
      options.points > 1
        ? `${FA.levelUpHint} (${toPersianDigits(options.points)} ${FA.points})`
        : FA.levelUpHint,
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
    setText(this.#deathCountdown, toPersianDigits(Math.max(0, Math.ceil(respawnInS))));
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

  /**
   * Show the intent currently being sent, and how many INPUT frames have gone out.
   *
   * This is the fastest way to tell "keys are not arriving" apart from "keys arrive
   * but the server ignores them": `sent` climbing with `input` showing `thr 1` means
   * the client is fine; `input –` while pressing W means the listener never fired.
   */
  setInputState(frame: { turn: number; throttle: number }, sent: number): void {
    const parts: string[] = [];
    if (frame.throttle > 0) parts.push('جلو');
    else if (frame.throttle < 0) parts.push('عقب');
    if (frame.turn > 0) parts.push('راست');
    else if (frame.turn < 0) parts.push('چپ');

    setText(this.#input, parts.length === 0 ? '–' : parts.join(' '));
    setText(this.#sent, String(sent));
  }

  /** Throttled to ~4 Hz: DOM writes every frame would be wasted layout work. */
  updateDebug(stats: DebugStats, now: number): void {
    if (now - this.#lastDebugUpdate < 250) return;
    this.#lastDebugUpdate = now;

    setText(this.#fps, stats.fps.toFixed(0));

    /* MVP: fps, entities and tick are the whole panel. Every row below this point
       describes a subsystem that is switched off, and a debug readout for something
       that cannot happen is worse than no readout — it invites "the buffer is 0, is
       that a bug?" when the answer is "there is no buffer". */
    if (!MVP_FLAGS.advancedDebug) return;

    setText(this.#zoom, `${stats.zoom.toFixed(2)}×`);
    setText(this.#camera, `${stats.cameraX.toFixed(0)}, ${stats.cameraY.toFixed(0)}`);
    setText(this.#renderer, stats.rendererName);
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
    const text = `${toPersianDigits(Math.round(progress.intoLevel))} / ${toPersianDigits(Math.round(progress.levelSpan))} ${FA.xp}`;

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
    setText(this.#deathCountdown, toPersianDigits(Math.max(0, Math.ceil(seconds))));
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
      return FA.offline;
    }
    case 'connecting':
    case 'handshaking':
    case 'joining': {
      return FA.connecting;
    }
    case 'connected': {
      return FA.online;
    }
    case 'reconnecting': {
      return FA.reconnecting;
    }
    case 'disconnected': {
      return FA.disconnect;
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

/* -------------------------------------------------------------------------- */
/*  Locale helpers                                                            */
/* -------------------------------------------------------------------------- */

/** Latin digit → Persian digit, one char at a time. */
const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'] as const;

/**
 * Render a number with Persian digits.
 *
 * Used for *read-only* counters (level, scrap, hull, timers) where the value is being
 * read as text. Deliberately not applied to the debug panel: those are numbers a
 * developer compares against logs, and Persian digits there would make them harder to
 * match, not easier.
 */
export function toPersianDigits(value: number | string): string {
  return String(value).replace(/[0-9]/g, (digit) => PERSIAN_DIGITS[Number(digit)] ?? digit);
}

/** Persian name for a ship class, falling back to the English one if unknown. */
function shipClassName(shipClass: ShipClass): string {
  switch (shipClass) {
    case 'speed': {
      return FA.shipSpeedName;
    }
    case 'normal': {
      return FA.shipNormalName;
    }
    case 'power': {
      return FA.shipPowerName;
    }
    default: {
      /* Unreachable: `ShipClass` is exhausted above. Kept as a defensive fallback for a
         class name arriving from a newer server than this build. */
      return shipClass satisfies never;
    }
  }
}

/** Persian name for a zone. */
function zoneName(zone: string | undefined): string {
  switch (zone) {
    case 'safe': {
      return FA.zoneSafe;
    }
    case 'mid': {
      return FA.zoneMid;
    }
    case 'open': {
      return FA.zoneOpen;
    }
    default: {
      return zone ?? '—';
    }
  }
}

/**
 * Threat number shown next to the zone.
 *
 * A *derived* display, not a game value: it is the zone's NPC level band collapsed to
 * one digit, which is what a player actually wants to know ("is this water dangerous or
 * not") before they commit to sailing into it.
 */
function dangerFor(zone: string | undefined): number {
  switch (zone) {
    case 'safe': {
      return 1;
    }
    case 'mid': {
      return 2;
    }
    case 'open': {
      return 3;
    }
    default: {
      return 1;
    }
  }
}

/** "سطح ۳ — ناوچه"-style line for the status card header. */
function rankLine(level: number): string {
  return `${FA.level} ${toPersianDigits(level)} — ${hullRankName(level)}`;
}

/**
 * Hull rank shown next to the level.
 *
 * Purely cosmetic naming for progression the player can already see in the level number;
 * it deliberately does not imply any stat the server does not grant.
 */
function hullRankName(level: number): string {
  if (level >= 30) return 'رزم‌ناو';
  if (level >= 20) return 'ناو';
  if (level >= 12) return 'ناوچه';
  if (level >= 6) return 'قایق توپدار';
  return 'قایق';
}

/** Persian name for an upgrade id. */
function upgradeName(id: UpgradeId): string {
  switch (id) {
    case 'reinforced-hull': {
      return FA.upgradeReinforcedHull;
    }
    case 'armor-plating': {
      return FA.upgradeArmorPlating;
    }
    case 'marine-boiler': {
      return FA.upgradeMarineBoiler;
    }
    case 'steering-gear': {
      return FA.upgradeSteeringGear;
    }
    case 'rapid-loader': {
      return FA.upgradeRapidLoader;
    }
    case 'heavy-shells': {
      return FA.upgradeHeavyShells;
    }
    case 'extended-range': {
      return FA.upgradeExtendedRange;
    }
    case 'spotter-plane': {
      return FA.upgradeSpotterPlane;
    }
    default: {
      return id satisfies never;
    }
  }
}

/** Persian description for an upgrade id. */
function upgradeDescription(id: UpgradeId): string {
  switch (id) {
    case 'reinforced-hull': {
      return FA.upgradeReinforcedHullDesc;
    }
    case 'armor-plating': {
      return FA.upgradeArmorPlatingDesc;
    }
    case 'marine-boiler': {
      return FA.upgradeMarineBoilerDesc;
    }
    case 'steering-gear': {
      return FA.upgradeSteeringGearDesc;
    }
    case 'rapid-loader': {
      return FA.upgradeRapidLoaderDesc;
    }
    case 'heavy-shells': {
      return FA.upgradeHeavyShellsDesc;
    }
    case 'extended-range': {
      return FA.upgradeExtendedRangeDesc;
    }
    case 'spotter-plane': {
      return FA.upgradeSpotterPlaneDesc;
    }
    default: {
      return id satisfies never;
    }
  }
}
