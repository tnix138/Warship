import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { RoomManager } from './RoomManager.js';

describe('RoomManager', () => {
  test('assigns players to rooms and creates new shards when full', () => {
    const mgr = new RoomManager(2);
    const r1 = mgr.assignPlayer(1);
    const r2 = mgr.assignPlayer(2);
    const r3 = mgr.assignPlayer(3);

    assert.equal(r1.id, 'shard-0');
    assert.equal(r2.id, 'shard-0');
    assert.equal(r3.id, 'shard-1');
    assert.deepEqual(mgr.getStats(), { roomCount: 2, totalPlayers: 3 });

    mgr.removePlayer(1);
    mgr.removePlayer(2);
    assert.deepEqual(mgr.getStats(), { roomCount: 1, totalPlayers: 1 });
  });
});
