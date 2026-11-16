import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  NPC_STATS,
  NpcState,
  NpcTier,
  TICK_DURATION_S,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from '@warship/shared';

import { canFire } from './Targeting.js';
import { Npc } from './Npc.js';

/**
 * NPC behaviour tests.
 *
 * The AI has exactly four states and no memory, so every assertion here is about a
 * *transition* rather than about tactics. That is deliberate: once an NPC starts
 * flanking or retreating, "did it behave correctly" stops being expressible as a
 * handful of distances, and the tests stop being trustworthy.
 *
 * Every test drives `step` with an explicit tick so time-dependent behaviour (reload
 * gating, mainly) is deterministic.
 */

/** A player-shaped target at an offset from the origin. */
function targetAt(dx: number, dy = 0): { id: string; x: number; y: number } {
  return { id: 'player-1', x: dx, y: dy };
}

describe('Npc — state machine', () => {
  test('idles in Patrol with no target in range', () => {
    const npc = new Npc({ id: 'n1', tier: NpcTier.Small, x: 0, y: 0 });
    npc.step([]);

    assert.equal(npc.state, NpcState.Patrol);
    assert.equal(npc.targetId, null);
  });

  test('detects a player inside the detection radius and starts to chase', () => {
    const npc = new Npc({ id: 'n2', tier: NpcTier.Small, x: 0, y: 0 });

    // The Coastal detects at 800 and engages at 430; 600 is inside the first, outside
    // the second, so the answer must be Chase and not Engage.
    npc.step([targetAt(600)]);

    assert.equal(npc.state, NpcState.Chase);
    assert.equal(npc.targetId, 'player-1');
  });

  test('ignores a player outside the detection radius', () => {
    const npc = new Npc({ id: 'n3', tier: NpcTier.Small, x: 0, y: 0 });
    npc.step([targetAt(NPC_STATS[NpcTier.Small].detectRadius + 50)]);

    assert.equal(npc.state, NpcState.Patrol);
    assert.equal(npc.targetId, null);
  });

  test('engages once inside weapon range', () => {
    const npc = new Npc({ id: 'n4', tier: NpcTier.Small, x: 0, y: 0 });
    npc.step([targetAt(NPC_STATS[NpcTier.Small].range * 0.5)]);

    assert.equal(npc.state, NpcState.Engage);
  });

  test('picks the nearest of several targets', () => {
    const npc = new Npc({ id: 'n5', tier: NpcTier.Small, x: 0, y: 0 });
    npc.step([
      { id: 'far', x: 700, y: 0 },
      { id: 'near', x: 300, y: 0 },
    ]);

    assert.equal(npc.targetId, 'near');
  });

  test('keeps its target when a closer one appears', () => {
    /* Committing matters: an NPC that re-picks every tick oscillates between two ships
       near the same distance and reaches neither. Once engaged, only the target dying or
       escaping should switch it. */
    const npc = new Npc({ id: 'n6', tier: NpcTier.Medium, x: 0, y: 0 });

    npc.step([targetAt(600)]);
    assert.equal(npc.targetId, 'player-1');

    npc.step([
      { id: 'player-1', x: 600, y: 0 },
      { id: 'player-2', x: 200, y: 0 },
    ]);
    assert.equal(npc.targetId, 'player-1');
  });

  test('returns to patrol when the target leaves the give-up radius', () => {
    const npc = new Npc({ id: 'n7', tier: NpcTier.Small, x: 0, y: 0 });
    npc.step([targetAt(500)]);
    assert.equal(npc.state, NpcState.Chase);

    npc.step([targetAt(2_000)]);
    assert.equal(npc.state, NpcState.Patrol);
    assert.equal(npc.targetId, null);
  });

  test('a dead NPC does nothing', () => {
    const npc = new Npc({ id: 'n8', tier: NpcTier.Small, x: 0, y: 0 });
    npc.kill(1);

    const intent = npc.step([targetAt(100)]);
    assert.equal(intent.throttle, 0);
    assert.equal(intent.wantsToFire, false);
    assert.equal(npc.state, NpcState.Dead);
  });
});

describe('Npc — firing', () => {
  test('fires once reloaded and pointing at the target', () => {
    const npc = new Npc({ id: 'f1', tier: NpcTier.Small, x: 0, y: 0, rotation: 0 });
    // Directly ahead, well inside range, so the hull is already aligned.
    const intent = npc.step([targetAt(200)]);

    assert.equal(intent.wantsToFire, true);
  });

  test('still asks to fire while the reload is ticking, because gating moved to the loop', () => {
    const npc = new Npc({ id: 'f2', tier: NpcTier.Small, x: 0, y: 0, rotation: 0 });
    const first = npc.step([targetAt(200)]);
    assert.equal(first.wantsToFire, true);
    npc.lastFiredTick = 1;

    /* Deliberately changed. The AI used to consult its own reload clock, which meant the
       weapon rule lived in two places and could drift between factions. Now the AI only
       says "I would fire" and `canFire` is the single gate the loop applies to players
       and NPCs alike — so a winding-down gun still reports the wish. */
    const second = npc.step([targetAt(200)]);
    assert.equal(second.wantsToFire, true);
    assert.equal(
      canFire({
        tick: 2,
        lastFiredTick: 1,
        reloadTime: NPC_STATS[NpcTier.Small].reloadTime,
        fireRate: NPC_STATS[NpcTier.Small].fireRate,
        tickDurationS: TICK_DURATION_S,
      }),
      false,
      'the loop must refuse the shot, not the AI',
    );
  });

  test('does not fire with the bow pointing away from the target', () => {
    const npc = new Npc({ id: 'f3', tier: NpcTier.Small, x: 0, y: 0, rotation: Math.PI });
    const intent = npc.step([targetAt(200)]);

    assert.equal(intent.wantsToFire, false);
  });

  test('fires again after the full reload time', () => {
    const npc = new Npc({ id: 'f4', tier: NpcTier.Small, x: 0, y: 0, rotation: 0 });
    npc.step([targetAt(200)]);
    npc.lastFiredTick = 1;

    /* The AI no longer knows about reload at all: it says "I would fire" and the loop
       applies the gate. What this pins is that a fresh intent is still returned after
       time has passed, i.e. that the decision is not latched. */
    const intent = npc.step([targetAt(200)]);
    assert.equal(intent.wantsToFire, true);
  });
});

