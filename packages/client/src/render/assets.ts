import { Assets, type Texture } from 'pixi.js';

import { ShipClass } from '@warship/shared';

/**
 * Asset manifest.
 *
 * Every texture the client may need is declared here with an explicit path, so the
 * bundler and the network tab agree on what is loaded. Files live in
 * `packages/client/public/assets/` and are produced by `pnpm assets:generate`
 * (placeholder art today, licensed kenney.nl art later — no code changes needed).
 */

export const ASSET_URLS = {
  water: '/assets/water-tile.png',
  ships: {
    [ShipClass.Speed]: '/assets/ship-scout.png',
    [ShipClass.Normal]: '/assets/ship-destroyer.png',
    [ShipClass.Power]: '/assets/ship-battleship.png',
  },
} as const satisfies {
  water: string;
  ships: Record<ShipClass, string>;
};

export interface GameTextures {
  readonly water: Texture;
  readonly ships: Readonly<Record<ShipClass, Texture>>;
}

let cached: Promise<GameTextures> | null = null;

/** Load every texture once; concurrent callers share the same promise. */
export function loadTextures(): Promise<GameTextures> {
  cached ??= (async () => {
    const [water, speed, normal, power] = await Promise.all([
      Assets.load<Texture>(ASSET_URLS.water),
      Assets.load<Texture>(ASSET_URLS.ships[ShipClass.Speed]),
      Assets.load<Texture>(ASSET_URLS.ships[ShipClass.Normal]),
      Assets.load<Texture>(ASSET_URLS.ships[ShipClass.Power]),
    ]);

    return {
      water,
      ships: { [ShipClass.Speed]: speed, [ShipClass.Normal]: normal, [ShipClass.Power]: power },
    };
  })().catch((error: unknown) => {
    // Allow a later retry (e.g. after the assets were generated).
    cached = null;
    throw new Error(
      'Failed to load game textures. ' +
        'Run `pnpm --filter @warship/client run assets:generate` if public/assets is empty.',
      { cause: error },
    );
  });

  return cached;
}
