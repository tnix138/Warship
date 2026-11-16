import { NPC_TIER_COLORS, type NpcTier, WORLD_HEIGHT, WORLD_WIDTH } from '@warship/shared';

import type { ClientWorld } from '../game/World';

/**
 * The round radar in the top-right corner.
 *
 * ## Why a local radar, not a scaled-down map
 *
 * The world is 8000×8000 on a torus and the client's area of interest is 3000 units. A
 * minimap showing the whole world would therefore draw most of it blank — not because it
 * is empty, but because the client was never sent it. Blank would read as "empty sea",
 * which is a lie. So this shows a **fixed range around the player** instead: every blip
 * is something the client genuinely knows about, and the range is stated in the frame.
 *
 * ## Why Canvas 2D and not Pixi
 *
 * The main scene is already a WebGL context. Spinning up a second one for a 180 px disc
 * costs a texture upload path, a context-loss handler and a browser context-limit slot,
 * to draw two dozen circles. Canvas 2D does this in ~0.1 ms and degrades gracefully. The
 * *game* being on Pixi is not a reason for the *radar* to be.
 *
 * ## Orientation
 *
 * Ship-local: up on the radar is always ahead. North-up is simpler to implement but
 * forces the player to mentally rotate the entire display while steering, which is the
 * one moment they have least attention to spare. The `N` marker on the frame is
 * therefore decorative — see the note on the DOM element.
 */

/** World units from the centre of the radar to its edge. Stated in the HUD. */
const RADAR_RANGE = 1_800;

const COLOR_SELF = '#4fd1c5';
const COLOR_BOX = '#f6c86b';
const COLOR_SHOT = '#dd9a5b';
const COLOR_TARGET = '#ff4d4d';

/** Blip radius in CSS pixels. */
const BLIP_SELF = 3.4;
const BLIP_NPC = 2.4;
const BLIP_BOX = 2;
const BLIP_SHOT = 1.3;

export class Minimap {
  readonly #canvas: HTMLCanvasElement;
  readonly #ctx: CanvasRenderingContext2D | null;

