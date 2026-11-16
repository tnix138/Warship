import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

/**
 * `InputController` tests.
 *
 * There is no browser in CI, but the controller only touches a handful of DOM APIs:
 * `window.addEventListener`, `canvas.addEventListener` and `instanceof HTMLElement`.
 * Shim exactly those, and the real class runs unmodified — which is far better than
 * testing a copy of the logic and hoping it stays in sync.
 *
 * These tests exist because WASD silently did nothing in the browser while every
 * server-side test passed. The bug was in how key presses were translated into an
 * `InputFrame`, which nothing exercised before.
 */

/* -------------------------------------------------------------------------- */
/*  Minimal DOM shim                                                          */
/* -------------------------------------------------------------------------- */

type Listener = (event: unknown) => void;

class ShimTarget {
  readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  /** Fire an event at every listener registered for its type. */
  dispatch(type: string, event: Record<string, unknown>): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

/** The subset of `HTMLElement` the input controller actually inspects. */
class ShimElement extends ShimTarget {
  readonly tagName: string;
  readonly isContentEditable = false;
  readonly attributes = new Set<string>();
  tabIndex = -1;
  focused = false;

  constructor(tagName = 'CANVAS') {
    super();
    this.tagName = tagName;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  setAttribute(name: string, _value = ''): void {
    this.attributes.add(name);
  }

  focus(): void {
    this.focused = true;
  }

  getBoundingClientRect(): { left: number; top: number } {
    return { left: 0, top: 0 };
  }
}

class ShimWindow extends ShimTarget {}

/** Install the globals `Input.ts` expects, and return handles to drive them. */
function installDom(): { window: ShimWindow; canvas: ShimElement } {
  const shimWindow = new ShimWindow();
  const canvas = new ShimElement('CANVAS');

  const globals = globalThis as unknown as { window: unknown; HTMLElement: unknown };
  globals.window = shimWindow;
  globals.HTMLElement = ShimElement;

  return { window: shimWindow, canvas };
}

/** Build a keyboard event the way a browser would deliver it. */
function keyEvent(options: {
  key: string;
  code: string;
  target?: unknown;
  shiftKey?: boolean;
}): Record<string, unknown> {
  return {
    key: options.key,
    code: options.code,
    target: options.target ?? null,
    shiftKey: options.shiftKey ?? false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    repeat: false,
    preventDefault: () => undefined,
  };
}

/* -------------------------------------------------------------------------- */
/*  Tests                                                                     */
/* -------------------------------------------------------------------------- */

// Imported after the shim exists, because the module reads `window` at construction
// time (not at import time), so a static import is safe — but keeping it explicit
// documents the dependency.
const { InputController } = await import('./Input.js');

describe('InputController keyboard', { concurrency: 1 }, () => {
  let dom: ReturnType<typeof installDom>;
  let controller: InstanceType<typeof InputController>;

  beforeEach(() => {
    dom = installDom();
    controller = new InputController(dom.canvas as unknown as HTMLElement);
  });

  test('listens on window, not only the canvas', () => {
    // A canvas-only listener would miss every key press: the canvas is not
    // focusable and never becomes the event target.
    assert.ok(dom.window.listenerCount('keydown') > 0, 'keydown must be on window');
    assert.ok(dom.window.listenerCount('keyup') > 0, 'keyup must be on window');
    assert.ok(dom.window.listenerCount('blur') > 0, 'blur must be on window');
  });

  test('W produces full forward throttle', () => {
    dom.window.dispatch('keydown', keyEvent({ key: 'w', code: 'KeyW' }));

    const frame = controller.snapshot();
    assert.equal(frame.throttle, 1, 'holding W must give throttle +1');
    assert.equal(frame.turn, 0);
  });

  test('S reverses and A/D turn', () => {
    dom.window.dispatch('keydown', keyEvent({ key: 's', code: 'KeyS' }));
    assert.equal(controller.snapshot().throttle, -1);

    dom.window.dispatch('keyup', keyEvent({ key: 's', code: 'KeyS' }));
    dom.window.dispatch('keydown', keyEvent({ key: 'a', code: 'KeyA' }));
    assert.equal(controller.snapshot().turn, -1, 'A steers left');

    dom.window.dispatch('keyup', keyEvent({ key: 'a', code: 'KeyA' }));
    dom.window.dispatch('keydown', keyEvent({ key: 'd', code: 'KeyD' }));
    assert.equal(controller.snapshot().turn, 1, 'D steers right');
  });

  test('arrow keys work as well as letters', () => {
    dom.window.dispatch('keydown', keyEvent({ key: 'ArrowUp', code: 'ArrowUp' }));
    assert.equal(controller.snapshot().throttle, 1);

    dom.window.dispatch('keydown', keyEvent({ key: 'ArrowLeft', code: 'ArrowLeft' }));
    assert.equal(controller.snapshot().turn, -1);
  });

  test('works on a non-QWERTY layout, where event.key is not "w"', () => {
    /* This is the regression that made WASD fail for real users on AZERTY/QWERTZ
       keyboards: `event.key` reports the *character produced*, so the physical W key
       yields "z" on AZERTY and WASD does nothing. `event.code` reports the physical
       key and is layout-independent. */
    dom.window.dispatch('keydown', keyEvent({ key: 'z', code: 'KeyW' }));
    assert.equal(
      controller.snapshot().throttle,
      1,
      'the physical W key must throttle forward whatever character it types',
    );
  });

  test('a held key is not cleared by an unrelated keyup', () => {
    dom.window.dispatch('keydown', keyEvent({ key: 'w', code: 'KeyW' }));
    dom.window.dispatch('keyup', keyEvent({ key: 'q', code: 'KeyQ' }));

    assert.equal(controller.snapshot().throttle, 1, 'W is still held');
  });

  test('window blur releases every key', () => {
    dom.window.dispatch('keydown', keyEvent({ key: 'w', code: 'KeyW' }));
    dom.window.dispatch('keydown', keyEvent({ key: 'd', code: 'KeyD' }));
    dom.window.dispatch('blur', {});

    const frame = controller.snapshot();
    assert.equal(frame.throttle, 0);
    assert.equal(frame.turn, 0);
  });

  test('does not steal keys from a text field', () => {
    const input = new ShimElement('INPUT');
    dom.window.dispatch('keydown', keyEvent({ key: 'w', code: 'KeyW', target: input }));

    assert.equal(controller.snapshot().throttle, 0, 'typing must not steer the ship');
  });

  test('destroy() removes every listener', () => {
    controller.destroy();

    assert.equal(dom.window.listenerCount('keydown'), 0);
    assert.equal(dom.window.listenerCount('keyup'), 0);
    assert.equal(dom.window.listenerCount('blur'), 0);
    assert.equal(dom.canvas.listenerCount('pointermove'), 0);
  });
});

describe('InputController pointer', { concurrency: 1 }, () => {
  test('tracks the pointer inside the canvas', () => {
    const dom = installDom();
    const controller = new InputController(dom.canvas as unknown as HTMLElement);

    dom.canvas.dispatch('pointermove', { clientX: 120, clientY: 80 });

    assert.equal(controller.pointer.inside, true);
    assert.equal(controller.pointer.x, 120);
    assert.equal(controller.pointer.y, 80);
  });

  test('a left click is queued as a selection, not as a shot', () => {
    const dom = installDom();
    const controller = new InputController(dom.canvas as unknown as HTMLElement);

    dom.canvas.dispatch('pointerdown', { button: 0, clientX: 30, clientY: 40 });

    /* The click is handed to the caller, which is the only layer that can turn a screen
       point into an enemy id. Nothing here may decide to fire: firing is server-side. */
    assert.deepEqual(controller.drainClicks(), [{ x: 30, y: 40 }]);
    assert.deepEqual(controller.drainClicks(), [], 'draining twice must not replay it');

    /* A right click is the camera's business later, not a selection. */
    dom.canvas.dispatch('pointerdown', { button: 2, clientX: 1, clientY: 2 });
    assert.deepEqual(controller.drainClicks(), []);

    dom.canvas.dispatch('pointerleave', {});
    assert.equal(controller.pointer.inside, false);
  });
});
