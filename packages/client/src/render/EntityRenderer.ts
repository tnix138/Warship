import { Container, Graphics, Sprite } from 'pixi.js';

import { RENDER_SELF_RING_PULSE_MS, SHIP_CLASSES, type ShipClass } from '@warship/shared';

import type { RenderEntity } from '../game/World';
import type { GameTextures } from './assets';

/**
 * Draws the poses `ClientWorld.renderEntities()` hands it.
 *
 * The renderer knows nothing about snapshots, ticks, interpolation or prediction: it
 * receives a list of poses with an alpha and places pooled sprites at those poses.
 * That separation is why interpolation and prediction could be added without
 * touching a single line of drawing code.
 *
 * Sprites are pooled by entity id, so a steady 100-player scene allocates nothing per
 * frame; departed entities fade out rather than vanishing on the frame they leave AoI.
 */

interface ShipView {
  readonly root: Container;
  readonly sprite: Sprite;
  readonly healthBar: Graphics;
  /** Blinks only for the local player. */
  readonly selfRing: Graphics;
  shipClass: ShipClass;
}

export class EntityRenderer {
  readonly view = new Container();

  readonly #textures: GameTextures;
  readonly #views = new Map<string, ShipView>();
  readonly #barWidth = 34;

  constructor(textures: GameTextures) {
    this.#textures = textures;
    this.view.eventMode = 'none';
  }

  /**
   * Sync the display list with one frame's poses.
   *
   * @param poses what to draw, already interpolated/predicted by the caller.
   * @param now frame timestamp in ms, driving the self-ring pulse.
   */
  update(poses: readonly RenderEntity[], now: number): void {
    const seen = new Set<string>();

    for (const pose of poses) {
      seen.add(pose.id);
      const view = this.#viewFor(pose);
      this.#apply(pose, view, now);
    }

    for (const [id, view] of this.#views) {
      if (seen.has(id)) continue;
      view.root.destroy({ children: true });
      this.#views.delete(id);
    }
  }

  /** Number of ships currently drawn. */
  get drawnCount(): number {
    return this.#views.size;
  }

  destroy(): void {
    for (const view of this.#views.values()) {
      view.root.destroy({ children: true });
    }
    this.#views.clear();
    this.view.destroy({ children: true });
  }

  /* ------------------------------------------------------------------------ */
  /*  Internals                                                               */
  /* ------------------------------------------------------------------------ */

  #viewFor(entity: RenderEntity): ShipView {
    const existing = this.#views.get(entity.id);
    if (existing !== undefined) {
      // A late-joining entity can change class; swap the texture if it does.
      if (existing.shipClass !== entity.shipClass) {
        existing.sprite.texture = this.#textures.ships[entity.shipClass];
        existing.shipClass = entity.shipClass;
      }
      return existing;
    }

    const root = new Container();
    const sprite = new Sprite(this.#textures.ships[entity.shipClass]);
    sprite.anchor.set(0.5);

    const healthBar = new Graphics();
    const selfRing = new Graphics();
    selfRing.visible = false;

    // Ring under the ship, health bar above it: z-order is explicit.
    root.addChild(selfRing, sprite, healthBar);
    this.view.addChild(root);

    const view: ShipView = { root, sprite, healthBar, selfRing, shipClass: entity.shipClass };
    this.#views.set(entity.id, view);
    return view;
  }

  #apply(entity: RenderEntity, view: ShipView, now: number): void {
    const isSelf = entity.isSelf;

    // Removal fade: the frame a ship leaves the area of interest it lingers briefly
    // at decreasing alpha instead of popping out of existence.
    view.root.alpha = entity.alpha;
    view.root.visible = entity.alpha > 0.01;

    view.root.position.set(entity.x, entity.y);
    // Textures are drawn bow-up (-y); rotate 90° so rotation 0 faces +x.
    view.root.rotation = entity.rotation + Math.PI / 2;

    const definition = SHIP_CLASSES[entity.shipClass];
    const radius = definition.radius;

    /* Self ring: a pulsing circle so the player can always find their own ship. */
    if (isSelf) {
      const pulse = 0.5 + 0.5 * Math.sin((now / RENDER_SELF_RING_PULSE_MS) * Math.PI * 2);
      view.selfRing.visible = true;
      view.selfRing
        .clear()
        .circle(0, 0, radius + 10 + pulse * 5)
        .stroke({ color: 0x4fd1c5, alpha: 0.45 + pulse * 0.35, width: 2 });
    } else {
      view.selfRing.visible = false;
    }

    /* Health bar: only drawn when the ship is damaged, to keep the view clean. */
    const maxHp = Math.max(1, definition.hp);
    const fraction = Math.max(0, Math.min(1, entity.hp / maxHp));

    view.healthBar.clear();
    if (fraction < 0.999) {
      // The bar lives in the ship's local (rotated) frame, so counter-rotate it to
      // stay horizontal on screen.
      view.healthBar.rotation = -view.root.rotation;

      const width = this.#barWidth;
      const offsetY = -radius - 16;
      const color = fraction > 0.6 ? 0x4fd1c5 : fraction > 0.3 ? 0xf6c86b : 0xff6b6b;

      view.healthBar
        .rect(-width / 2 - 1, offsetY - 1, width + 2, 6)
        .fill({ color: 0x04121e, alpha: 0.75 })
        .rect(-width / 2, offsetY, width * fraction, 4)
        .fill({ color, alpha: 0.95 });
    }
  }
}
