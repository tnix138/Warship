import { Container, Graphics } from 'pixi.js';

import {
  CAMERA_DEFAULT_ZOOM,
  CAMERA_FOLLOW_LERP,
  CAMERA_MAX_ZOOM,
  CAMERA_MIN_ZOOM,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from '@warship/shared';

export interface CameraOptions {
  /** Initial focus point, in world units. */
  readonly x?: number;
  readonly y?: number;
  readonly zoom?: number;
}

/**
 * A simple 2D camera: pan by dragging, zoom with the wheel.
 *
 * It owns a `Container` that all world-space display objects hang off. Screen-space
 * UI (the ocean, the HUD) never goes inside it.
 *
 * Zoom is applied around the pointer so the point under the cursor stays put — the
 * detail that makes map navigation feel right.
 */
export class Camera {
  /** Attach world-space objects here. */
  readonly world = new Container();

  #x: number;
  #y: number;
  #zoom: number;
  #viewportWidth = 1;
  #viewportHeight = 1;

  #dragging = false;
  #lastPointer = { x: 0, y: 0 };

  constructor(options: CameraOptions = {}) {
    this.#x = options.x ?? WORLD_WIDTH / 2;
    this.#y = options.y ?? WORLD_HEIGHT / 2;
    this.#zoom = options.zoom ?? CAMERA_DEFAULT_ZOOM;
    this.#apply();
  }

  get x(): number {
    return this.#x;
  }

  get y(): number {
    return this.#y;
  }

  get zoom(): number {
    return this.#zoom;
  }

  /** Visible region in world units, for viewport culling. */
  get viewport(): { x: number; y: number; zoom: number; width: number; height: number } {
    return {
      x: this.#x,
      y: this.#y,
      zoom: this.#zoom,
      width: this.#viewportWidth,
      height: this.#viewportHeight,
    };
  }

  /** Call whenever the renderer resizes. */
  setViewport(width: number, height: number): void {
    this.#viewportWidth = width;
    this.#viewportHeight = height;
    this.#apply();
  }

  /** Move the focus point by a screen-space delta (used by drag-to-pan). */
  panByScreen(dx: number, dy: number): void {
    this.#x = clamp(this.#x - dx / this.#zoom, 0, WORLD_WIDTH);
    this.#y = clamp(this.#y - dy / this.#zoom, 0, WORLD_HEIGHT);
    this.#apply();
  }

  /** Zoom by a multiplicative factor, keeping `(screenX, screenY)` fixed. */
  zoomAt(factor: number, screenX: number, screenY: number): void {
    const next = clamp(this.#zoom * factor, CAMERA_MIN_ZOOM, CAMERA_MAX_ZOOM);
    if (next === this.#zoom) return;

    // World point under the cursor before the zoom change.
    const worldX = this.#x + (screenX - this.#viewportWidth / 2) / this.#zoom;
    const worldY = this.#y + (screenY - this.#viewportHeight / 2) / this.#zoom;

    this.#zoom = next;

    // After zooming, shift the camera so that point stays under the cursor.
    this.#x = clamp(worldX - (screenX - this.#viewportWidth / 2) / this.#zoom, 0, WORLD_WIDTH);
    this.#y = clamp(worldY - (screenY - this.#viewportHeight / 2) / this.#zoom, 0, WORLD_HEIGHT);
    this.#apply();
  }

  /**
   * Ease the camera towards a world point. Used to follow the local ship.
   *
   * @param deltaS seconds since the previous frame; the lerp is frame-rate safe.
   */
  follow(x: number, y: number, deltaS: number): void {
    // Exponential smoothing: the same fraction of the remaining distance per second
    // regardless of frame rate. `1 - e^(-k*dt)` is the exact discrete equivalent.
    const t = 1 - Math.exp(-CAMERA_FOLLOW_LERP * deltaS);
    this.#x = clamp(this.#x + (x - this.#x) * t, 0, WORLD_WIDTH);
    this.#y = clamp(this.#y + (y - this.#y) * t, 0, WORLD_HEIGHT);
    this.#apply();
  }

  /** Convert a screen-space point (CSS pixels, canvas-relative) to world units. */
  screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    return {
      x: this.#x + (screenX - this.#viewportWidth / 2) / this.#zoom,
      y: this.#y + (screenY - this.#viewportHeight / 2) / this.#zoom,
    };
  }

  /** Centre on a world point. */
  focusOn(x: number, y: number): void {
    this.#x = clamp(x, 0, WORLD_WIDTH);
    this.#y = clamp(y, 0, WORLD_HEIGHT);
    this.#apply();
  }

  /**
   * Wire wheel-to-zoom only. Returns a disposer.
   *
   * Separate from `attachInput` because in-game the camera *follows the ship*: if
   * drag-to-pan were also attached, every drag would be undone by the next follow
   * tick, which reads as "the mouse is broken". Zoom is the one camera control that
   * composes with a following camera.
   *
   * `{ passive: false }` is required: the listener calls `preventDefault` to stop
   * the page (or the Codespaces iframe) from scrolling behind the canvas. Without
   * the flag, the browser ignores `preventDefault` and the wheel both zooms and
   * scrolls.
   */
  attachZoom(canvas: HTMLCanvasElement): () => void {
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY * 0.0012);
      this.zoomAt(factor, event.clientX - rect.left, event.clientY - rect.top);
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      canvas.removeEventListener('wheel', onWheel);
    };
  }

  /** Wire pointer input on the canvas. Returns a disposer. */
  attachInput(canvas: HTMLCanvasElement): () => void {
    const onPointerDown = (event: PointerEvent): void => {
      this.#dragging = true;
      this.#lastPointer = { x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
    };

    const onPointerMove = (event: PointerEvent): void => {
      if (!this.#dragging) return;
      const dx = event.clientX - this.#lastPointer.x;
      const dy = event.clientY - this.#lastPointer.y;
      this.#lastPointer = { x: event.clientX, y: event.clientY };
      this.panByScreen(dx, dy);
    };

    const endDrag = (event: PointerEvent): void => {
      if (!this.#dragging) return;
      this.#dragging = false;
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
    };

    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY * 0.0012);
      this.zoomAt(factor, event.clientX - rect.left, event.clientY - rect.top);
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', endDrag);
      canvas.removeEventListener('pointercancel', endDrag);
      canvas.removeEventListener('wheel', onWheel);
    };
  }

  /**
   * Debug grid: a faint lattice plus a brighter world border so orientation is
   * obvious while there is no map art yet.
   */
  createGrid(): Container {
    const grid = new Container();
    const lines = new Graphics();

    const step = 500;
    for (let x = step; x < WORLD_WIDTH; x += step) {
      lines.moveTo(x, 0).lineTo(x, WORLD_HEIGHT);
    }
    for (let y = step; y < WORLD_HEIGHT; y += step) {
      lines.moveTo(0, y).lineTo(WORLD_WIDTH, y);
    }
    lines.stroke({ color: 0x7fd7e8, alpha: 0.09, width: 1 });

    const border = new Graphics()
      .rect(0, 0, WORLD_WIDTH, WORLD_HEIGHT)
      .stroke({ color: 0x4fd1c5, alpha: 0.35, width: 6 });

    grid.addChild(lines, border);
    return grid;
  }

  #apply(): void {
    // Position the world container so the camera focus lands on screen centre.
    this.world.position.set(this.#viewportWidth / 2, this.#viewportHeight / 2);
    this.world.scale.set(this.#zoom, this.#zoom);
    this.world.pivot.set(this.#x, this.#y);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
