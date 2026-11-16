import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { decode, encode } from '@msgpack/msgpack';
import {
  MessageType,
  PROTOCOL_VERSION,
  ShipClass,
  WS_SUBPROTOCOL,
  type ClientMessage,
  type InputMessage,
  type ServerMessage,
  type SnapshotMessage,
} from '@warship/shared';

import { Prediction } from './Prediction';
import { Interpolation } from '../net/Interpolation';

/**
 * True end-to-end smoothness tests.
 *
 * This boots the **real game server** as a separate process (`dist/index.js`, the same
 * entry point `pnpm start` uses), connects a real WebSocket to it, and drives the real
 * `Prediction` and `Interpolation` classes with the frames that come back. Nothing in
 * the path is mocked: real clock, real world, real encoder, real socket.
 *
 * Two properties are asserted, because they are what a player perceives as
 * "jitter":
 *
 *  1. Holding throttle produces motion that never reverses and never stalls, sampled
 *     every 100 ms.
 *  2. Snapshots arriving 50 ms apart interpolate into motion on essentially every
 *     60 Hz frame rather than stepping at 20 Hz.
 */

const here = path.dirname(new URL(import.meta.url).pathname);
/* This file lives at packages/client/src/game, so the server is three levels up
   and back down. Resolving from the wrong root silently spawns a non-existent
   entry point, and the only symptom is "did not start". */
const serverRoot = path.resolve(here, '../../../server');

/** The server must be built before this test runs. */
const ENTRY = path.join(serverRoot, 'dist/index.js');

interface LiveClient {
  readonly frames: ServerMessage[];
  send(message: ClientMessage): void;
  close(): void;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function connectJoined(port: number): Promise<LiveClient> {
  const socket = new WebSocket(`ws://127.0.0.1:${port.toString()}/ws`, [WS_SUBPROTOCOL]);
  socket.binaryType = 'arraybuffer';

  const frames: ServerMessage[] = [];

  /* Handlers are attached before the socket opens; snapshots start arriving the
     instant JOIN lands, and anything attached later silently drops those frames. */
  socket.onmessage = (event) => {
    frames.push(decode(new Uint8Array(event.data as ArrayBuffer)) as ServerMessage);
  };

  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => {
      resolve();
    };
    socket.onerror = () => {
      reject(new Error('the server socket failed to open'));
    };
  });

  socket.send(
    encode({
      v: PROTOCOL_VERSION,
      t: MessageType.JOIN,
      shipClass: ShipClass.Normal,
      client: { version: 'e2e' },
    } satisfies ClientMessage),
  );

  return {
    frames,
    send(message) {
      socket.send(encode(message));
    },
    close() {
      socket.close();
    },
  };
}

function latestSnapshot(client: LiveClient): SnapshotMessage | undefined {
  for (let index = client.frames.length - 1; index >= 0; index -= 1) {
    const frame = client.frames[index];
    if (frame?.t === MessageType.SNAPSHOT) return frame;
  }
  return undefined;
}

/** Poll until the server reports which entity belongs to this client. */
async function findSelfId(client: LiveClient): Promise<string> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const snapshot = latestSnapshot(client);
    const mine = snapshot?.entities.find((entity) => entity.ackSeq !== undefined);
    if (mine !== undefined) return mine.id;
    await sleep(20);
  }
  throw new Error('the server never reported an ackSeq for the joining client');
}

let child: ChildProcess;
let port: number;

/** Ask the OS for a free port by binding and immediately closing a socket. */
async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  const probe = createServer();
  await new Promise<void>((resolve) => {
    probe.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = probe.address();
  const found = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => {
    probe.close(() => {
      resolve();
    });
  });
  return found;
}

before(async () => {
  port = await freePort();

  if (!existsSync(ENTRY)) {
    throw new Error(
      `the server is not built: ${ENTRY} is missing. Run \`pnpm --filter @warship/server build\`.`,
    );
  }

  child = spawn(process.execPath, [ENTRY], {
    cwd: serverRoot,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      SHARD_ID: 'e2e',
      // Must be `info`: the startup log is how this test knows the port is bound.
      LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stderrTail: string[] = [];
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail.push(String(chunk));
    if (stderrTail.length > 20) stderrTail.shift();
  });

  /* Wait for the process to announce it is listening rather than sleeping a fixed
     amount: a slow machine would otherwise fail the test intermittently. */
  const started = await Promise.race([
    (async (): Promise<boolean> => {
      for await (const chunk of child.stdout ?? []) {
        if (String(chunk).includes('websocket server listening')) return true;
      }
      return false;
    })(),
    sleep(15_000).then(() => false),
  ]);

  if (!started) {
    child.kill('SIGKILL');
    const why = stderrTail.length > 0 ? `\n server stderr:\n${stderrTail.join('')}` : '';
    throw new Error(`the game server did not start within 15 s${why}`);
  }
});

after(async () => {
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => undefined);
  }
});

