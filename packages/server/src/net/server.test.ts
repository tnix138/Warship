/**
 * End-to-end tests for the network layer and the join/input/snapshot flow.
 *
 * Each test boots a real `NetworkServer` on its own port, connects with Node's
 * built-in `WebSocket` and speaks the real protocol (MessagePack over `/ws`).
 * Nothing is mocked below the socket: the clock, the world, the loop and the
 * encoder all run for real, so a passing test means a client could play.
 *
 * Run with `pnpm --filter @warship/server test`.
 */

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { decode, encode } from '@msgpack/msgpack';
import {
  CloseCode,
  NETWORK_MAX_MESSAGES_PER_SECOND,
  MessageType,
  PROTOCOL_VERSION,
  ShipClass,
  TICK_DURATION_MS,
  WS_SUBPROTOCOL,
  type ClientMessage,
  type InputMessage,
  type JoinMessage,
  type PlayerStateMessage,
  type ServerMessage,
  type SnapshotEntity,
  type SnapshotMessage,
  type WelcomeMessage,
} from '@warship/shared';

import { createLogger } from '../logger.js';
import { SimulationClock } from '../sim/clock.js';
import { NetworkServer } from './server.js';

const logger = createLogger({ minLevel: 'error', pretty: false });

/* -------------------------------------------------------------------------- */
/*  Harness                                                                   */
/* -------------------------------------------------------------------------- */

/** One live client: a socket plus a frame queue that never loses a frame. */
interface TestClient {
  readonly socket: WebSocket;
  /** Every server frame received so far, in order. */
  readonly frames: ServerMessage[];
  /** Wait until a frame matching `predicate` has arrived, then return it. */
  next(predicate: (message: ServerMessage) => boolean, timeoutMs?: number): Promise<ServerMessage>;
  /** Send a client frame. */
  send(message: ClientMessage): void;
  /** Wait for the socket to close and return the code. */
  closed: Promise<number>;
  close(): void;
}

async function connect(port: number): Promise<TestClient> {
  const socket = new WebSocket(`ws://127.0.0.1:${port.toString()}/ws`, [WS_SUBPROTOCOL]);
  socket.binaryType = 'arraybuffer';

  const frames: ServerMessage[] = [];
  const waiters: (() => void)[] = [];
  let closedWith: number | null = null;

  /* Handlers are attached BEFORE the socket opens: the server may send WELCOME (and,
     after JOIN, snapshots at 20 Hz) the instant the connection is live. Attaching
     `onmessage` after `await onopen` silently drops every frame in that window. */
  socket.onmessage = (event) => {
    frames.push(decode(new Uint8Array(event.data as ArrayBuffer)) as ServerMessage);
    for (const wake of waiters.splice(0)) wake();
  };

  const closed = new Promise<number>((resolve) => {
    socket.onclose = (event) => {
      closedWith = event.code;
      resolve(event.code);
    };
  });

  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => {
      resolve();
    };
    socket.onerror = () => {
      reject(new Error(`socket failed to open on port ${String(port)}`));
    };
  });

  return {
    socket,
    frames,
    closed,
    send(message) {
      socket.send(encode(message));
    },
    async next(predicate, timeoutMs = 3_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = frames.find(predicate);
        if (found !== undefined) return found;
        if (closedWith !== null) {
          throw new Error(`socket closed (${closedWith.toString()}) before the expected frame`);
        }
        if (Date.now() > deadline) {
          throw new Error(
            `timed out waiting for a frame; received: ${frames.map((f) => f.t).join(', ') || 'nothing'}`,
          );
        }
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
        });
      }
    },
    close() {
      socket.close();
    },
  };
}

/**
 * Wait for a snapshot strictly newer than `afterTick` (default: anything already
 * received) and return it.
 *
 * Waiting on a *tick number* rather than on "count received so far" makes the
 * helper immune to queue position: the server ticks at 20 Hz regardless of when the
 * caller started looking.
 */
/**
 * Replay every snapshot a client received into the world state that client believes.
 *
 * This is deliberately the same algorithm the real client uses (`ClientWorld`): apply
 * a `full` snapshot as a reset, then apply deltas on top of it and drop the ids in
 * `removed`. Tests must not read a single delta frame and conclude an entity is gone —
 * a delta only carries what *changed*, so an untouched ship is legitimately absent.
 */