describe('Npc — movement and world', () => {
  test('moves toward a distant target', () => {
    const npc = new Npc({ id: 'm1', tier: NpcTier.Medium, x: 0, y: 0 });
    const before = { x: npc.x, y: npc.y };

    for (let tick = 1; tick <= 40; tick += 1) npc.step([targetAt(700)]);

    const moved = Math.hypot(npc.x - before.x, npc.y - before.y);
    assert.ok(moved > 0, 'the NPC should have closed some distance');
  });

  test('never exceeds its own top speed', () => {
    const npc = new Npc({ id: 'm2', tier: NpcTier.Medium, x: 0, y: 0 });
    let previous = { x: npc.x, y: npc.y };
    const maxStep = NPC_STATS[NpcTier.Medium].maxSpeed * TICK_DURATION_S + 0.5;

    for (let tick = 1; tick <= 60; tick += 1) {
      npc.step([targetAt(700)]);
      const step = Math.hypot(npc.x - previous.x, npc.y - previous.y);
      assert.ok(step <= maxStep, `tick ${String(tick)} moved ${step.toFixed(1)} units`);
      previous = { x: npc.x, y: npc.y };
    }
  });

  test('chases a target across the world seam', () => {
    /* The world is a torus: a ship at x = 7 990 and one at x = 10 are 20 units apart, not
       7 980. An NPC that measured distance naively would never notice a player on the
       other side of the seam, and the seam would become a safe camping spot. */
    const npc = new Npc({ id: 'm3', tier: NpcTier.Medium, x: WORLD_WIDTH - 40, y: 0 });
    npc.step([{ id: 'player-1', x: 10, y: 0 }]);

    /* 50 units apart, which is inside weapon range — so Engage, not Chase. The point is
       that the NPC noticed at all: a naive straight-line distance would report 7 980 and
       it would still be patrolling. */
    assert.equal(npc.state, NpcState.Engage, 'the target across the seam is 50 units away');
  });

  test('stays inside the world bounds', () => {
    const npc = new Npc({ id: 'm4', tier: NpcTier.Small, x: WORLD_WIDTH - 5, y: WORLD_HEIGHT - 5 });

    for (let tick = 1; tick <= 100; tick += 1) npc.step([targetAt(400, 400)]);

    assert.ok(npc.x >= 0 && npc.x < WORLD_WIDTH, `x out of bounds: ${npc.x}`);
    assert.ok(npc.y >= 0 && npc.y < WORLD_HEIGHT, `y out of bounds: ${npc.y}`);
  });

  test('respawn restores full hull and leaves the dead state', () => {
    const npc = new Npc({ id: 'r1', tier: NpcTier.Large, x: 1_000, y: 1_000 });
    npc.applyDamage(9_999);
    npc.kill(5);
    assert.equal(npc.isAlive, false);

    npc.respawn({ at: { x: 200, y: 300 }, tick: 1_000 });

    assert.equal(npc.isAlive, true);
    assert.equal(npc.hp, NPC_STATS[NpcTier.Large].maxHp);
    assert.equal(npc.state, NpcState.Patrol);
    assert.equal(npc.diedAtTick, null);
  });

  test('respawn delay is inside the configured band and is stable per id', () => {
    const npc = new Npc({ id: 'r2', tier: NpcTier.Small, x: 0, y: 0 });
    const delay = npc.respawnDelayS;

    assert.ok(delay >= 30 && delay <= 60, `delay ${delay} outside 30-60`);
    assert.equal(new Npc({ id: 'r2', tier: NpcTier.Small, x: 9, y: 9 }).respawnDelayS, delay);
  });
});

describe('Npc — damage', () => {
  test('takes damage down to zero and not below', () => {
    const npc = new Npc({ id: 'd1', tier: NpcTier.Small, x: 0, y: 0 });
    const dealt = npc.applyDamage(9_999);

    assert.equal(dealt, NPC_STATS[NpcTier.Small].maxHp);
    assert.equal(npc.hp, 0);
  });

  test('ignores non-positive and non-finite damage', () => {
    const npc = new Npc({ id: 'd2', tier: NpcTier.Small, x: 0, y: 0 });
    const before = npc.hp;

    assert.equal(npc.applyDamage(0), 0);
    assert.equal(npc.applyDamage(-5), 0);
    assert.equal(npc.applyDamage(Number.NaN), 0);
    assert.equal(npc.hp, before);
  });
});
