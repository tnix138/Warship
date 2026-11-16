import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { Interpolation } from './Interpolation';

/**
 * Interpolation unit tests.
 *
 * The interesting cases are not "does it blend two numbers" — they are the edges:
 * rotation across the ±π seam, a client with no frames yet, a delta that omits an
 * entity, and an entity that leaves and must be faded rather than popped.
 */

const DELAY = 100;

/** Build one frame with a single entity at `x`. */
function frameAt(
  tick: number,
  x: number,
  rotation = 0,
): {
  tick: number;
  serverTime: number;
  entities: {
    id: string;
    x: number;
    y: number;
    rotation: number;
    hp: number;
    shipClass: string;
  }[];
} {
  return {
    tick,
    serverTime: tick * 50,
    entities: [{ id: 'a', x, y: 0, rotation, hp: 100, shipClass: 'normal' }],
  };
}

describe('Interpolation.sample', { concurrency: 1 }, () => {
  test('returns nothing before any snapshot arrives', () => {
    const interpolation = new Interpolation({ delayMs: DELAY, fadeMs: 0 });
    assert.deepEqual(interpolation.sample(0), []);
    assert.equal(interpolation.hasData, false);
  });

  test('holds a single frame instead of interpolating against nothing', () => {
    const interpolation = new Interpolation({ delayMs: DELAY, fadeMs: 0 });
    interpolation.push(frameAt(1, 0), { full: true, now: 0 });

    const sampled = interpolation.sample(0);
    assert.equal(sampled.length, 1);
    assert.equal(sampled[0]?.x, 0);
  });

  test('blends linearly between two snapshots', () => {
    /* `frameAt(tick, x)` derives `serverTime = tick * 50`, so ticks 1 and 3 are 100 ms
       apart in simulated time. The renderer must walk from x=0 to x=100 across that
       interval at an even rate once its clock is settled. */
    const interpolation = new Interpolation({ delayMs: 100, fadeMs: 0 });

    for (let tick = 1; tick <= 12; tick += 1) {
      interpolation.push(frameAt(tick, (tick - 1) * 50), { full: true, now: (tick - 1) * 50 });
    }

    // Sample at a steady 60 Hz through the middle of the buffer.
    const values: number[] = [];
    let previous = -Infinity;
    for (let ms = 250; ms <= 400; ms += 1000 / 60) {
      const value = interpolation.sample(ms)[0]?.x ?? Number.NaN;
      values.push(value);
      assert.ok(value >= previous - 1e-9, 'the rendered value must never go backwards');
      previous = value;
    }

    const steps = values
      .slice(1)
      .map((value, index) => value - (values[index] ?? 0))
      .filter((step) => step > 1e-6);

    assert.ok(steps.length >= 5, `expected several blending steps, got ${steps.length}`);

    /* Even spacing is the property that matters: a jittery interpolator shows up as
       steps of wildly different sizes, which the eye reads as stuttering. */
    const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
    for (const step of steps) {
      assert.ok(
        Math.abs(step - mean) < mean * 0.05,
        `blending should be linear; step ${step.toFixed(3)} vs mean ${mean.toFixed(3)}`,
      );
    }
  });

  test('interpolates rotation along the shortest path across the ±π seam', () => {
    const interpolation = new Interpolation({ delayMs: 100, fadeMs: 0 });

    // 3.0 rad -> -3.0 rad. Euclidean blending would sweep +6.0 rad the wrong way;
    // the short way is -0.283 rad through ±π.
    interpolation.push(frameAt(1, 0, 3), { full: true, now: 0 });
    interpolation.push(frameAt(2, 0, -3), { full: false, now: 100 });

    const midway = interpolation.sample(150)[0];
    assert.ok(midway !== undefined);

    // Halfway along the short arc lands just past ±π, i.e. |angle| > 3.0.
    assert.ok(
      Math.abs(midway.rotation) > 3,
      `rotation must wrap through ±π, got ${midway.rotation.toFixed(3)}`,
    );
    assert.ok(
      Math.abs(midway.rotation) <= Math.PI + 0.2,
      `rotation must stay near the seam, got ${midway.rotation.toFixed(3)}`,
    );
  });

  test('a delta updates only the entities it mentions', () => {
    const interpolation = new Interpolation({ delayMs: 100, fadeMs: 0 });

    // Two entities in the full frame...
    interpolation.push(
      {
        tick: 1,
        serverTime: 50,
        entities: [
          { id: 'a', x: 0, y: 0, rotation: 0, hp: 100, shipClass: 'normal' },
          { id: 'b', x: 500, y: 500, rotation: 0, hp: 90, shipClass: 'speed' },
        ],
      },
      { full: true, now: 0 },
    );

    // ...then a delta that only restates `a`.
    interpolation.push(
      {
        tick: 2,
        serverTime: 100,
        entities: [{ id: 'a', x: 10, y: 0, rotation: 0, hp: 100, shipClass: 'normal' }],
      },
      { full: false, now: 100 },
    );

    const sampled = interpolation.sample(200);
    const b = sampled.find((entity) => entity.id === 'b');

    assert.ok(b !== undefined, 'an entity omitted from a delta must survive');
    assert.equal(b.x, 500, 'its position must be carried forward unchanged');
  });

  test('a removed id is dropped and fades out', () => {
    const interpolation = new Interpolation({ delayMs: 100, fadeMs: 200 });

    interpolation.push(frameAt(1, 0), { full: true, now: 0 });
    interpolation.push(frameAt(2, 10), { full: false, now: 100 });

    // Remove it on the next frame.
    interpolation.push(
      { tick: 3, serverTime: 150, entities: [] },
      { full: false, removed: ['a'], now: 200 },
    );

    // While fading it is still drawn, at decreasing alpha.
    const during = interpolation.sample(250);
    assert.ok(
      during.some((entity) => entity.id === 'a'),
      'must linger while fading',
    );

    const alphaEarly = interpolation.fadeAlpha('a', 200);
    const alphaLate = interpolation.fadeAlpha('a', 350);
    assert.ok(alphaEarly !== null && alphaLate !== null);
    assert.ok(alphaLate < alphaEarly, 'alpha must decrease over the fade');

    // After the fade completes it is gone for good.
    const after = interpolation.sample(500);
    assert.ok(!after.some((entity) => entity.id === 'a'), 'must be gone after the fade');
  });

  test('a full frame resets the entity set', () => {
    const interpolation = new Interpolation({ delayMs: 100, fadeMs: 0 });

    interpolation.push(
      {
        tick: 1,
        serverTime: 50,
        entities: [
          { id: 'a', x: 0, y: 0, rotation: 0, hp: 100, shipClass: 'normal' },
          { id: 'b', x: 1, y: 1, rotation: 0, hp: 100, shipClass: 'normal' },
        ],
      },
      { full: true, now: 0 },
    );

    // A full frame that no longer mentions `b`: it is genuinely gone.
    interpolation.push(frameAt(2, 5), { full: true, now: 100 });

    const sampled = interpolation.sample(200);
    assert.ok(sampled.some((entity) => entity.id === 'a'));
    assert.ok(!sampled.some((entity) => entity.id === 'b'));
  });

  test('caps the buffer so a long session cannot grow without bound', () => {
    const interpolation = new Interpolation({ delayMs: 100, fadeMs: 0 });
    for (let tick = 0; tick < 100; tick += 1) {
      interpolation.push(frameAt(tick, tick), { full: tick === 0, now: tick * 10 });
    }
    assert.ok(
      interpolation.bufferedFrames <= 32,
      `buffer must stay bounded, got ${String(interpolation.bufferedFrames)}`,
    );
  });

  test('a steady 20 Hz feed produces monotonic, jitter-free motion', () => {
    const interpolation = new Interpolation({ delayMs: 100, fadeMs: 0 });

    // Simulate a ship moving 10 units per tick at 20 Hz, sampled at 60 Hz.
    const positions: number[] = [];
    let now = 0;
    for (let tick = 0; tick < 20; tick += 1) {
      interpolation.push(frameAt(tick, tick * 10), { full: tick === 0, now });
      now += 50;
    }

    // Sample three frames per tick, after the buffer has filled.
    for (let i = 0; i < 30; i += 1) {
      const sampled = interpolation.sample(now + i * (50 / 3));
      const x = sampled[0]?.x;
      if (x !== undefined) positions.push(x);
    }

    assert.ok(positions.length > 10);

    // Every step must be forward and small: no backwards jumps, no teleports.
    for (let i = 1; i < positions.length; i += 1) {
      const previous = positions[i - 1] ?? 0;
      const current = positions[i] ?? 0;
      const delta = current - previous;

      assert.ok(
        delta >= -0.001,
        `motion must not reverse (step ${String(i)}: ${delta.toFixed(3)})`,
      );
      assert.ok(
        delta < 12,
        `each 16 ms step must be far below a tick hop (step ${String(i)}: ${delta.toFixed(3)})`,
      );
    }
  });

  test('clear() empties the buffer and the fade list', () => {
    const interpolation = new Interpolation({ delayMs: 100, fadeMs: 200 });
    interpolation.push(frameAt(1, 0), { full: true, now: 0 });
    interpolation.push(frameAt(2, 10), { full: false, now: 100 });
    interpolation.push(
      { tick: 3, serverTime: 150, entities: [] },
      {
        full: false,
        removed: ['a'],
        now: 200,
      },
    );

    interpolation.clear();

    assert.equal(interpolation.hasData, false);
    assert.deepEqual(interpolation.sample(300), []);
    assert.equal(interpolation.fadeAlpha('a', 300), null);
  });
});

