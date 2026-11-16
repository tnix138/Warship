import { Container, Graphics } from 'pixi.js';

import {
  BOX_COLORS,
  RENDER_PROJECTILE_TAIL_ALPHA,
  RENDER_PROJECTILE_TRAIL_LENGTH,
} from '@warship/shared';

import type { RenderEntity } from '../game/World';

/**
 * Draws the things that are not hulls: shots and loot crates.
 *
 * Deliberately separate from `EntityRenderer`. That class pools a *sprite* per entity
 * because hulls are textured ships; this one draws with `Graphics` because a tracer and
 * a crate are procedural shapes with per-frame animation, and forcing them through the
 * sprite pool would mean inventing textures for them.
 *
 * The split is one owner per `kind`, and it is enforced at the top of `update` rather
 * than left to the caller. Both classes used to accept whatever they were handed, and
 * the result was that every shot was drawn as a full ship sprite *and* every NPC as a
 * flat triangle underneath its own hull texture.
 *
 * Everything is pooled by entity id, so a busy fight allocates nothing per frame.
 */

interface ShapeView {
  readonly root: Container;
  readonly gfx: Graphics;
  /** Cached so a shape is only re-drawn when its visual inputs change. */
  signature: string;
}

/** Re-draw a pooled shape at most this often for animations that are time-based. */
const ANIMATION_QUANTUM_MS = 50;

export class CombatRenderer {
  readonly view = new Container();

  readonly #views = new Map<string, ShapeView>();

  constructor() {
    this.view.eventMode = 'none';
  }

  get drawnCount(): number {
    return this.#views.size;
  }

  update(poses: readonly RenderEntity[], now: number): void {
    const seen = new Set<string>();

    for (const pose of poses) {
      /* NPCs belong to `EntityRenderer`: they have a hull texture, tier scaling, a tier
         ring, a lock ring and a health bar, all of which that class already draws.

         This renderer used to draw them as well, over an opaque triangle. Two things
         were wrong with that and only one of them was cosmetic: the triangle sat on top
         of the sprite so NPCs read as flat shapes rather than ships, and the shape was
         never rotated, so an NPC's "bow" always pointed north while its sprite turned.
         Keeping one owner per kind is what stops that from coming back. */
      if (pose.kind !== 'projectile' && pose.kind !== 'box') continue;

      seen.add(pose.id);
      const existing = this.#views.get(pose.id);
      const view = existing ?? this.#create(pose.id);

      const signature = this.#signatureFor(pose, now);
      if (signature !== view.signature) {
        view.signature = signature;
        this.#draw(pose, view.gfx, now);
      }

      view.root.position.set(pose.x, pose.y);
      /* The streak is drawn along local +x, so the root has to carry the shot's heading
         or every tracer points due east. This is the only kind that needs a rotation:
         crates spin on their own timer in `#drawBox`. */
      view.root.rotation = pose.kind === 'projectile' ? pose.rotation : 0;
      view.root.alpha = pose.alpha;
      view.root.visible = pose.alpha > 0.01;
    }

    for (const [id, view] of this.#views) {
      if (seen.has(id)) continue;
      view.root.destroy({ children: true });
      this.#views.delete(id);
    }
  }

  destroy(): void {
    for (const view of this.#views.values()) view.root.destroy({ children: true });
    this.#views.clear();
    this.view.destroy({ children: true });
  }

  /* ------------------------------------------------------------------------ */
  /*  Internals                                                               */
  /* ------------------------------------------------------------------------ */

  #create(id: string): ShapeView {
    const root = new Container();
    const gfx = new Graphics();
    root.addChild(gfx);
    this.view.addChild(root);

    const view: ShapeView = { root, gfx, signature: '' };
    this.#views.set(id, view);
    return view;
  }

  /**
   * A string that changes exactly when the drawing must change.
   *
   * Redrawing a `Graphics` every frame for 300 projectiles is the kind of thing that
   * quietly halves the frame rate; comparing a short string first keeps a static crate
   * to zero work while still letting a shot's tail animate.
   */
  #signatureFor(pose: RenderEntity, now: number): string {
    switch (pose.kind) {
      case 'projectile': {
        return `proj:${Math.round(pose.rotation * 100)}`;
      }
      case 'box': {
        return `box:${pose.boxKind ?? ''}:${Math.floor(now / ANIMATION_QUANTUM_MS)}`;
      }
      default: {
        return 'other';
      }
    }
  }

  #draw(pose: RenderEntity, gfx: Graphics, now: number): void {
    gfx.clear();

    switch (pose.kind) {
      case 'projectile': {
        this.#drawProjectile(gfx);
        break;
      }
      case 'box': {
        this.#drawBox(pose, gfx, now);
        break;
      }
      default: {
        break;
      }
    }
  }

  /** A shot: a bright streak along its heading, with a faint tail behind it. */
  #drawProjectile(gfx: Graphics): void {
    const length = RENDER_PROJECTILE_TRAIL_LENGTH;
    const halfWidth = 2.5;

    /* Drawn in the entity's own frame, pointing along +x (the caller rotated it to the
       shot's heading), so the streak always trails the direction of travel. */
    gfx
      .poly([-length, 0, 0, -halfWidth, length * 0.35, 0, 0, halfWidth])
      .fill({ color: 0xffe66b, alpha: 0.95 })
      .circle(0, 0, 2.2)
      .fill({ color: 0xfffbe0, alpha: 1 });

    // Tail: fades out, giving the eye something to track at 720 u/s.
    gfx
      .poly([-length, 0, 0, -halfWidth * 0.7, 0, halfWidth * 0.7])
      .fill({ color: 0xffc84a, alpha: RENDER_PROJECTILE_TAIL_ALPHA });
  }

  /** A loot crate: a rotating square with a slow pulse, coloured by payload. */
  #drawBox(pose: RenderEntity, gfx: Graphics, now: number): void {
    const kind = pose.boxKind ?? 'scrap';
    const color = BOX_COLORS[kind];
    const pulse = 0.5 + 0.5 * Math.sin(now / 260);

    const size = 9 + pulse * 1.5;

    gfx
      .rect(-size, -size, size * 2, size * 2)
      .fill({ color, alpha: 0.9 })
      .rect(-size, -size, size * 2, size * 2)
      .stroke({ color: 0x04121e, width: 1.5, alpha: 0.8 });

    // A soft aura so a crate is findable against the water.
    gfx.circle(0, 0, size + 5 + pulse * 3).stroke({ color, width: 1, alpha: 0.25 + pulse * 0.2 });
  }
}