describe('end-to-end smoothness', () => {
  test('holding throttle moves the ship forward, monotonically, logged every 100 ms', async () => {
    const client = await connectJoined(port);
    try {
      const selfId = await findSelfId(client);

      /* Drive the real prediction exactly as `Game.ts` does: 20 Hz input, 60 Hz
         frames, reconcile on every snapshot. This is the pose the player sees. */
      const prediction = new Prediction({}, { stats: { maxSpeed: 240, turnRate: 1.7 } });

      let sequence = 0;
      let adopted = false;
      const sampled: { at: number; x: number }[] = [];
      const start = performance.now();
      let lastSampleAt = start;

      while (performance.now() - start < 3_000) {
        const now = performance.now();
        const deltaS = 1 / 60;
        const elapsedTicks = Math.floor((now - start) / 50);

        let input: InputMessage['input'] | null = null;
        if (elapsedTicks >= sequence + 1) {
          sequence += 1;
          input = { turn: 0, throttle: 1, aim: 0, firing: false };
          client.send({
            v: PROTOCOL_VERSION,
            t: MessageType.INPUT,
            seq: sequence,
            tick: latestSnapshot(client)?.tick ?? 0,
            input,
          } satisfies InputMessage);
        }

        prediction.update(deltaS, input, sequence);

        const snapshot = latestSnapshot(client);
        const mine = snapshot?.entities.find((entity) => entity.id === selfId);
        if (snapshot !== undefined && mine !== undefined) {
          if (!adopted) {
            // First authoritative pose: adopt it, or the ship starts at the origin.
            prediction.reconcile({ x: mine.x, y: mine.y, rotation: mine.rotation }, 0);
            adopted = true;
          } else {
            prediction.reconcile(
              { x: mine.x, y: mine.y, rotation: mine.rotation },
              mine.ackSeq ?? 0,
            );
          }
        }

        if (now - lastSampleAt >= 100) {
          lastSampleAt = now;
          sampled.push({ at: now - start, x: prediction.actor.x });
        }

        await sleep(1000 / 60);
      }

      assert.ok(sampled.length >= 15, `needed 100 ms samples, got ${sampled.length}`);

      const first = sampled[0];
      const last = sampled[sampled.length - 1];
      assert.ok(first !== undefined && last !== undefined);

      // Property 1: real travel while accelerating from rest.
      const travelled = last.x - first.x;
      assert.ok(travelled > 250, `expected real travel, moved ${travelled.toFixed(1)} u`);

      // Property 2: every 100 ms sample is ahead of the previous one.
      for (let index = 1; index < sampled.length; index += 1) {
        const previous = sampled[index - 1];
        const current = sampled[index];
        assert.ok(previous !== undefined && current !== undefined);
        assert.ok(
          current.x > previous.x,
          `position went backwards at ${current.at.toFixed(0)} ms: ${previous.x.toFixed(2)} -> ${current.x.toFixed(2)}`,
        );
      }

      // Property 3: no silent stall.
      for (let index = 1; index < sampled.length; index += 1) {
        const previous = sampled[index - 1];
        const current = sampled[index];
        assert.ok(previous !== undefined && current !== undefined);
        assert.ok(
          current.x - previous.x > 4,
          `motion stalled between ${previous.at.toFixed(0)} and ${current.at.toFixed(0)} ms`,
        );
      }
    } finally {
      client.close();
    }
  });

  test('snapshots 50 ms apart interpolate into continuous motion', async () => {
    const client = await connectJoined(port);
    try {
      const selfId = await findSelfId(client);

      /* Feed the interpolator live from the socket while sampling at 60 Hz. A real
         server never stops sending; an interpolator with no new data is *supposed* to
         hold the last pose, so a test that stopped feeding would be measuring the
         freeze guard rather than smoothness. */
      const interpolation = new Interpolation();
      let baseServerTime: number | null = null;
      const poses: number[] = [];
      let consumed = 0;
      let clockMs = 0;
      let sequence = 0;
      let inputAt = 0;
      const deadline = performance.now() + 2_000;

      while (performance.now() < deadline) {
        const now = performance.now();

        // Keep driving so the ship is genuinely moving.
        if (now >= inputAt) {
          inputAt = now + 50;
          sequence += 1;
          client.send({
            v: PROTOCOL_VERSION,
            t: MessageType.INPUT,
            seq: sequence,
            tick: latestSnapshot(client)?.tick ?? 0,
            input: { turn: 0, throttle: 1, aim: 0, firing: false },
          } satisfies InputMessage);
        }

        // Ingest anything new.
        for (; consumed < client.frames.length; consumed += 1) {
          const frame = client.frames[consumed];
          if (frame?.t !== MessageType.SNAPSHOT) continue;
          baseServerTime ??= frame.serverTime;

          interpolation.push(
            {
              tick: frame.tick,
              serverTime: frame.serverTime - baseServerTime,
              entities: frame.entities.map((entity) => ({
                id: entity.id,
                x: entity.x,
                y: entity.y,
                rotation: entity.rotation,
                hp: entity.hp,
                shipClass: entity.shipClass,
              })),
            },
            {
              full: frame.full,
              removed: frame.removed?.map((gone) => gone.id) ?? [],
              now: clockMs,
            },
          );
        }

        clockMs += 1000 / 60;
        const mine = interpolation.sample(clockMs).find((entity) => entity.id === selfId);
        if (mine !== undefined) poses.push(mine.x);

        await sleep(1000 / 60);
      }

      // Skip the start-up interval before the buffer has a pair to blend between.
      const settled = poses.slice(20);
      assert.ok(settled.length > 40, `too few poses: ${settled.length}`);

      let moved = 0;
      for (let index = 1; index < settled.length; index += 1) {
        if (Math.abs((settled[index] ?? 0) - (settled[index - 1] ?? 0)) > 1e-9) moved += 1;
      }

      /* Continuous, not stepped: on nearly every 60 Hz frame the interpolated pose
         must differ from the previous one. Changing at 20 Hz would mean the buffer is
         sampled at snapshot boundaries instead of between them. */
      assert.ok(
        moved >= settled.length * 0.9,
        `interpolated motion changed on only ${String(moved)}/${String(settled.length)} frames`,
      );

      // And it must advance rather than reverse.
      let backwards = 0;
      for (let index = 1; index < settled.length; index += 1) {
        if ((settled[index] ?? 0) - (settled[index - 1] ?? 0) < -1e-9) backwards += 1;
      }
      assert.equal(backwards, 0, `interpolated motion reversed ${String(backwards)} times`);
    } finally {
      client.close();
    }
  });
});
