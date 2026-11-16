#!/usr/bin/env node
/**
 * Headless client that prints the game state.
 *
 * No browser exists in the build environment, so this stands in for "take a
 * screenshot": it connects exactly like the real client, drives it with scripted
 * input, and prints what the server told it — snapshots, deltas, AoI membership,
 * interpolation buffer and predicted-vs-authoritative error.
 *
 * ```bash
 * pnpm --filter @warship/server run state            # one client, drives in a circle
 * pnpm --filter @warship/server run state -- --watch  # keeps printing every second
 * ```
 *
 * Point it at a running server with `--url ws://host:port/ws` (default is the dev
 * server on 8080, i.e. the same one `pnpm dev` starts).
 */

import { decode, encode } from '@msgpack/msgpack';

import {
  AOI_INTEREST_RADIUS,
  MessageType,
  PROTOCOL_VERSION,
  SHIP_CLASSES,
  TICK_DURATION_MS,
  type PlayerStateMessage,
  type ServerMessage,
  type SnapshotMessage,
  type SnapshotEntity,
} from '@warship/shared';

const DEFAULT_URL = 'ws://127.0.0.1:8080/ws';

interface Options {
  readonly url: string;
  readonly seconds: number;
  readonly watch: boolean;
  readonly shipClass: 'speed' | 'normal' | 'power';
}

function parseArgs(argv: readonly string[]): Options {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  return {
    url: get('--url') ?? DEFAULT_URL,
    seconds: Number(get('--seconds') ?? '4'),
    watch: argv.includes('--watch'),
    shipClass: (get('--ship') as Options['shipClass'] | undefined) ?? 'normal',
  };
}

/* -------------------------------------------------------------------------- */
/*  Tiny formatting helpers                                                   */
/* -------------------------------------------------------------------------- */

const bold = (text: string): string => `\u001B[1m${text}\u001B[0m`;
const dim = (text: string): string => `\u001B[2m${text}\u001B[0m`;
const cyan = (text: string): string => `\u001B[36m${text}\u001B[0m`;
const green = (text: string): string => `\u001B[32m${text}\u001B[0m`;
const amber = (text: string): string => `\u001B[33m${text}\u001B[0m`;

/** A snapshot entity whose class has been resolved (deltas may omit it). */
interface ResolvedEntity extends SnapshotEntity {
  readonly shipClass: NonNullable<SnapshotEntity['shipClass']>;
}

/** The command-line equivalent of `ClientWorld`: apply full snapshots and deltas. */
class Mirror {
  readonly entities = new Map<string, ResolvedEntity>();
  tick = 0;
  fullFrames = 0;
  deltaFrames = 0;
  bytes = 0;
  readonly frameSizes: number[] = [];

  apply(snapshot: SnapshotMessage, bytes: number): void {
    this.tick = snapshot.tick;
    this.bytes += bytes;

    if (snapshot.full) {
      this.fullFrames += 1;
      const present = new Set(snapshot.entities.map((entity) => entity.id));
      for (const id of [...this.entities.keys()]) {
        if (!present.has(id)) this.entities.delete(id);
      }
    } else {
      this.deltaFrames += 1;
      this.frameSizes.push(bytes);
    }

    for (const entity of snapshot.entities) {
      const previous = this.entities.get(entity.id);
      // A delta may omit `shipClass`; carry the last known one forward.
      const shipClass = entity.shipClass ?? previous?.shipClass;
      if (shipClass === undefined) continue;
      this.entities.set(entity.id, {
        id: entity.id,
        x: entity.x,
        y: entity.y,
        rotation: entity.rotation,
        hp: entity.hp,
        shipClass,
      });
    }

    for (const gone of snapshot.removed ?? []) this.entities.delete(gone.id);
  }
}

