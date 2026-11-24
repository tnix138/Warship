import { decode, encode } from '@msgpack/msgpack';
import {
  MessageType,
  PROTOCOL_VERSION,
  ShipClass,
  TICK_RATE,
  WS_SUBPROTOCOL,
  type ClientMessage,
  type ServerMessage,
} from '@warship/shared';

import { createLogger } from '../logger.js';
import { NetworkServer } from '../net/server.js';
import { SimulationClock } from '../sim/clock.js';

const CLIENTS = Number(process.env['CLIENTS'] ?? 50);
const DURATION_MS = Number(process.env['DURATION_MS'] ?? 3000);

async function runLoadTest(): Promise<void> {
  const logger = createLogger({ minLevel: 'error', pretty: false });
  const clock = new SimulationClock({ tickRate: TICK_RATE });
  const server = new NetworkServer({
    host: '127.0.0.1',
    port: 0,
    wsPath: '/ws',
    shardId: 'loadtest',
    maxPlayers: Math.max(100, CLIENTS + 10),
    logger,
    clock,
  });

  const port = await server.listen();
  const url = `ws://127.0.0.1:${port.toString()}/ws`;

  let welcomeCount = 0;
  let snapshotCount = 0;
  let errorCount = 0;

  const sockets: WebSocket[] = [];
  const intervals: ReturnType<typeof setInterval>[] = [];

  for (let i = 0; i < CLIENTS; i++) {
    const ws = new WebSocket(url, [WS_SUBPROTOCOL]);
    ws.binaryType = 'arraybuffer';
    sockets.push(ws);

    let seq = 1;
    ws.addEventListener('open', () => {
      const join: ClientMessage = {
        t: MessageType.JOIN,
        v: PROTOCOL_VERSION,
        shipClass: ShipClass.Normal,
      };
      ws.send(encode(join));

      const timer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          const input: ClientMessage = {
            t: MessageType.INPUT,
            v: PROTOCOL_VERSION,
            seq: seq++,
            input: {
              throttle: 1,
              turn: (i % 3) - 1,
            },
            tick: seq,
          };
          ws.send(encode(input));
        }
      }, 50);
      intervals.push(timer);
    });

    ws.addEventListener('message', (event) => {
      const msg = decode(new Uint8Array(event.data as ArrayBuffer)) as ServerMessage;
      if (msg.t === MessageType.WELCOME) {
        welcomeCount++;
      } else if (msg.t === MessageType.SNAPSHOT) {
        snapshotCount++;
      }
    });

    ws.addEventListener('error', () => {
      errorCount++;
    });
  }

  await new Promise((resolve) => setTimeout(resolve, DURATION_MS));

  for (const timer of intervals) {
    clearInterval(timer);
  }
  for (const ws of sockets) {
    ws.close();
  }
  await server.close();

  console.log(
    JSON.stringify({
      clients: CLIENTS,
      durationMs: DURATION_MS,
      welcomeCount,
      snapshotCount,
      errorCount,
    }),
  );

  if (welcomeCount < CLIENTS || errorCount > 0) {
    process.exitCode = 1;
  }
}

void runLoadTest();
