import { Assets, type Texture } from 'pixi.js';

import { ShipClass } from '@warship/shared';

/**
 * Asset manifest.
 *
 * Every texture the client may need is declared here with an explicit path, so the
 * bundler and the network tab agree on what is loaded. Files live in
 * `packages/client/public/assets/`.
 *
 * Sprite orientation matters and is easy to get backwards: the ship art faces **south**
 * (bow at the bottom of the image, mast at the top). The renderer rotates by `-π/2` so
 * that world rotation 0 — which the simulation defines as "pointing along +x" — lines
 * up with the art. The bow is at the bottom of every hull PNG (the narrow end), which
 * is what "faces south" means and worth re-checking before touching the rotation.
 */

export const ASSET_URLS = {
  water: '/assets/water-tile.png',
  ships: {
    [ShipClass.Speed]: '/assets/ship-speed.png',
    [ShipClass.Normal]: '/assets/ship-normal.png',
    [ShipClass.Power]: '/assets/ship-power.png',
  },
  /** One hull shared by every NPC tier; the tier is conveyed by scale and ring colour. */
  npc: '/assets/npc.png',
  /** Impact and propulsion particles, smallest first. */
  explosions: ['/assets/explosion3.png', '/assets/explosion2.png', '/assets/explosion1.png'],
  fire: ['/assets/fire2.png', '/assets/fire1.png'],
} as const satisfies {
  water: string;
  ships: Record<ShipClass, string>;
  npc: string;
  explosions: readonly string[];
  fire: readonly string[];
};

export interface GameTextures {
  readonly water: Texture;
  readonly ships: Readonly<Record<ShipClass, Texture>>;
  readonly npc: Texture;
  readonly explosions: readonly Texture[];
  readonly fire: readonly Texture[];
}

let cached: Promise<GameTextures> | null = null;

/** Load every texture once; concurrent callers share the same promise. */
export function loadTextures(): Promise<GameTextures> {
  cached ??= (async () => {
    const [water, speed, normal, power, npc, ...particles] = await Promise.all([
      Assets.load<Texture>(ASSET_URLS.water),
      Assets.load<Texture>(ASSET_URLS.ships[ShipClass.Speed]),
      Assets.load<Texture>(ASSET_URLS.ships[ShipClass.Normal]),
      Assets.load<Texture>(ASSET_URLS.ships[ShipClass.Power]),
      Assets.load<Texture>(ASSET_URLS.npc),
      ...ASSET_URLS.explosions.map((url) => Assets.load<Texture>(url)),
      ...ASSET_URLS.fire.map((url) => Assets.load<Texture>(url)),
    ]);

    const explosionCount = ASSET_URLS.explosions.length;
    const explosions = particles.slice(0, explosionCount);
    const fire = particles.slice(explosionCount);

    return {
      water,
      ships: { [ShipClass.Speed]: speed, [ShipClass.Normal]: normal, [ShipClass.Power]: power },
      npc,
      explosions,
      fire,
    };
  })().catch((error: unknown) => {
    // Allow a later retry (e.g. after the assets were copied in).
    cached = null;
    throw new Error(
      'Failed to load game textures. ' +
        'Check that every file listed in ASSET_URLS exists in public/assets.',
      { cause: error },
    );
  });

  return cached;
}
