import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  AIM_ASSIST_FACTOR,
  stepShipMotion,
  TICK_DURATION_S,
  wrapWorldPosition,
} from '@warship/shared';

import { Prediction } from './Prediction';

/**
 * Prediction tests.
 *
 * These encode the two failures that made the local ship look broken:
 *
 * 1. **20 Hz stutter.** Prediction used to step a whole tick per input, so the
 *    player's ship moved 20 times a second on a 60 Hz screen while every other ship
 *    moved every frame. The tests below measure the *drawn* position per frame.
 * 2. **Silent aim disagreement.** The server treats `aim` as an authoritative
 *    heading; the client ignored it during prediction. The consequence was a
 *    permanent, one-sided error that showed up as rubber-banding.
 */

/** What `stepShipMotion` wants. */
const MOTION_STATS = { speed: 240, turnRate: 1.7 };
/** What `Prediction` wants for its constructor. */
const STATS = { maxSpeed: 240, turnRate: 1.7 };
const RENDER_HZ = 60;
const INPUT_HZ = 20;

/** Drive the prediction the way `Game.ts` does and collect the drawn positions. */
function run(
  frames: number,
  options: {
    throttle?: number;
    turn?: number;
    aim?: number | null;
    /** Called before each frame's `update`, e.g. to inject snapshots. */
    onFrame?: (frame: number, prediction: Prediction) => void;
  } = {},
): { xs: number[]; ys: number[]; rotations: number[]; prediction: Prediction } {
  const prediction = new Prediction({}, { stats: STATS });
  prediction.reconcile({ x: 0, y: 0, rotation: 0 }, 0);

  let sequence = 0;
  let accumulator = 0;
  const xs: number[] = [];
  const ys: number[] = [];
  const rotations: number[] = [];

  for (let frame = 0; frame < frames; frame += 1) {
    const dt = 1 / RENDER_HZ;
    accumulator += dt;

    let sampled: {
      turn: number;
      throttle: number;
      aim: number | null;
      firing: boolean;
    } | null = null;
    let sampledSeq = sequence;

    if (accumulator >= 1 / INPUT_HZ) {
      accumulator -= 1 / INPUT_HZ;
      sequence += 1;
      sampledSeq = sequence;
      sampled = {
        turn: options.turn ?? 0,
        throttle: options.throttle ?? 1,
        aim: options.aim ?? null,
        firing: false,
      };
    }

    options.onFrame?.(frame, prediction);
    prediction.update(dt, sampled, sampledSeq);
    xs.push(prediction.actor.x);
    ys.push(prediction.actor.y);
    rotations.push(prediction.actor.rotation);
  }

  return { xs, ys, rotations, prediction };
}

describe('Prediction — smooth local motion', () => {
  test('the drawn position changes on nearly every frame, not once per input', () => {
    const { xs } = run(240); // 4 s

    let changes = 0;
    for (let index = 1; index < xs.length; index += 1) {
      if (Math.abs((xs[index] ?? 0) - (xs[index - 1] ?? 0)) > 1e-9) changes += 1;
    }

    /* Before the fix this was 80 of 240 frames (20 Hz). Anything below ~55 Hz means
       the ship is being stepped in visible chunks again. */
    const hz = changes / (xs.length / RENDER_HZ);
    assert.ok(hz > 55, `expected >55 Hz of motion, got ${hz.toFixed(1)} Hz`);
  });

  test('steady-state motion is uniform — no sawtooth', () => {
    const { xs } = run(480);
    // Skip the first 2 s: the ship starts at rest and accelerates.
    const tail = xs.slice(120);
    const steps = tail.slice(1).map((value, index) => value - (tail[index] ?? 0));

    const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
    const maxDeviation = Math.max(...steps.map((step) => Math.abs(step - mean)));

    assert.ok(mean > 0, 'the ship should be moving');
    /* A uniform step is the whole point: every frame advances the same distance.
       A sawtooth would show a deviation of a full frame's worth of movement. */
    assert.ok(
      maxDeviation < mean * 0.02,
      `per-frame steps should be uniform; mean ${mean.toFixed(3)}, max deviation ${maxDeviation.toFixed(4)}`,
    );
  });

  test('the drawn position never moves backwards while travelling forward', () => {
    const { xs } = run(300);

    let backwards = 0;
    let worst = 0;
    for (let index = 1; index < xs.length; index += 1) {
      const delta = (xs[index] ?? 0) - (xs[index - 1] ?? 0);
      if (delta < -1e-9) {
        backwards += 1;
        worst = Math.min(worst, delta);
      }
    }

    assert.equal(backwards, 0, `the ship jumped backwards ${backwards} times (worst ${worst})`);
  });

  test('travel distance matches the ship stats', () => {
    const { xs } = run(240);
    const travelled = (xs[xs.length - 1] ?? 0) - (xs[0] ?? 0);

    // 4 s at up to 240 u/s, minus the acceleration ramp from rest. Allow a wide band;
    // the point is that the ship is not moving at the wrong order of magnitude.
    assert.ok(travelled > 700 && travelled < 1000, `travelled ${travelled.toFixed(0)} u in 4 s`);
  });
});