  /** Size in CSS pixels; the backing store is larger on high-DPI screens. */
  #size = 180;
  #dpr = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
    this.#ctx = canvas.getContext('2d');
    this.resize();
  }

  /**
   * Match the backing store to the element's CSS size and the device pixel ratio.
   *
   * Called on construction and on window resize. Without the DPR scale the disc is
   * visibly soft on a retina display, and without the CSS-size match the drawing is
   * stretched as soon as the media query shrinks it.
   */
  resize(): void {
    const rect = this.#canvas.getBoundingClientRect();
    const size = Math.max(1, Math.round(rect.width || this.#size));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.#size = size;
    this.#dpr = dpr;
    this.#canvas.width = Math.round(size * dpr);
    this.#canvas.height = Math.round(size * dpr);
  }

  /** Repaint the radar for one frame. */
  update(world: ClientWorld, now: number): void {
    const ctx = this.#ctx;
    if (ctx === null) return;

    const size = this.#size;
    const center = size / 2;
    const radius = center - 4;
    const scale = radius / RADAR_RANGE;

    ctx.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    /* Clip everything to the disc so a contact at the edge is cropped rather than drawn
       over the frame. */
    ctx.save();
    ctx.beginPath();
    ctx.arc(center, center, radius, 0, Math.PI * 2);
    ctx.clip();

    ctx.fillStyle = '#06263f';
    ctx.fillRect(0, 0, size, size);

    /* Range rings: half and full. One ring alone gives no sense of "close vs far". */
    ctx.strokeStyle = 'rgba(79, 209, 197, 0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(center, center, radius * 0.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(79, 209, 197, 0.22)';
    ctx.beginPath();
    ctx.arc(center, center, radius, 0, Math.PI * 2);
    ctx.stroke();

    const self = world.self;
    if (self === undefined) {
      /* Still joining, or dead between snapshots. An empty disc is honest; a frozen
         previous frame is not. */
      ctx.restore();
      this.#drawFrame(ctx, center, radius);
      return;
    }

    /* Rotate into the ship's frame: subtract its heading. */
    const cos = Math.cos(-self.rotation);
    const sin = Math.sin(-self.rotation);
    const lockedId = self.targetId ?? null;

    /* Half the world is the furthest anything can be before the shorter path wraps. */
    const halfW = WORLD_WIDTH / 2;
    const halfH = WORLD_HEIGHT / 2;

    for (const entity of world.entities.values()) {
      if (entity.id === self.id) continue;
      if (entity.kind !== 'npc' && entity.kind !== 'box' && entity.kind !== 'projectile') continue;

      let dx = entity.x - self.x;
      let dy = entity.y - self.y;
      if (dx > halfW) dx -= WORLD_WIDTH;
      else if (dx < -halfW) dx += WORLD_WIDTH;
      if (dy > halfH) dy -= WORLD_HEIGHT;
      else if (dy < -halfH) dy += WORLD_HEIGHT;

      const distance = Math.hypot(dx, dy);
      if (distance > RADAR_RANGE) continue;

      /* Rotate *then* scale: scaling first would apply the range limit to a rotated
         vector, which distorts nothing but reads wrong the moment the code is edited. */
      const rx = center + (dx * cos - dy * sin) * scale;
      const ry = center + (dx * sin + dy * cos) * scale;

      const isTarget = entity.id === lockedId;

      if (entity.kind === 'box') {
        ctx.fillStyle = COLOR_BOX;
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        ctx.arc(rx, ry, BLIP_BOX, 0, Math.PI * 2);
        ctx.fill();
      } else if (entity.kind === 'projectile') {
        ctx.fillStyle = COLOR_SHOT;
        ctx.globalAlpha = 0.4;
        ctx.beginPath();
        ctx.arc(rx, ry, BLIP_SHOT, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = isTarget ? COLOR_TARGET : tierColor(entity.npcTier);
        ctx.globalAlpha = 0.92;
        ctx.beginPath();
        ctx.arc(rx, ry, BLIP_NPC, 0, Math.PI * 2);
        ctx.fill();

        if (isTarget) {
          /* A pulsing halo: at 2.4 px the dot itself cannot answer "which one am I
             locked on", and that is the most important question the radar answers. */
          const pulse = 0.5 + 0.5 * Math.sin((now / 320) * Math.PI * 2);
          ctx.globalAlpha = 0.5;
          ctx.strokeStyle = COLOR_TARGET;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(rx, ry, BLIP_NPC + 2 + pulse * 2, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }

    ctx.globalAlpha = 1;

    /* Own ship: dead centre, pointing up, with a short heading tick. */
    ctx.fillStyle = COLOR_SELF;
    ctx.beginPath();
    ctx.arc(center, center, BLIP_SELF, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = COLOR_SELF;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(center, center - BLIP_SELF - 1);
    ctx.lineTo(center, center - BLIP_SELF - 5);
    ctx.stroke();

    ctx.restore();
    this.#drawFrame(ctx, center, radius);
  }

  destroy(): void {
    /* Nothing to release: the canvas is owned by the DOM and the 2D context has no
       explicit teardown. Kept for symmetry with the other renderers' lifecycle. */
  }

  /** Dark outline + cyan rim, drawn last so it sits above the clipped contents. */
  #drawFrame(ctx: CanvasRenderingContext2D, center: number, radius: number): void {
    ctx.strokeStyle = '#0d1b26';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(center, center, radius + 2, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(125, 211, 252, 0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(center, center, radius + 2, 0, Math.PI * 2);
    ctx.stroke();
  }
}

/** Blip colour for an NPC tier; the radar uses the hull tint, not the threat ring. */
function tierColor(tier: NpcTier | undefined): string {
  const color = tier === undefined ? 0xdd9a5b : NPC_TIER_COLORS[tier];
  return `#${color.toString(16).padStart(6, '0')}`;
}
