import { inputDebugEnabled, type InputFrame } from '@warship/shared';

/**
 * Keyboard + mouse input.
 *
 * Produces an `InputFrame` — a pure *intent*: the server decides what actually
 * happens to the ship. W/S is ahead/astern, A/D is turn. The mouse no longer steers
 * and no longer fires: a click only *selects* an enemy (or, on empty water, clears the
 * selection and hands targeting back to the server's automatic pick).
 *
 * Firing itself is entirely server-side. There is no trigger to hold, so there is no
 * `firing` field to send and nothing for a client to lie about.
 *
 * ## Why keys are read from `event.code`, not `event.key`
 *
 * `event.key` reports the **character the key produces**, which depends on the
 * keyboard layout: on AZERTY the physical W key yields `"z"`, on QWERTZ `"w"` and
 * `"z"` are swapped, and on Dvorak `"w"` sits where QWERTY has `","`. Reading
 * `event.key` therefore makes WASD dead for every non-QWERTY user, and it also
 * breaks when Shift is held (`"W"`). `event.code` reports the **physical key**
 * (`"KeyW"`), which is exactly what a game wants: the key in the same place,
 * whatever it types. `event.key` is kept as a fallback for the rare synthetic
 * events that carry no `code`.
 *
 * ## Focus
 *
 * Listeners live on `window`, so no element needs focus for keys to arrive. The
 * canvas is still made focusable (`tabIndex`) and focuses itself on click/pointer
 * down, so that the page receives keystrokes at all when embedded in an iframe or
 * after the user clicks browser chrome. Holding Cmd/Ctrl/Alt suppresses movement so
 * browser shortcuts keep working.
 */

/** Physical-key codes mapped to the actions they drive. */
const KEY_ACTIONS = {
  forward: ['KeyW', 'ArrowUp'],
  backward: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
} as const satisfies Record<string, readonly string[]>;

type Action = keyof typeof KEY_ACTIONS;

/** Fallback for events without a `code`: the character form of each action key. */
const KEY_FALLBACKS: Readonly<Record<Action, readonly string[]>> = {
  forward: ['w'],
  backward: ['s'],
  left: ['a'],
  right: ['d'],
};

/** True when a `KeyboardEvent` should modify movement (browser shortcut). */
function isShortcutModifier(event: {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}): boolean {
  return event.ctrlKey || event.metaKey || event.altKey;
}

/** Resolve which action a key event maps to, or `null`. */
function actionOf(event: { code?: string; key?: string }): Action | null {
  const code = event.code ?? '';
  const key = (event.key ?? '').toLowerCase();

  for (const [action, codes] of Object.entries(KEY_ACTIONS) as [Action, readonly string[]][]) {
    if (codes.includes(code)) return action;
    // Only consult `key` when the event has no `code` at all, so a real layout
    // never overrides the physical mapping.
    if (code === '' && KEY_FALLBACKS[action].includes(key)) return action;
  }
  return null;
}
export class InputController {
  readonly #canvas: HTMLElement;

  /** Screen-space pointer, kept for the caller to project into world space. */
  readonly pointer = { x: 0, y: 0, inside: false };

  /**
   * Clicks the player made that a caller still has to turn into a target.
   *
   * Queued rather than handled here because resolving "what is under the cursor"
   * needs the camera and the snapshot, neither of which this class knows about. The
   * queue means a click is never dropped just because the frame that would have read
   * it was slow.
   */
  readonly #clicks: { x: number; y: number }[] = [];

  /** Held actions, so a key repeat cannot double-count. */
  readonly #actions = new Set<Action>();

  /** Set by the diagnostics flag: logs every key the controller resolves. */
  readonly #debug = inputDebugEnabled();

