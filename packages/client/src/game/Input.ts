import type { InputFrame } from '@warship/shared';

/**
 * Keyboard + mouse input.
 *
 * Produces an `InputFrame` — a pure *intent*: the server decides what actually
 * happens to the ship. W/A/S/D (and arrow keys) steer, the pointer sets the aim
 * angle, the mouse button holds the trigger.
 *
 * The pointer aim is resolved in world space by the caller, which passes the world
 * position under the cursor; this class stays camera-agnostic.
 */
export class InputController {
  readonly #keys = new Set<string>();
  readonly #canvas: HTMLElement;

  /** Screen-space pointer, kept for the caller to project into world space. */
  readonly pointer = { x: 0, y: 0, inside: false };
  #firing = false;

  constructor(canvas: HTMLElement) {
    this.#canvas = canvas;

    window.addEventListener('keydown', this.#onKeyDown);
    window.addEventListener('keyup', this.#onKeyUp);
    // Losing focus must clear held keys, or the ship keeps turning forever.
    window.addEventListener('blur', this.#onBlur);

    canvas.addEventListener('pointermove', this.#onPointerMove);
    canvas.addEventListener('pointerdown', this.#onPointerDown);
    canvas.addEventListener('pointerup', this.#onPointerUp);
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
    this.#canvas.removeEventListener('pointerup', this.#onPointerUp);
    this.#canvas.removeEventListener('pointerleave', this.#onPointerLeave);
    this.#canvas.removeEventListener('contextmenu', this.#onContextMenu);
  }

  /** Current intent. `aim` is the world-space angle the caller computed. */
  snapshot(aim: number | null): InputFrame {
    return {
      turn: this.#turn(),
      throttle: this.#throttle(),
      aim,
      firing: this.#firing,
    };
  }

  /** True while any of the WASD/arrow keys is held — used to skip idle work. */
  get hasMovement(): boolean {
    return this.#turn() !== 0 || this.#throttle() !== 0;
  }

  /* ------------------------------------------------------------------------ */
  /*  Internals                                                               */
  /* ------------------------------------------------------------------------ */

  #turn(): number {
    const left = this.#keys.has('a') || this.#keys.has('arrowleft');
    const right = this.#keys.has('d') || this.#keys.has('arrowright');
    // In this world frame, positive rotation is clockwise, so "right" is +1.
    return (right ? 1 : 0) - (left ? 1 : 0);
  }

  #throttle(): number {
    const forward = this.#keys.has('w') || this.#keys.has('arrowup');
    const backward = this.#keys.has('s') || this.#keys.has('arrowdown');
    return (forward ? 1 : 0) - (backward ? 1 : 0);
  }

  #onKeyDown = (event: KeyboardEvent): void => {
    // Never steal keys from a text field the HUD may add later.
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable || target.tagName === 'INPUT')) {
      return;
    }
    this.#keys.add(event.key.toLowerCase());

    if (event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      this.#firing = true;
    }
  };

  #onKeyUp = (event: KeyboardEvent): void => {
    this.#keys.delete(event.key.toLowerCase());
    if (event.key === ' ' || event.key === 'Spacebar') this.#firing = false;
  };

  #onBlur = (): void => {
    this.#keys.clear();
    this.#firing = false;
  };

  #onPointerMove = (event: PointerEvent): void => {
    const rect = this.#canvas.getBoundingClientRect();
    this.pointer.x = event.clientX - rect.left;
    this.pointer.y = event.clientY - rect.top;
    this.pointer.inside = true;
  };

  #onPointerDown = (event: PointerEvent): void => {
    if (event.button === 0) this.#firing = true;
  };

  #onPointerUp = (event: PointerEvent): void => {
    if (event.button === 0) this.#firing = false;
  };

  #onPointerLeave = (): void => {
    this.pointer.inside = false;
  };

  #onContextMenu = (event: MouseEvent): void => {
    // Right-drag will pan the camera later; keep the browser menu out of the way.
    event.preventDefault();
  };
}