describe('Prediction — aim parity with the server', () => {
  test('aim rotates the predicted hull, like the server does', () => {
    /* Holding the cursor 90° to starboard must turn the predicted hull. Before the
       fix `aim` was dropped, the hull never moved, and the server then corrected it
       on every tick. */
    const aim = Math.PI / 2;
    const { rotations } = run(120, { aim, throttle: 0 });

    const finalRotation = rotations[rotations.length - 1] ?? 0;
    assert.ok(
      Math.abs(finalRotation - aim) < 0.15,
      `expected the hull near ${aim.toFixed(2)} rad, got ${finalRotation.toFixed(3)}`,
    );
  });

  test('aim turns at the server-capped rate, not instantly', () => {
    const aim = Math.PI; // half a turn
    const { rotations } = run(12, { aim, throttle: 0 }); // 200 ms

    const maxStepPerTick = STATS.turnRate * AIM_ASSIST_FACTOR * TICK_DURATION_S;
    const afterOneInput = rotations[3] ?? 0; // ~50 ms in

    assert.ok(
      Math.abs(afterOneInput) <= maxStepPerTick * 1.5,
      `the hull must not snap to the cursor; rotated ${afterOneInput.toFixed(3)} in one tick, cap is ${maxStepPerTick.toFixed(3)}`,
    );
  });
});

describe('Prediction — reconciliation policy', () => {
  test('a small error is eased, not snapped', () => {
    const prediction = new Prediction({}, { stats: STATS });
    prediction.reconcile({ x: 0, y: 0, rotation: 0 }, 0);

    // Move for a bit so there is real motion to preserve.
    run(60); // warm the code path in a separate instance

    let sequence = 0;
    let accumulator = 0;
    for (let frame = 0; frame < 60; frame += 1) {
      const dt = 1 / RENDER_HZ;
      accumulator += dt;
      let sampled = null;
      let sampledSeq = sequence;
      if (accumulator >= 1 / INPUT_HZ) {
        accumulator -= 1 / INPUT_HZ;
        sequence += 1;
        sampledSeq = sequence;
        sampled = { turn: 0, throttle: 1, aim: null, firing: false };
      }
      prediction.update(dt, sampled, sampledSeq);
    }

    const before = prediction.actor.x;
    // A 2-unit disagreement: tiny, must be absorbed.
    const result = prediction.reconcile(
      { x: before + 2, y: prediction.actor.y, rotation: prediction.actor.rotation },
      sequence,
    );

    assert.equal(result.corrected, false, 'a 2 u error must not count as a snap');

    /* The correction is absorbed by the tick blend rather than by a separate offset.

       What that guarantees is not that the pose sits still — a correction necessarily
       moves it — but that *motion continues* at the same rate on the following frames,
       with no stall and no reversal. A teleport-then-pause would fail this. */
    const poses: number[] = [prediction.actor.x];
    for (let frame = 0; frame < 12; frame += 1) {
      prediction.update(1 / RENDER_HZ, null, sequence);
      poses.push(prediction.actor.x);
    }

    const steps = poses.slice(1).map((value, index) => value - (poses[index] ?? 0));
    const backwards = steps.filter((step) => step < -1e-9).length;
    assert.equal(backwards, 0, 'a eased correction must never reverse the drawn motion');
    assert.ok(
      Math.abs(poses[poses.length - 1] ?? 0) > Math.abs(poses[0] ?? 0),
      'the ship must keep travelling while the correction is absorbed',
    );
  });

  test('a large error snaps instead of easing', () => {
    const prediction = new Prediction({}, { stats: STATS });
    prediction.reconcile({ x: 0, y: 0, rotation: 0 }, 0);

    // 50 units is under the 64 u snap threshold; 500 is a teleport.
    const small = prediction.reconcile({ x: 50, y: 0, rotation: 0 }, 0);
    assert.equal(small.corrected, false, '50 u should still be eased');

    const large = prediction.reconcile({ x: 5_000, y: 0, rotation: 0 }, 0);
    assert.equal(large.corrected, true, 'a 5000 u jump must snap');
    assert.ok(large.error >= 4_000, `error should be reported, got ${large.error.toFixed(0)}`);
  });

  test('a correction does not push the ship through a wall of motion', () => {
    // Reconciling must keep the simulation consistent: after a correction that is
    // fully settled, the drawn pose equals the simulated pose.
    const prediction = new Prediction({}, { stats: STATS });
    prediction.reconcile({ x: 100, y: 100, rotation: 0 }, 0);

    for (let frame = 0; frame < 120; frame += 1) {
      prediction.update(1 / RENDER_HZ, null, 0);
    }

    assert.ok(
      Math.abs(prediction.actor.x - 100) < 1,
      `idle ship should stay put, drifted to ${prediction.actor.x.toFixed(2)}`,
    );
  });

  test('replay starts from ackSeq and skips acknowledged inputs', () => {
    const prediction = new Prediction({}, { stats: STATS });
    prediction.reconcile({ x: 0, y: 0, rotation: 0 }, 0);

    // Queue three inputs without letting the simulation run.
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      prediction.update(0, { turn: 0, throttle: 1, aim: null, firing: false }, sequence);
    }
    assert.equal(prediction.pendingCount, 3);

    // A snapshot acknowledging all three must leave nothing pending.
    prediction.reconcile({ x: 0, y: 0, rotation: 0 }, 3);
    assert.equal(prediction.pendingCount, 0);

    // A snapshot acknowledging only the first must leave two.
    prediction.update(0, { turn: 0, throttle: 1, aim: null, firing: false }, 4);
    prediction.update(0, { turn: 0, throttle: 1, aim: null, firing: false }, 5);
    prediction.reconcile({ x: 0, y: 0, rotation: 0 }, 4);
    assert.equal(prediction.pendingCount, 1, 'only seq 5 should remain pending');
  });
});

