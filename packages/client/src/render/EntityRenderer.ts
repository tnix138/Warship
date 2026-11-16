import { Container, Graphics, Sprite, type Texture } from 'pixi.js';

import {
  DEFAULT_SHIP_CLASS,
  NPC_STATS,
  NpcTier,
  RENDER_SELF_RING_PULSE_MS,
  SHIP_CLASSES,
  type ShipClass,
} from '@warship/shared';

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

/**
 * Sprite art faces south, so the world angle needs a quarter turn to line up.
 *
 * The simulation defines rotation 0 as pointing along +x. The art's bow points along
 * +y (down the image), and rotating +y by `-π/2` lands on +x. Using `+π/2` — the
 * intuitive-looking sign — draws every ship 180° backwards, which is exactly the bug
 * this comment exists to stop someone from "fixing".
 */
const SPRITE_QUARTER_TURN = -Math.PI / 2;

/**
 * Half the sprite's longest side, in world units.
 *
 * The hull art is 66×113 with the bow along the long axis, so the long side is what a
 * ring has to clear. Falls back to a sane constant if a texture reports no size (which
 * happens before its image has decoded).
 */
function visualRadius(texture: Texture, scale: number): number {
  const longest = Math.max(texture.width, texture.height);
  if (!Number.isFinite(longest) || longest <= 0) return 34 * scale;
  return (longest / 2) * scale;
}

/** Opacity of the lock line. Faint on purpose: a hint, not a laser sight. */
const AIM_LINE_ALPHA = 0.2;

/** Scale per tier, so a Warship reads as huge before it has fired a shot. */
const NPC_TIER_SCALE: Readonly<Record<NpcTier, number>> = {
  [NpcTier.Small]: 0.7,
  [NpcTier.Medium]: 1,
  [NpcTier.Large]: 1.5,
};

/**
 * Threat ring per tier: a traffic light, not the faction's hull paint.
 *
 * Kept separate from `NPC_TIER_COLORS` on purpose. Those greens/oranges/purples describe
 * who the ship is; these greens/yellows/reds describe whether the player should fight it.
 * Reusing one palette for both makes "orange" mean two different things at once.
 */
const TIER_RING_COLORS: Readonly<Record<NpcTier, number>> = {
  [NpcTier.Small]: 0x4ade80,
  [NpcTier.Medium]: 0xfacc15,
  [NpcTier.Large]: 0xef4444,
};

interface ShipView {
  readonly root: Container;
  readonly sprite: Sprite;
  readonly healthBar: Graphics;
  /** Blinks only for the local player. */
  readonly selfRing: Graphics;
  /** Threat ring under an NPC, coloured by tier. */
  readonly tierRing: Graphics;
  /** Red lock ring, drawn thicker when the player chose the target by hand. */
  readonly targetRing: Graphics;
  /** Hull class last drawn; `undefined` for NPCs/projectiles, which have none. */
  shipClass?: ShipClass;
}

export class EntityRenderer {
  /* Draws hulls only: players and NPCs. Projectiles and crates belong to
     `CombatRenderer`, and passing them here is what made shots look like ships. */
  readonly view = new Container();

  /**
   * Faint line from our ship to whatever the server has it locked on.
   *
   * Lives on the renderer's own view rather than on a ship root, because there is only
   * ever one of them and it spans the gap *between* two entities. Alpha 0.2: it is a
   * hint that a lock exists, not a laser sight, and at full strength it would be the
   * brightest thing on screen.
   */
  readonly #aimLine = new Graphics();

  readonly #textures: GameTextures;
  readonly #views = new Map<string, ShipView>();
  readonly #barWidth = 34;

  constructor(textures: GameTextures) {
    this.#textures = textures;
    this.view.eventMode = 'none';
    /* Behind the ships: a line crossing a hull should look like it goes under it. */
    this.view.addChild(this.#aimLine);
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
      /* Only hulls get a sprite. This loop used to take every pose it was handed, and
         `Game` hands it the whole world, so a projectile — which is a 6-unit point with
         no hull class — was drawn with a full 113 px ship texture. The result looked like
         ships being fired out of cannons: every shot was a hull flying across the water,
         with the little tracer streak hidden underneath it. Crates had the same problem.

         `CombatRenderer` owns both of those kinds. The split is by kind, not by "who got
         there first": players and NPCs are hulls with art, tier scaling, rings and bars;
         projectiles and boxes are procedural shapes. */
      if (pose.kind !== 'player' && pose.kind !== 'npc') continue;

      seen.add(pose.id);
      const view = this.#viewFor(pose);
      this.#apply(pose, view, now);
    }

    for (const [id, view] of this.#views) {
      if (seen.has(id)) continue;
      view.root.destroy({ children: true });
      this.#views.delete(id);
    }

    this.#drawAimLine(poses);
  }

  /**
   * Draw the line from our ship to its target, if it has one.
   *
   * Both endpoints come from the same frame, so the line can never lag the ring it
   * belongs to.
   */
  #drawAimLine(poses: readonly RenderEntity[]): void {
    this.#aimLine.clear();

    const self = poses.find((pose) => pose.isSelf);
    if (self === undefined) return;

    const target = poses.find((pose) => pose.targeted === true);
    if (target === undefined) return;