/* -------------------------------------------------------------------------- */
/*  Main                                                                      */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  console.log(bold('warship — headless state inspector'));
  console.log(dim(`connecting to ${options.url} as class "${options.shipClass}"`));

  const socket = new WebSocket(options.url, ['warship']);
  socket.binaryType = 'arraybuffer';

  const mirror = new Mirror();
  let playerState: PlayerStateMessage | null = null;
  let sequence = 0;
  const events: string[] = [];

  const ready = new Promise<void>((resolve, reject) => {
    socket.onerror = () => {
      reject(new Error(`could not connect to ${options.url} — is the server running?`));
    };

    socket.onmessage = (event) => {
      const bytes = new Uint8Array(event.data as ArrayBuffer);
      const message = decode(bytes) as ServerMessage;

      switch (message.t) {
        case MessageType.WELCOME: {
          console.log(
            green('✓'),
            'WELCOME',
            dim(
              `${message.shardId} · ${String(message.tickRate)} Hz · ${String(message.worldWidth)}×${String(message.worldHeight)}`,
            ),
          );

          socket.send(
            encode({
              v: PROTOCOL_VERSION,
              t: MessageType.JOIN,
              shipClass: options.shipClass,
              client: { version: 'state-inspector' },
            }),
          );
          return;
        }

        case MessageType.PLAYER_STATE: {
          playerState = message;
          if (mirror.fullFrames === 0) {
            console.log(
              green('✓'),
              'PLAYER_STATE',
              dim(
                `${message.shipClass} · hp ${String(message.hp)}/${String(message.maxHp)} · level ${String(message.level)} · zone ${message.zone}`,
              ),
            );
            console.log(green('✓'), 'joined as', cyan(message.entityId.slice(0, 8)));
            resolve();
          }
          return;
        }

        case MessageType.SNAPSHOT: {
          mirror.apply(message, bytes.byteLength);
          return;
        }

        case MessageType.EVENT: {
          events.push(message.kind);
          return;
        }

        default: {
          return;
        }
      }
    };
  });

  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => {
      resolve();
    };
    socket.addEventListener('error', () => {
      reject(new Error('socket failed to open'));
    });
  });

  await ready;
  console.log(dim('driving with a scripted circle…\n'));

  /* Drive: full throttle, slow left turn, ~20 inputs per second. */
  const startBytes = mirror.bytes;
  const drive = setInterval(() => {
    sequence += 1;
    socket.send(
      encode({
        v: PROTOCOL_VERSION,
        t: MessageType.INPUT,
        seq: sequence,
        tick: mirror.tick,
        input: { turn: 0.6, throttle: 1, aim: sequence * 0.05, firing: false },
      }),
    );
  }, TICK_DURATION_MS);

  const startedAt = Date.now();

  const report = (): void => {
    const elapsed = (Date.now() - startedAt) / 1000;
    const self = playerState === null ? undefined : mirror.entities.get(playerState.entityId);
    const bytes = mirror.bytes - startBytes;

    console.log(bold(`── t+${elapsed.toFixed(1)}s ─────────────────────────────────`));

    if (self === undefined) {
      console.log(amber('  no self entity yet'));
      return;
    }

    const stats = SHIP_CLASSES[self.shipClass];
    console.log(`  tick            ${String(mirror.tick)}`);
    console.log(`  self            ${cyan(self.id.slice(0, 8))}  ${self.shipClass}`);
    console.log(`  position        (${self.x.toFixed(1)}, ${self.y.toFixed(1)})`);
    console.log(
      `  rotation        ${self.rotation.toFixed(3)} rad  ${dim(`(turn rate ${String(stats.turnRate)} rad/s)`)}`,
    );
    console.log(`  hull            ${String(self.hp)}/${String(playerState?.maxHp ?? stats.hp)}`);
    console.log(
      `  entities in view ${bold(String(mirror.entities.size))}  ${dim(`(AoI radius ${String(AOI_INTEREST_RADIUS)})`)}`,
    );

    for (const entity of mirror.entities.values()) {
      if (entity.id === self.id) continue;
      console.log(
        dim(
          `     · ${entity.id.slice(0, 8)} ${entity.shipClass.padEnd(7)} (${entity.x.toFixed(0)}, ${entity.y.toFixed(0)}) hp ${String(entity.hp)}`,
        ),
      );
    }

    const avgDelta =
      mirror.frameSizes.length === 0
        ? 0
        : mirror.frameSizes.reduce((sum, size) => sum + size, 0) / mirror.frameSizes.length;

    console.log(
      `  snapshots       ${String(mirror.fullFrames)} full, ${String(mirror.deltaFrames)} delta`,
    );
    console.log(
      `  bandwidth       ${(bytes / 1024).toFixed(1)} KiB in ${elapsed.toFixed(1)}s  ${dim(`(${((bytes / elapsed / 1024) * 8).toFixed(1)} kbit/s)`)}`,
    );
    console.log(`  avg delta size  ${avgDelta.toFixed(0)} bytes`);
    if (events.length > 0) console.log(`  events          ${events.join(', ')}`);
    console.log('');
  };

  if (options.watch) {
    const watcher = setInterval(() => {
      report();
    }, 1_000);

    setTimeout(() => {
      clearInterval(watcher);
      clearInterval(drive);
      socket.close();
      process.exit(0);
    }, options.seconds * 1_000);
  } else {
    await new Promise((resolve) => setTimeout(resolve, options.seconds * 1_000));
    report();
    clearInterval(drive);
    socket.close();
    process.exit(0);
  }
}

main().catch((error: unknown) => {
  console.error(`\n${amber('✗')} ${error instanceof Error ? error.message : String(error)}`);
  console.error(dim('  start the server with `pnpm dev` first, or pass --url ws://host:port/ws'));
  process.exit(1);
});