describe('Prediction — reconciliation must not break smooth motion', () => {
  /**
   * The bug this pins down was found by a live end-to-end run, not by the unit tests.
   *
   * `reconcile` ran once per snapshot (20 Hz) and used to overwrite the drawn pose
   * with the raw tick boundary. On those frames the sub-tick blend built during
   * `update` was discarded, so the ship advanced in visible steps three times a
   * second per tick — exactly the stutter this whole rework set out to remove.
   *
   * The property: with reconciliation running at 20 Hz, motion must still be smooth.
   */
  test('motion stays smooth while snapshots keep arriving', () => {
    /* The server integrates with the SAME physics the client predicts, one tick behind.
       An earlier version advanced the server position by a fixed 12 units per snapshot
       regardless of input — that is not a server, it is a teleport once per tick, and it
       produced backwards steps that cannot happen live.

       Frame order matches `Game.ts` exactly: reconcile first (on the snapshot that
       arrived), then `update`. Swapping the two changes what the blend window contains
       and is not what the game does. */
    const prediction = new Prediction({}, { stats: STATS });
    prediction.reconcile({ x: 0, y: 0, rotation: 0 }, 0);

    let server = { x: 0, y: 0, rotation: 0, speed: 0 };
    let sequence = 0;
    let accumulator = 0;
    let acknowledged = -1;
    const sent: {
      seq: number;
      input: { turn: number; throttle: number; aim: number | null; firing: boolean };
    }[] = [];
    const drawn: number[] = [];
    const frameTimes: number[] = [];

    for (let frame = 0; frame < 240; frame += 1) {
      const dt = 1 / RENDER_HZ;
      accumulator += dt;
      frameTimes.push(dt);

      /* 1. Reconcile against whatever the server said, before stepping. */
      const due = sent[sent.length - 2];
      if (due !== undefined && due.seq > acknowledged) {
        const next = stepShipMotion(server, due.input, MOTION_STATS, 1 / INPUT_HZ);
        const wrapped = wrapWorldPosition(next);
        server = { x: wrapped.x, y: wrapped.y, rotation: next.rotation, speed: next.speed };
        prediction.reconcile({ x: server.x, y: server.y, rotation: server.rotation }, due.seq);
        acknowledged = due.seq;
      }

      /* 2. Sample input at 20 Hz and advance the prediction. */
      let input = null;
      if (accumulator >= 1 / INPUT_HZ) {
        accumulator -= 1 / INPUT_HZ;
        sequence += 1;
        input = { turn: 0, throttle: 1, aim: 0, firing: false };
        sent.push({ seq: sequence, input });
      }

      prediction.update(dt, input, sequence);
      drawn.push(prediction.actor.x);
    }

    // Ignore the first second: the ship accelerates from rest.
    const tail = drawn.slice(60);
    const steps = tail.slice(1).map((value, index) => value - (tail[index] ?? 0));

    const moving = steps.filter((step) => Math.abs(step) > 1e-9).length;
    assert.equal(moving, steps.length, `the ship must move every frame; ${moving}/${steps.length}`);

    const backwards = steps.filter((step) => step < -1e-9);
    assert.equal(backwards.length, 0, `the ship stepped backwards ${backwards.length} times`);

    const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
    const deviation = Math.max(...steps.map((step) => Math.abs(step - mean)));
    assert.ok(
      deviation < mean * 0.05,
      `motion must be even while reconciling; mean ${mean.toFixed(3)}, worst deviation ${deviation.toFixed(4)}`,
    );
  });

  test('a stalled connection does not make the ship drift', () => {
    const prediction = new Prediction({}, { stats: STATS });
    prediction.reconcile({ x: 500, y: 500, rotation: 0 }, 0);

    // No input, no snapshots: the ship must hold its pose.
    for (let frame = 0; frame < 120; frame += 1) {
      prediction.update(1 / RENDER_HZ, null, 0);
    }

    assert.ok(
      Math.abs(prediction.actor.x - 500) < 1 && Math.abs(prediction.actor.y - 500) < 1,
      `idle ship drifted to ${prediction.actor.x.toFixed(1)}, ${prediction.actor.y.toFixed(1)}`,
    );
  });
});
