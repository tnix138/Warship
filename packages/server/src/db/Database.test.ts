import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { WarshipDatabase } from './Database.js';

describe('WarshipDatabase', () => {
  test('records and retrieves top scores ordered by xp', () => {
    const db = new WarshipDatabase(':memory:');
    db.recordScore({ nick: 'alpha', kills: 2, xp: 150, level: 2 });
    db.recordScore({ nick: 'bravo', kills: 5, xp: 900, level: 4 });
    db.recordScore({ nick: 'charlie', kills: 1, xp: 50, level: 1 });

    const top = db.getTopScores(2);
    assert.equal(top.length, 2);
    assert.equal(top[0]?.nick, 'bravo');
    assert.equal(top[1]?.nick, 'alpha');

    db.close();
  });
});
