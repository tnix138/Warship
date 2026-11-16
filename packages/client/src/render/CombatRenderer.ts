import { Container, Graphics } from 'pixi.js';

import {
  BOX_COLORS,
  NPC_TIER_COLORS,
  RENDER_PROJECTILE_TAIL_ALPHA,
  RENDER_PROJECTILE_TRAIL_LENGTH,
  SHIP_CLASSES,
  type NpcTier,
} from '@warship/shared';

import type { RenderEntity } from '../game/World';

/**
 * Draws everything that is not a player hull: NPC ships, projectiles, loot boxes, and the
 * spawn-shield halo.
 *
 * Deliberately separate from `EntityRenderer`. That class pools a *sprite* per entity
 * because every player is a textured ship; this one draws with `Graphics` because the
 * three new kinds are procedural shapes with per-frame animation, and forcing them
 * through the sprite pool would mean inventing textures for a circle and a crate.
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
      if (pose.kind === 'player') continue; // the ship renderer owns those

      seen.add(pose.id);
      const existing = this.#views.get(pose.id);
      const view = existing ?? this.#create(pose.id);

      const signature = this.#signatureFor(pose, now);
      if (signature !== view.signature) {
        view.signature = signature;
        this.#draw(pose, view.gfx, now);
      }

      view.root.position.set(pose.x, pose.y);
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
      case 'npc': {
        // Hull fraction matters because the bar length depends on it.
        return `npc:${pose.npcTier ?? ''}:${Math.round(pose.hp)}:${Math.round(pose.shield * 10)}`;
      }
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
      case 'npc': {
        this.#drawNpc(pose, gfx);
        break;
      }
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

  /**
   * An NPC: a tier-coloured hull triangle with an HP bar and, while invulnerable, a halo.
   *
   * The shape is drawn bow-up (`-y`) to match the ship textures, and the caller has
   * already applied the `+π/2` rotation, so an NPC points where it is going exactly as a
   * player hull does.
   */
  #drawNpc(pose: RenderEntity, gfx: Graphics): void {
    const tier = pose.npcTier ?? 'small';
    const color = NPC_TIER_COLORS[tier];
    const radius = SHIP_CLASSES.normal.radius;

    /* Hull. A blunt triangle reads as "warship" at a glance without a texture, and the
       tier colour carries the threat level. */
    gfx
      .poly([0, -radius, radius * 0.8, radius * 0.7, 0, radius * 0.4, -radius * 0.8, radius * 0.7])
      .fill({ color, alpha: 0.92 })
      .poly([0, -radius, radius * 0.8, radius * 0.7, 0, radius * 0.4, -radius * 0.8, radius * 0.7])
      .stroke({ color: 0x04121e, width: 1.5, alpha: 0.85 });

    /* HP bar. Always drawn for an NPC, not only when damaged: a tier's hull pool is
       large enough that "looks full" is misleading, and a target without a bar is hard
       to prioritise. */
    const maxHp = this.#maxHpForTier(tier);
    const fraction = Math.max(0, Math.min(1, pose.hp / maxHp));
    const width = 30;
    const offsetY = -radius - 14;

    gfx
      .rect(-width / 2 - 1, offsetY - 1, width + 2, 5)
      .fill({ color: 0x04121e, alpha: 0.75 })
      .rect(-width / 2, offsetY, width * fraction, 3)
      .fill({
        color: fraction > 0.6 ? 0x5cc98a : fraction > 0.3 ? 0xf6c86b : 0xff6b6b,
        alpha: 0.95,
      });

    if (pose.shield > 0) {
      gfx
        .circle(0, 0, radius + 8)
        .stroke({ color: 0x7fd4ff, width: 2, alpha: 0.5 + 0.3 * Math.min(1, pose.shield) });
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

  #maxHpForTier(tier: NpcTier): number {
    switch (tier) {
      case 'medium': {
        return 140;
      }
      case 'large': {
        return 320;
      }
      default: {
        return 60;
      }
    }
  }
}
