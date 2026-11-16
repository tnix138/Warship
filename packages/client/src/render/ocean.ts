import { Container, Graphics, TilingSprite, type Texture } from 'pixi.js';

import {
  RENDER_WATER_PARALLAX,
  RENDER_WATER_SCROLL_X,
  RENDER_WATER_SCROLL_Y,
  RENDER_WATER_TILE_SIZE,
} from '@warship/shared';

/**
 * The ocean.
 *
 * Two layers scrolling at different rates and tints give cheap parallax without a
 * second texture: the far layer is a darkened copy of the same tile. Both are
 * `TilingSprite`s, so the whole ocean costs two draw calls no matter how large the
 * world is.
 *
 * This lives in *screen* space (it ignores the camera), so the water always covers
 * the viewport and never shows an edge.
 */
export class Ocean {
  readonly view = new Container();

  readonly #far: TilingSprite;
  /** Set by `freeze()`; see the note there. */
  #frozen = false;

  readonly #near: TilingSprite;
  readonly #glint: Graphics;

  constructor(texture: Texture, screenWidth: number, screenHeight: number) {
    this.#far = new TilingSprite({
      texture,
      width: screenWidth,
      height: screenHeight,
      tint: 0x6f9fb5,
      alpha: 0.55,
    });
    this.#far.tileScale.set(RENDER_WATER_TILE_SIZE / texture.width / 1.6);
    this.#far.tilePosition.set(12, 4);

    this.#near = new TilingSprite({
      texture,
      width: screenWidth,
      height: screenHeight,
      tint: 0xffffff,
      alpha: 0.92,
    });
    this.#near.tileScale.set(RENDER_WATER_TILE_SIZE / texture.width);

    // A soft vignette keeps the eye on the centre without a post-processing pass.
    this.#glint = new Graphics();
    this.#drawVignette(screenWidth, screenHeight);

    this.view.addChild(this.#far, this.#near, this.#glint);
  }

  /** Keep the water covering the viewport as the window resizes. */
  resize(width: number, height: number): void {
    this.#far.width = width;
    this.#far.height = height;
    this.#near.width = width;
    this.#near.height = height;

    this.#glint.clear();
    this.#drawVignette(width, height);
  }

  /**
   * Advance the current and drift the tiles. `deltaMS` comes from the Pixi ticker.
   *
   * `shipSpeed` is what makes the water read as moving rather than as wallpaper. The
   * tile scroll is the sum of two terms:
   *
   *   - a small constant current, so calm water is never dead frozen;
   *   - the camera's own displacement, scaled by `RENDER_WATER_PARALLAX`, so the surface
   *     streams past at the speed the ship is actually travelling.
   *
   * Without the second term the ocean looks identical whether you are stationary or at
   * flank speed — which is exactly how a static ocean reads, regardless of how nicely
   * the texture animates.
   */
  /**
   * Stop the water dead.
   *
   * The MVP keeps the ocean as a still colour: the parallax exists to sell motion, and
   * against buoys and a grid — both switched off — moving water with nothing to move
   * against just looks like a bug in the texture. `freeze` is a flag on the instance
   * rather than a zero delta so the caller cannot accidentally un-freeze it by passing
   * a speed.
   */
  freeze(): void {
    this.#frozen = true;
    this.#near.tilePosition.set(0, 0);
    this.#far.tilePosition.set(0, 0);
  }

  update(deltaMS: number, shipSpeed = 0): void {
    if (this.#frozen) return;
    const dt = deltaMS / 1000;
    const travel = shipSpeed * RENDER_WATER_PARALLAX;

    this.#near.tilePosition.x += (RENDER_WATER_SCROLL_X + travel) * dt;
    this.#near.tilePosition.y += RENDER_WATER_SCROLL_Y * dt;
    this.#far.tilePosition.x += (RENDER_WATER_SCROLL_X + travel * 0.45) * dt * 0.35;
    this.#far.tilePosition.y += RENDER_WATER_SCROLL_Y * dt * 0.35;
  }

  #drawVignette(width: number, height: number): void {
    // A handful of nested rectangles is cheaper than a shader and reads as depth.
    const steps = 26;
    const maxInset = Math.min(width, height) * 0.34;
    for (let i = 0; i < steps; i += 1) {
      const t = i / steps;
      const inset = maxInset * t;
      this.#glint.roundRect(inset, inset, width - inset * 2, height - inset * 2, 4);
      this.#glint.stroke({ color: 0x02101a, alpha: 0.05 + 0.12 * (1 - t), width: 2 });
    }
  }
}