  constructor(canvas: HTMLElement) {
    this.#canvas = canvas;

    /* The canvas never needs to be focused for window listeners to fire, but making
       it focusable means a click puts the page in a state where keystrokes are
       delivered — required inside an iframe, and after the user clicks browser
       chrome. It also stops the browser from treating Space as "scroll". */
    if (canvas instanceof HTMLElement && !canvas.hasAttribute('tabindex')) {
      canvas.tabIndex = 0;
    }

    window.addEventListener('keydown', this.#onKeyDown);
    window.addEventListener('keyup', this.#onKeyUp);
    // Losing focus must clear held keys, or the ship keeps turning forever.
    window.addEventListener('blur', this.#onBlur);

    canvas.addEventListener('pointermove', this.#onPointerMove);
    canvas.addEventListener('pointerdown', this.#onPointerDown);
    canvas.addEventListener('pointerleave', this.#onPointerLeave);
    canvas.addEventListener('contextmenu', this.#onContextMenu);
  }

  /** Release every listener. */
  destroy(): void {
    window.removeEventListener('keydown', this.#onKeyDown);
    window.removeEventListener('keyup', this.#onKeyUp);
    window.removeEventListener('blur', this.#onBlur);

    this.#canvas.removeEventListener('pointermove', this.#onPointerMove);
    this.#canvas.removeEventListener('pointerdown', this.#onPointerDown);
    this.#canvas.removeEventListener('pointerleave', this.#onPointerLeave);
    this.#canvas.removeEventListener('contextmenu', this.#onContextMenu);
  }

  /** Current intent. Only steering is sent: see the class comment. */
  snapshot(): InputFrame {
    return {
      turn: this.#turn(),
      throttle: this.#throttle(),
    };
  }

  /**
   * Clicks since the last call, in screen space, oldest first.
   *
   * Draining on read keeps a slow frame from replaying the same click twice.
   */
  drainClicks(): { x: number; y: number }[] {
    return this.#clicks.splice(0, this.#clicks.length);
  }

  /** True while any of the WASD/arrow keys is held — used to skip idle work. */
  get hasMovement(): boolean {
    return this.#turn() !== 0 || this.#throttle() !== 0;
  }

  /* ------------------------------------------------------------------------ */
  /*  Internals                                                               */
  /* ------------------------------------------------------------------------ */

  #turn(): number {
    // Positive rotation is clockwise in this world frame, so "right" is +1.
    const right = this.#actions.has('right');
    const left = this.#actions.has('left');
    return (right ? 1 : 0) - (left ? 1 : 0);
  }

  #throttle(): number {
    const forward = this.#actions.has('forward');
    const backward = this.#actions.has('backward');
    return (forward ? 1 : 0) - (backward ? 1 : 0);
  }

  #onKeyDown = (event: KeyboardEvent): void => {
    // Never steal keys from a text field the HUD may add later.
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable || target.tagName === 'INPUT')) {
      return;
    }

    // Leave browser shortcuts alone (Cmd+R, Ctrl+C, …).
    if (isShortcutModifier(event)) return;

    const action = actionOf(event);
    if (action !== null) {
      this.#actions.add(action);
      if (this.#debug) {
        console.info('[INPUT] keydown', { code: event.code, key: event.key, action });
      }
    }

    if (event.code === 'Space' || event.key === ' ') {
      // Space would otherwise scroll the page — and the game has no page to scroll.
      event.preventDefault();
    }
  };

  #onKeyUp = (event: KeyboardEvent): void => {
    const action = actionOf(event);
    if (action !== null) {
      this.#actions.delete(action);
      if (this.#debug) {
        console.info('[INPUT] keyup', { code: event.code, key: event.key, action });
      }
    }
  };

  #onBlur = (): void => {
    this.#actions.clear();
  };

  #onPointerMove = (event: PointerEvent): void => {
    const rect = this.#canvas.getBoundingClientRect();
    this.pointer.x = event.clientX - rect.left;
    this.pointer.y = event.clientY - rect.top;
    this.pointer.inside = true;
  };

  #onPointerDown = (event: PointerEvent): void => {
    // A click is the user's most explicit "I am playing now" signal: take focus so
    // nothing else on the page can intercept keystrokes.
    this.#canvas.focus();

    /* Left click only, and only as a *selection*. The coordinates are already canvas
       relative, so the caller can project them without knowing about layout. */
    if (event.button !== 0) return;
    const rect = this.#canvas.getBoundingClientRect();
    this.#clicks.push({ x: event.clientX - rect.left, y: event.clientY - rect.top });
  };

  #onPointerLeave = (): void => {
    this.pointer.inside = false;
  };

  #onContextMenu = (event: MouseEvent): void => {
    // Right-drag will pan the camera later; keep the browser menu out of the way.
    event.preventDefault();
  };
}