describe('Interpolation — resistance to network jitter', { concurrency: 1 }, () => {
  /**
   * The measurement that separates a smooth world from a jittery one.
   *
   * A real server produces tick `k` at simulated time `k * 50` and it arrives after a
   * base delay *plus jitter*. Rendering therefore has to answer: how uneven is the
   * motion when packets do not arrive evenly?
   *
   * The old implementation used arrival times as its time base and inherited every
   * hiccup — measured at 35.8 % and 62.5 % variation for 15 ms and 30 ms of jitter.
   * Time-basing on server ticks keeps it under 1 %.
   */
  function measure(jitterMs: number): { variation: number; backwards: number } {
    const interpolation = new Interpolation();
    const CLOCK_OFFSET = 5_000; // server and client clocks differ; must not matter
    const BASE_DELAY = 40;

    // Deterministic pseudo-random jitter, so the test cannot flake.
    let state = 987_654;
    const random = (): number => {
      state = (state * 1_103_515_245 + 12_345) & 0x7f_ff_ff_ff;
      return state / 0x7f_ff_ff_ff;
    };

    const arrivals: number[] = [];
    for (let tick = 0; tick < 4_000; tick += 1) {
      arrivals.push(tick * 50 + BASE_DELAY + (random() - 0.5) * 2 * jitterMs + CLOCK_OFFSET);
    }

    let next = 0;
    const drawn: number[] = [];

    // 60 s of rendering at 60 Hz.
    for (let frame = 0; frame < 3_600; frame += 1) {
      const clock = frame * (1000 / 60) + CLOCK_OFFSET;

      while (next < arrivals.length && (arrivals[next] ?? Infinity) <= clock) {
        interpolation.push(
          {
            tick: next,
            serverTime: next * 50,
            entities: [{ id: 'a', x: next * 12, y: 0, rotation: 0, hp: 1, shipClass: 'normal' }],
          },
          { full: true, removed: [], now: clock },
        );
        next += 1;
      }

      const pose = interpolation.sample(clock).find((entity) => entity.id === 'a');
      drawn.push(pose?.x ?? Number.NaN);
    }

    // Measure the settled second half: the first seconds include clock start-up.
    const tail = drawn.slice(drawn.length / 2);
    const steps = tail
      .slice(1)
      .map((value, index) => value - (tail[index] ?? 0))
      .filter(Number.isFinite);

    const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
    const standardDeviation = Math.sqrt(
      steps.reduce((a, b) => a + (b - mean) ** 2, 0) / steps.length,
    );

    return {
      variation: mean === 0 ? 1 : standardDeviation / mean,
      backwards: steps.filter((step) => step < -1e-9).length,
    };
  }

  test('motion stays smooth with no jitter', () => {
    const { variation, backwards } = measure(0);
    assert.equal(backwards, 0, 'motion must never reverse');
    assert.ok(variation < 0.05, `variation ${(variation * 100).toFixed(1)} % is too high`);
  });

  test('motion stays smooth with 15 ms of jitter', () => {
    const { variation, backwards } = measure(15);
    assert.equal(backwards, 0);
    /* The arrival-based implementation measured 35.8 % here. Anything near 1 % means
       the render clock is doing its job. */
    assert.ok(
      variation < 0.1,
      `variation ${(variation * 100).toFixed(1)} % — jitter is leaking into motion`,
    );
  });

  test('motion stays smooth with 30 ms of jitter', () => {
    const { variation, backwards } = measure(30);
    assert.equal(backwards, 0);
    assert.ok(
      variation < 0.15,
      `variation ${(variation * 100).toFixed(1)} % at 30 ms jitter (arrival-based was 62.5 %)`,
    );
  });

  test('an entity never jumps backwards, however the packets arrive', () => {
    const { backwards } = measure(40);
    assert.equal(backwards, 0, 'a negative step is visible as a stutter');
  });
});