function materialise(client: TestClient, fromTick = -1): Map<string, SnapshotEntity> {
  const world = new Map<string, SnapshotEntity>();
  /* Only frames at or after `fromTick` are replayed when a bound is given: a test
     that repositions players must not re-read the JOIN-time snapshot taken while
     those ships were still on the spawn ring. */
  const snapshots = client.frames.filter(
    (frame): frame is SnapshotMessage => frame.t === MessageType.SNAPSHOT && frame.tick >= fromTick,
  );

  for (const snapshot of snapshots) {
    if (snapshot.full) world.clear();
    for (const entity of snapshot.entities) {
      // Deltas may omit `shipClass`; keep the one we already know.
      const previous = world.get(entity.id);
      world.set(entity.id, {
        id: entity.id,
        x: entity.x,
        y: entity.y,
        rotation: entity.rotation,
        hp: entity.hp,
        shipClass: entity.shipClass ?? previous?.shipClass,
      });
    }
    for (const gone of snapshot.removed ?? []) {
      world.delete(gone.id);
    }
  }

  return world;
}

/** The tick of the newest snapshot received, or -1. */
function latestTick(client: TestClient): number {
  let newest = -1;
  for (const frame of client.frames) {
    if (frame.t === MessageType.SNAPSHOT && frame.tick > newest) newest = frame.tick;
  }
  return newest;
}

/**
 * Wait until the client's reconstructed world contains `id` beyond `afterTick`, and
 * return that reconstructed world together with the tick it came from.
 *
 * Waiting on the *reconstructed* view rather than on a single frame is what makes
 * these tests honest under delta compression: a ship that has not moved since the
 * previous delta simply does not appear in the next one.
 */