    this.#aimLine
      .moveTo(self.x, self.y)
      .lineTo(target.x, target.y)
      .stroke({ color: 0xff8a8a, alpha: AIM_LINE_ALPHA, width: 1.5 });
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
        existing.sprite.texture = this.#textureFor(entity);
        existing.shipClass = entity.shipClass;
      }
      return existing;
    }

    const root = new Container();
    const sprite = new Sprite(this.#textureFor(entity));
    sprite.anchor.set(0.5);

    const healthBar = new Graphics();
    const selfRing = new Graphics();
    const tierRing = new Graphics();
    const targetRing = new Graphics();
    selfRing.visible = false;
    tierRing.visible = false;
    targetRing.visible = false;

    /* Rings first, then the hull, then bars on top: z-order is explicit rather than
       whatever the add order happened to be. */
    root.addChild(tierRing, targetRing, sprite, selfRing, healthBar);
    this.view.addChild(root);

    const view: ShipView = {
      root,
      sprite,
      healthBar,
      selfRing,
      tierRing,
      targetRing,
      shipClass: entity.shipClass,
    };
    this.#views.set(entity.id, view);
    return view;
  }

  /**
   * The hull texture for one entity: NPCs share one sprite, players get theirs.
   *
   * A player record that somehow arrives without a class falls back to the default
   * hull rather than indexing a record with `undefined` — a wrong sprite is a
   * cosmetic bug, a crash is a black screen.
   */
  #textureFor(entity: RenderEntity): Texture {
    if (entity.kind === 'npc') return this.#textures.npc;
    const shipClass = entity.shipClass ?? DEFAULT_SHIP_CLASS;
    return this.#textures.ships[shipClass];
  }

  #apply(entity: RenderEntity, view: ShipView, now: number): void {
    const isSelf = entity.isSelf;

    // Removal fade: the frame a ship leaves the area of interest it lingers briefly
    // at decreasing alpha instead of popping out of existence.
    view.root.alpha = entity.alpha;
    view.root.visible = entity.alpha > 0.01;

    view.root.position.set(entity.x, entity.y);
    view.root.rotation = entity.rotation + SPRITE_QUARTER_TURN;

    /* Tier is the primary threat signal, and it is a *scale*, so it has to be applied
       to the sprite rather than the root: scaling the root would scale the rings and
       the bars too, making a Warship's health bar three times as wide as a Coastal's
       for no reason. */
    const npcTier = entity.kind === 'npc' ? entity.npcTier : undefined;
    const scale = npcTier === undefined ? 1 : NPC_TIER_SCALE[npcTier];
    view.sprite.scale.set(scale);

    const definition = SHIP_CLASSES[entity.shipClass ?? DEFAULT_SHIP_CLASS];

    /* Radius for *drawing*, which is not `definition.radius`.
       That field is a collision radius (20 units for a Normal hull) while the art is
       113 px tall, so a ring at `radius + 6` ends up completely hidden underneath the
       sprite — every ring and every lock indicator silently invisible. Deriving the
       visual radius from the texture keeps rings outside the hull whatever art is
       dropped in, which is the point of keeping art and physics separate. */
    const radius = visualRadius(view.sprite.texture, scale);

    /* Threat ring under every NPC: green / yellow / red by tier. Drawn in the root's
       frame, which rotates with the hull, so it must be an ellipse to stay circular —
       cheaper and simpler than a counter-rotating child for something the player only
       needs to read the colour of. */
    if (npcTier !== undefined) {
      view.tierRing.visible = true;
      view.tierRing
        .clear()
        .circle(0, 0, radius + 6)
        .stroke({ color: TIER_RING_COLORS[npcTier], alpha: 0.55, width: 2 });
    } else {
      view.tierRing.visible = false;
    }

    /* Target ring: the enemy the *server* is currently shooting at. `targeted` comes
       straight from the snapshot's `targetId`, so the ring cannot promise a shot the
       server is not actually taking. */
    if (entity.targeted === true && !isSelf) {
      view.targetRing.visible = true;
      view.targetRing
        .clear()
        .circle(0, 0, radius + 12)
        .stroke({ color: 0xff4d4d, alpha: 0.9, width: 3 });
    } else {
      view.targetRing.visible = false;
    }

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

    /* Health bar. Every NPC always shows one — the player needs to know how much of a
       Warship is left *before* committing to the fight, and a ring alone says nothing
       about damage. The local player's ship keeps the old rule (only when hurt) so the
       screen stays clean while nothing is happening. */
    /* Max hull per kind: a player's comes from its class, an NPC's from its tier.
       Using the class table for an NPC was the second half of the same bug — a Coastal
       has 60 hull but was measured against a Normal hull's 140, so every NPC's bar
       started two-thirds empty. */
    const maxHp = Math.max(1, npcTier === undefined ? definition.hp : NPC_STATS[npcTier].maxHp);
    const fraction = Math.max(0, Math.min(1, entity.hp / maxHp));
    const showBar = npcTier !== undefined || fraction < 0.999;

    view.healthBar.clear();
    if (showBar) {
      // The bar lives in the ship's local (rotated) frame, so counter-rotate it to
      // stay horizontal on screen.
      view.healthBar.rotation = -view.root.rotation;

      /* `radius` is the visual one now, so this clears the sprite instead of landing on
         top of it. The bar is counter-rotated, so -y is always screen-up. */
      const width = this.#barWidth;
      const offsetY = -radius - 10;
      const color = fraction > 0.6 ? 0x4fd1c5 : fraction > 0.3 ? 0xf6c86b : 0xff6b6b;

      view.healthBar
        .rect(-width / 2 - 1, offsetY - 1, width + 2, 6)
        .fill({ color: 0x04121e, alpha: 0.75 })
        .rect(-width / 2, offsetY, width * fraction, 4)
        .fill({ color, alpha: 0.95 });
    }
  }
}
