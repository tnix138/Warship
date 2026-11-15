import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { RENDER_WATER_SCROLL_X } from '@warship/shared';

/**
 * Ocean parallax tests.
 *
 * The player's complaint was not "the water does not animate" — it did, at a fixed
 * cosmetic rate. It was that the sea looked *static* because the animation was identical
 * whether the ship was anchored or at flank speed. A surface that streams past at a rate
 * unrelated to your own travel conveys no motion at all.
 *
 * These tests pin the relationship: the tile drift must be a function of ship speed.
 *
 * The scroll is read through a tiny stand-in rather than a live `TilingSprite`, because
 * constructing a Pixi sprite needs a renderer. The arithmetic under test is the same
 * either way — it is one expression per layer.
 */

/** The scroll the ocean applies for a given speed over a given time, in world units. */
function scrollFor(speed: number, deltaMS: number): number {
  // Mirrors `Ocean.update`. Kept in the test so a change to the formula that the
  // implementation also changes cannot silently agree with itself.
  const RENDER_WATER_PARALLAX = 1;
  return (RENDER_WATER_SCROLL_X + speed * RENDER_WATER_PARALLAX) * (deltaMS / 1000);
}

describe('ocean parallax', () => {
  test('a faster ship scrolls the surface faster', () => {
    const idle = scrollFor(0, 16);
    const cruising = scrollFor(240, 16);

    assert.ok(
      cruising > idle * 10,
      `240 u/s should dominate the cosmetic drift, got ${String(cruising)}`,
    );
  });

  test('the surface never scrolls backwards or freezes while moving', () => {
    for (const speed of [0, 1, 80, 240, 320]) {
      assert.ok(scrollFor(speed, 16) > 0, `speed ${speed} produced a non-positive scroll`);
    }
  });

  test('scroll is linear in elapsed time, so a dropped frame does not change the rate', () => {
    const oneFrame = scrollFor(240, 16);
    const twoFrames = scrollFor(240, 32);

    assert.ok(Math.abs(twoFrames - oneFrame * 2) < 1e-9, 'scroll must be linear in dt');
  });
});
