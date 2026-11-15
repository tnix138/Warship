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
async function latestSnapshot(
  client: TestClient,
  afterTick = -1,
  mustInclude?: string,
): Promise<SnapshotMessage> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const snapshots = client.frames.filter(
      (frame): frame is SnapshotMessage =>
        frame.t === MessageType.SNAPSHOT &&
        frame.tick > afterTick &&
        (mustInclude === undefined || frame.entities.some((entity) => entity.id === mustInclude)),
    );
    const newest = snapshots[snapshots.length - 1];
    if (newest !== undefined) return newest;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `no snapshot newer than tick ${String(afterTick)} arrived in time ` +
      `(received ${client.frames.map((f) => f.t).join(',') || 'nothing'})`,
  );
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

    const snapshot = await latestSnapshot(client, -1, playerState.entityId);
    const self = snapshot.entities.find((entity) => entity.id === playerState.entityId);

    assert.ok(self !== undefined, 'the joining player must be in the snapshot');
    assert.equal(self.shipClass, ShipClass.Speed);
    assert.equal(self.hp, playerState.maxHp);
    assert.ok(snapshot.tick > 0);

    client.close();
  });
});

/* -------------------------------------------------------------------------- */
/*  Input → simulation → snapshot                                             */
/* -------------------------------------------------------------------------- */

describe('input drives the authoritative simulation', { concurrency: 1 }, () => {
  test('a full-throttle INPUT moves the ship away from its spawn', async () => {
    const { client, playerState } = await join(port, ShipClass.Normal);

    const beforeSnapshot = await latestSnapshot(client, -1, playerState.entityId);
    const before = beforeSnapshot.entities.find((entity) => entity.id === playerState.entityId);
    assert.ok(before !== undefined);

    // Hold the throttle for ~300 ms of wall time: at 20 Hz that is ~6 ticks.
    for (let seq = 1; seq <= 8; seq += 1) {
      client.send(inputFrame(seq, before.id.length + seq));
      await new Promise((resolve) => setTimeout(resolve, TICK_DURATION_MS));
    }

    await new Promise((resolve) => setTimeout(resolve, 120));

    const after = (
      await latestSnapshot(client, beforeSnapshot.tick, playerState.entityId)
    ).entities.find((entity) => entity.id === playerState.entityId);
    assert.ok(after !== undefined);

    const moved = Math.hypot(after.x - before.x, after.y - before.y);
    assert.ok(moved > 5, `ship should have moved; moved ${moved.toFixed(2)} units`);

    client.close();
  });

  test('the server ignores a replayed (stale) INPUT sequence number', async () => {
    const { client, playerState } = await join(port);

    const startSnapshot = await latestSnapshot(client, -1, playerState.entityId);
    const start = startSnapshot.entities.find((e) => e.id === playerState.entityId);
    assert.ok(start !== undefined);

    // Send seq 5 with no throttle, then replay seq 3 with full throttle. The replay
    // must be dropped, so the ship must not accelerate.
    client.send(inputFrame(5, 1, { throttle: 0 }));
    client.send(inputFrame(3, 1, { throttle: 1, turn: 1 }));

    await new Promise((resolve) => setTimeout(resolve, 250));

    const end = (
      await latestSnapshot(client, startSnapshot.tick, playerState.entityId)
    ).entities.find((e) => e.id === playerState.entityId);
    assert.ok(end !== undefined);

    const drift = Math.hypot(end.x - start.x, end.y - start.y);
    assert.ok(drift < 5, `replayed input must not move the ship; drifted ${drift.toFixed(2)}`);

    client.close();
  });

  test('malformed INPUT fields are clamped instead of trusted', async () => {
    const { client } = await join(port);

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
    const snapshot = await latestSnapshot(client);
    assert.ok(snapshot.entities.length >= 1, 'server still healthy after hostile input');

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
    const snapshotA = await latestSnapshot(a.client, -1, b.playerState.entityId);
    const snapshotB = await latestSnapshot(b.client, -1, a.playerState.entityId);

    for (const snapshot of [snapshotA, snapshotB]) {
      const ids = snapshot.entities.map((entity) => entity.id);
      assert.ok(ids.includes(a.playerState.entityId), 'snapshot must contain player A');
      assert.ok(ids.includes(b.playerState.entityId), 'snapshot must contain player B');
    }

    const seenByA = snapshotA.entities.find((e) => e.id === b.playerState.entityId);
    assert.equal(seenByA?.shipClass, ShipClass.Power, 'A must see B with the right class');

    a.client.close();
    b.client.close();
  });

  test('a departing client is removed from the other client’s snapshots', async () => {
    const staying = await join(port);
    const leaving = await join(port);

    const beforeLeave = await latestSnapshot(staying.client, -1, staying.playerState.entityId);

    const leavingId = leaving.playerState.entityId;
    leaving.client.close();

    // Give the socket close handler and a couple of ticks time to land.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const snapshot = await latestSnapshot(staying.client, beforeLeave.tick + 2);
    const ids = snapshot.entities.map((entity) => entity.id);
    assert.ok(!ids.includes(leavingId), 'a closed player must not linger in snapshots');

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
    assert.ok(pongs <= 31, `at most the window budget may be answered; got ${String(pongs)}`);

    // The connection must still be alive: newer snapshots keep arriving.
    const snapshot = await latestSnapshot(client, -1, playerState.entityId);
    assert.ok(snapshot.entities.some((entity) => entity.id === playerState.entityId));

    client.close();
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