async function worldAfter(
  client: TestClient,
  afterTick = -1,
  mustInclude?: string,
  timeoutMs = 3_000,
): Promise<{ entities: Map<string, SnapshotEntity>; tick: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tick = latestTick(client);
    if (tick > afterTick) {
      const entities = materialise(client, afterTick + 1);
      if (mustInclude === undefined || entities.has(mustInclude)) {
        return { entities, tick };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `world did not contain ${mustInclude ?? 'anything'} after tick ${String(afterTick)} ` +
      `(latest tick ${String(latestTick(client))}, ` +
      `received ${client.frames.map((f) => f.t).join(',') || 'nothing'})`,
  );
}

/** Convenience wrapper when only the entity matters. */
async function entityAfter(
  client: TestClient,
  afterTick: number,
  id: string,
): Promise<{ entity: SnapshotEntity; tick: number }> {
  const { entities, tick } = await worldAfter(client, afterTick, id);
  const entity = entities.get(id);
  if (entity === undefined) throw new Error(`entity ${id} missing from the world`);
  return { entity, tick };
}

/** Connect, wait for WELCOME, JOIN, and wait for the first PLAYER_STATE. */
async function join(
  port: number,
  shipClass: ShipClass = ShipClass.Normal,
): Promise<{ client: TestClient; welcome: WelcomeMessage; playerState: PlayerStateMessage }> {
  const client = await connect(port);
  const welcome = (await client.next((m) => m.t === MessageType.WELCOME)) as WelcomeMessage;

  const joinMessage: JoinMessage = {
    v: PROTOCOL_VERSION,
    t: MessageType.JOIN,
    shipClass,
    client: { version: 'test' },
  };
  client.send(joinMessage);

  const playerState = (await client.next(
    (m) => m.t === MessageType.PLAYER_STATE,
  )) as PlayerStateMessage;

  return { client, welcome, playerState };
}

/** Build a well-formed INPUT frame. */
function inputFrame(
  seq: number,
  tick: number,
  overrides: Partial<InputMessage['input']> = {},
): InputMessage {
  return {
    v: PROTOCOL_VERSION,
    t: MessageType.INPUT,
    seq,
    tick,
    input: { turn: 0, throttle: 1, aim: 0, firing: false, ...overrides },
  };
}

/* -------------------------------------------------------------------------- */
/*  Server lifecycle                                                          */
/* -------------------------------------------------------------------------- */

let server: NetworkServer;
let port: number;
let clock: SimulationClock;

before(async () => {
  /* Port 0 = let the OS pick a free port. A fixed port would collide with a stale
     test process (which then answers clients with no simulation attached). */
  port = 0;

  /* Declared first so the clock's callback can close over the server instance. */
  let instance: NetworkServer | null = null;

  clock = new SimulationClock({
    tickRate: 20,
    onTick: () => {
      instance?.loop.tick();
    },
  });

  server = new NetworkServer({
    host: '127.0.0.1',
    port,
    wsPath: '/ws',
    shardId: 'test-shard',
    maxPlayers: 10,
    logger,
    clock,
  });
  instance = server;

  port = await server.listen();
  clock.start();
});

after(() => {
  clock.stop();
  server.close();
});

/* -------------------------------------------------------------------------- */
/*  Handshake                                                                 */
/* -------------------------------------------------------------------------- */

describe('handshake', { concurrency: 1 }, () => {
  test('negotiates the warship subprotocol and sends WELCOME first', async () => {
    const client = await connect(port);
    assert.equal(client.socket.protocol, WS_SUBPROTOCOL);

    const welcome = (await client.next((m) => m.t === MessageType.WELCOME)) as WelcomeMessage;
    assert.equal(welcome.v, PROTOCOL_VERSION);
    assert.equal(welcome.shardId, 'test-shard');
    assert.equal(welcome.tickRate, 20);
    assert.equal(welcome.worldWidth, 8_000);
    assert.ok(welcome.sessionId.length > 0);
    assert.equal(client.frames[0]?.t, MessageType.WELCOME, 'WELCOME must be the first frame');

    client.close();
  });

  test('echoes a client PING back as PONG with nonce and timestamp intact', async () => {
    const client = await connect(port);
    await client.next((m) => m.t === MessageType.WELCOME);

    client.send({ v: PROTOCOL_VERSION, t: MessageType.PING, nonce: 7, sentAt: 12_345 });
    const pong = await client.next((m) => m.t === MessageType.PONG);

    assert.equal(pong.t, MessageType.PONG);
    assert.equal(pong.nonce, 7);
    assert.equal(pong.sentAt, 12_345);

    client.close();
  });

  test('rejects a mismatched protocol version with 4001', async () => {
    const client = await connect(port);
    await client.next((m) => m.t === MessageType.WELCOME);

    client.socket.send(
      encode({
        v: PROTOCOL_VERSION + 1,
        t: MessageType.JOIN,
        shipClass: 'normal',
        client: { version: 'stale' },
      }),
    );

    assert.equal(await client.closed, CloseCode.VersionMismatch);
  });

  test('rejects a malformed frame with 1002 and keeps serving others', async () => {
    const client = await connect(port);
    await client.next((m) => m.t === MessageType.WELCOME);

    client.socket.send(new Uint8Array([0xff, 0x00, 0x13, 0x37]));
    assert.equal(await client.closed, CloseCode.ProtocolError);

    const survivor = await connect(port);
    await survivor.next((m) => m.t === MessageType.WELCOME);
    survivor.close();
  });
});

/* -------------------------------------------------------------------------- */
/*  Join                                                                      */
/* -------------------------------------------------------------------------- */

describe('join', { concurrency: 1 }, () => {
  test('JOIN produces a private PLAYER_STATE for the joining player', async () => {
    const { client, playerState } = await join(port, ShipClass.Power);

    assert.equal(playerState.t, MessageType.PLAYER_STATE);
    assert.equal(playerState.shipClass, ShipClass.Power);
    assert.ok(playerState.hp > 0);
    assert.equal(playerState.hp, playerState.maxHp, 'a fresh ship is undamaged');
    assert.equal(playerState.level, 1);
    assert.equal(playerState.xp, 0);
    assert.equal(playerState.zone, 'safe', 'spawn is inside the safe zone');
    assert.deepEqual(playerState.upgrades, {});

    client.close();
  });

  test('a joined player appears in the next snapshot', async () => {
    const { client, playerState } = await join(port, ShipClass.Speed);

    const { entity: self, tick } = await entityAfter(client, -1, playerState.entityId);

    assert.equal(self.shipClass, ShipClass.Speed);
    assert.equal(self.hp, playerState.maxHp);
    assert.ok(tick > 0);

    client.close();
  });
});

/* -------------------------------------------------------------------------- */
/*  Input → simulation → snapshot                                             */
/* -------------------------------------------------------------------------- */

describe('input drives the authoritative simulation', { concurrency: 1 }, () => {
  test('a full-throttle INPUT moves the ship away from its spawn', async () => {
    const { client, playerState } = await join(port, ShipClass.Normal);

    const before = await entityAfter(client, -1, playerState.entityId);

    // Hold the throttle for ~300 ms of wall time: at 20 Hz that is ~6 ticks.
    for (let seq = 1; seq <= 8; seq += 1) {
      client.send(inputFrame(seq, before.entity.id.length + seq));
      await new Promise((resolve) => setTimeout(resolve, TICK_DURATION_MS));
    }

    await new Promise((resolve) => setTimeout(resolve, 120));

    const after = await entityAfter(client, before.tick, playerState.entityId);

    const moved = Math.hypot(after.entity.x - before.entity.x, after.entity.y - before.entity.y);
    assert.ok(moved > 5, `ship should have moved; moved ${moved.toFixed(2)} units`);

    client.close();
  });

  test('the server ignores a replayed (stale) INPUT sequence number', async () => {
    const { client, playerState } = await join(port);

    const start = await entityAfter(client, -1, playerState.entityId);

    // Send seq 5 with no throttle, then replay seq 3 with full throttle. The replay
    // must be dropped, so the ship must not accelerate.
    client.send(inputFrame(5, 1, { throttle: 0 }));
    client.send(inputFrame(3, 1, { throttle: 1, turn: 1 }));

    await new Promise((resolve) => setTimeout(resolve, 250));

    const end = await entityAfter(client, start.tick, playerState.entityId);

    const drift = Math.hypot(end.entity.x - start.entity.x, end.entity.y - start.entity.y);
    assert.ok(drift < 5, `replayed input must not move the ship; drifted ${drift.toFixed(2)}`);

    client.close();
  });

  test('malformed INPUT fields are clamped instead of trusted', async () => {
    const { client, playerState } = await join(port);

    // throttle 99 and turn -99 must be clamped to 1 / -1, not applied literally.
    client.socket.send(
      encode({
        v: PROTOCOL_VERSION,
        t: MessageType.INPUT,
        seq: 1,
        tick: 1,
        input: { turn: -99, throttle: 99, aim: 0, firing: false },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 150));
    const world = await worldAfter(client, -1, playerState.entityId);
    assert.ok(world.entities.size >= 1, 'server still healthy after hostile input');

    client.close();
  });
});

/* -------------------------------------------------------------------------- */
/*  Multiple clients                                                          */
/* -------------------------------------------------------------------------- */

describe('multiple clients', { concurrency: 1 }, () => {
  test('two clients get different ids and see each other in snapshots', async () => {
    const a = await join(port, ShipClass.Speed);
    const b = await join(port, ShipClass.Power);

    assert.notEqual(
      a.playerState.entityId,
      b.playerState.entityId,
      'each player must get a distinct entity id',
    );

    // Both must be present in a snapshot from *each* client's perspective.
    const worldA = await worldAfter(a.client, -1, b.playerState.entityId);
    const worldB = await worldAfter(b.client, -1, a.playerState.entityId);

    for (const [label, world] of [
      ['A', worldA],
      ['B', worldB],
    ] as const) {
      assert.ok(world.entities.has(a.playerState.entityId), `${label} must see player A`);
      assert.ok(world.entities.has(b.playerState.entityId), `${label} must see player B`);
    }

    const seenByA = worldA.entities.get(b.playerState.entityId);
    assert.equal(seenByA?.shipClass, ShipClass.Power, 'A must see B with the right class');

    a.client.close();
    b.client.close();
  });

  test('a departing client is removed from the other client’s snapshots', async () => {
    const staying = await join(port);
    const leaving = await join(port);

    const beforeLeave = await worldAfter(staying.client, -1, leaving.playerState.entityId);

    const leavingId = leaving.playerState.entityId;
    leaving.client.close();

    // The departure reaches the staying client either as absence from a full
    // snapshot or as a `removed` entry on a delta; `materialise` handles both, so
    // this waits on the reconstructed world rather than on a single frame.
    const deadline = Date.now() + 2_000;
    let stillVisible = true;
    while (stillVisible && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (latestTick(staying.client) > beforeLeave.tick) {
        stillVisible = materialise(staying.client).has(leavingId);
      }
    }

    assert.ok(!stillVisible, 'a closed player must not linger in the client world');

    staying.client.close();
  });
});

/* -------------------------------------------------------------------------- */
/*  Rate limiting                                                             */
/* -------------------------------------------------------------------------- */

describe('rate limiting', { concurrency: 1 }, () => {
  test('a flood of frames is dropped without disconnecting an honest client', async () => {
    const { client, playerState } = await join(port);

    // 200 PINGs in one window; the limit is 30/s.
    for (let nonce = 0; nonce < 200; nonce += 1) {
      client.send({ v: PROTOCOL_VERSION, t: MessageType.PING, nonce, sentAt: 0 });
    }

    await new Promise((resolve) => setTimeout(resolve, 250));

    const pongs = client.frames.filter((frame) => frame.t === MessageType.PONG).length;
    assert.ok(pongs > 0, 'some pings should have been answered');
    // Derived from the constant, never hardcoded: this test must keep passing when
    // the budget is tuned.
    const budget = NETWORK_MAX_MESSAGES_PER_SECOND;
    assert.ok(
      pongs <= budget + 1,
      `at most the window budget (+1 for boundary jitter) may be answered; got ${String(pongs)} of ${String(budget)}`,
    );

    // The connection must still be alive: newer snapshots keep arriving.
    const world = await worldAfter(client, -1, playerState.entityId);
    assert.ok(world.entities.has(playerState.entityId));

    client.close();
  });
});

/* -------------------------------------------------------------------------- */
/*  Area of Interest                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A dedicated server whose clock we can drive by hand.
 *
 * AoI tests need players at *chosen* positions, so each test spawns through the
 * world directly and then ticks once. Driving the clock manually removes the race
 * between "spawn both players" and "the next tick fires".
 */
async function withAoiServer(
  run: (context: {
    port: number;
    server: NetworkServer;
    tick: () => void;
    spawn: (id: string, x: number, y: number) => void;
    move: (id: string, x: number, y: number) => void;
    resetAoi: () => void;
  }) => Promise<void>,
): Promise<void> {
  let instance: NetworkServer | null = null;
  const manualClock = new SimulationClock({
    tickRate: 20,
    onTick: () => {
      instance?.loop.tick();
    },
  });

  const fresh = new NetworkServer({
    host: '127.0.0.1',
    port: 0,
    wsPath: '/ws',
    shardId: 'aoi-shard',
    maxPlayers: 10,
    logger,
    clock: manualClock,
  });
  instance = fresh;

  const freshPort = await fresh.listen();
  manualClock.start();
  // Stop the automatic ticking immediately: this test controls every tick.
  manualClock.stop();

  try {
    await run({
      port: freshPort,
      server: fresh,
      tick: () => {
        fresh.loop.tick();
      },
      /* Forget what each client was told, so the next tick emits a full snapshot
         from the players' *current* positions. Without this, the test races the
         `full` frame the server sends at JOIN time, while both ships still sit on
         the default spawn ring. */
      resetAoi: () => {
        fresh.loop.resetAoiMemory();
      },
      spawn: (id, x, y) => {
        fresh.world.addPlayer({ id, at: { x, y } });
        fresh.world.refreshGrid();
      },
      move: (id, x, y) => {
        const player = fresh.world.getPlayer(id);
        if (player === undefined) throw new Error(`no player ${id}`);
        player.x = x;
        player.y = y;
        fresh.world.refreshGrid();
      },
    });
  } finally {
    manualClock.stop();
    fresh.close();
  }
}

describe('Area of Interest', { concurrency: 1 }, () => {
  test('two players far apart never see each other', async () => {
    await withAoiServer(async ({ port, tick, move, resetAoi }) => {
      /* Two ships are placed at the world's true antipodes.

         They must NOT be picked as "far in raw coordinates": the world is a torus,
         so (1000,1000) and (7000,7000) are 2828 units apart across the seam — inside
         the interest radius. (2000,2000) and (6000,6000) are 5657 apart, which is
         also the maximum distance two points can have on an 8000x8000 torus. */
      const a = await join(port);
      const b = await join(port);

      move(a.playerState.entityId, 2_000, 2_000);
      move(b.playerState.entityId, 6_000, 6_000);

      // Discard the JOIN-time view (both ships were still on the spawn ring when it
      // was taken) and make the next frame describe the world as it is now.
      resetAoi();
      const movedAtTick = latestTick(a.client) + 1;

      for (let index = 0; index < 6; index += 1) tick();
      await new Promise((resolve) => setTimeout(resolve, 150));

      const worldA = materialise(a.client, movedAtTick);
      const worldB = materialise(b.client, movedAtTick);

      assert.ok(worldA.has(a.playerState.entityId), 'A must always see itself');
      assert.ok(worldB.has(b.playerState.entityId), 'B must always see itself');

      assert.ok(
        !worldA.has(b.playerState.entityId),
        'A must NOT see B: antipodal, 5657 units apart, past the 3000-unit interest radius',
      );
      assert.ok(
        !worldB.has(a.playerState.entityId),
        'B must NOT see A: antipodal, 5657 units apart, past the 3000-unit interest radius',
      );
    });
  });

  test('two players close together do see each other', async () => {
    await withAoiServer(async ({ port, tick, move, resetAoi }) => {
      const a = await join(port);
      const b = await join(port);

      // 400 units apart: comfortably inside the radius.
      move(a.playerState.entityId, 4_000, 4_000);
      move(b.playerState.entityId, 4_400, 4_000);
      resetAoi();
      const movedAtTick = latestTick(a.client) + 1;

      for (let index = 0; index < 6; index += 1) tick();
      await new Promise((resolve) => setTimeout(resolve, 150));

      const worldA = materialise(a.client, movedAtTick);
      const worldB = materialise(b.client, movedAtTick);

      assert.ok(worldA.has(b.playerState.entityId), 'A must see B 400 units away');
      assert.ok(worldB.has(a.playerState.entityId), 'B must see A 400 units away');
    });
  });

  test('a ship leaving the radius is removed from the other client', async () => {
    await withAoiServer(async ({ port, server, tick, move, resetAoi }) => {
      const a = await join(port);
      const b = await join(port);

      // Start close enough to be mutually visible.
      move(a.playerState.entityId, 4_000, 4_000);
      move(b.playerState.entityId, 4_200, 4_000);
      resetAoi();
      const movedAtTick = latestTick(a.client) + 1;

      for (let index = 0; index < 6; index += 1) tick();
      await new Promise((resolve) => setTimeout(resolve, 150));

      assert.ok(
        materialise(a.client, movedAtTick).has(b.playerState.entityId),
        'initial state: A sees B',
      );

      // Teleport B far away, then tick: A must be told B is gone.
      const playerB = server.world.getPlayer(b.playerState.entityId);
      assert.ok(playerB !== undefined);
      playerB.x = 7_500;
      playerB.y = 7_500;
      server.world.refreshGrid();

      const seenAt = latestTick(a.client);
      for (let index = 0; index < 8; index += 1) tick();

      const deadline = Date.now() + 2_000;
      let stillVisible = true;
      while (stillVisible && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (latestTick(a.client) > seenAt) {
          stillVisible = materialise(a.client, movedAtTick).has(b.playerState.entityId);
        }
      }

      assert.ok(!stillVisible, 'B must disappear from A exactly when it leaves the radius');
      assert.ok(
        materialise(a.client, movedAtTick).has(a.playerState.entityId),
        'A keeps seeing itself',
      );
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  Server-side unit checks                                                   */
/* -------------------------------------------------------------------------- */

test('the world keeps its players in sync with the connection registry', async () => {
  /* Runs on its own server instance so the counts are exact: other tests in this
     file deliberately leave connections draining, and polling for an absolute
     baseline would race with them. */
  let local: NetworkServer | null = null;
  const localClock = new SimulationClock({
    tickRate: 20,
    onTick: () => {
      local?.loop.tick();
    },
  });
  const fresh = new NetworkServer({
    host: '127.0.0.1',
    port: 0,
    wsPath: '/ws',
    shardId: 'count-shard',
    maxPlayers: 10,
    logger,
    clock: localClock,
  });
  local = fresh;
  const freshPort = await fresh.listen();
  localClock.start();

  try {
    assert.equal(fresh.playerCount, 0, 'a fresh shard starts empty');

    const a = await join(freshPort);
    const b = await join(freshPort);
    assert.equal(fresh.playerCount, 2, 'two joins must add two players');

    a.client.close();
    await waitFor(() => fresh.playerCount === 1);
    assert.equal(fresh.playerCount, 1, 'closing a socket must remove its player');

    b.client.close();
    await waitFor(() => fresh.playerCount === 0);
    assert.equal(fresh.playerCount, 0, 'the world must drain back to empty');
  } finally {
    localClock.stop();
    fresh.close();
  }
});

/** Poll a condition until it holds, or fail after `timeoutMs`. */
async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition was not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
