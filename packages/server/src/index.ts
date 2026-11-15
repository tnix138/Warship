import { PROTOCOL_VERSION, TICK_RATE } from '@warship/shared';

import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { NetworkServer } from './net/server.js';
import { SimulationClock } from './sim/clock.js';

/**
 * Entry point: wire config → logger → clock → network server → game loop, then run
 * until SIGINT/SIGTERM.
 *
 * Ordering is deliberate:
 *  1. the network server must be listening before the clock starts ticking, so the
 *     first snapshot never refers to a world nobody has joined yet,
 *  2. the clock drives `loop.tick()`, which is synchronous — a slow tick shows up as
 *     clock drift in the logs rather than as a growing queue of pending promises.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({
    minLevel: config.logLevel,
    pretty: config.env !== 'production',
    bindings: { shard: config.shardId },
  });

  logger.info('starting warship server', {
    env: config.env,
    node: process.version,
    protocol: PROTOCOL_VERSION,
    tickRate: TICK_RATE,
  });

  const clock = new SimulationClock({
    tickRate: TICK_RATE,
    onTick: () => {
      server.loop.tick();
    },
    onStats: (stats) => {
      // Only complain when the server is actually struggling; a clean run is silent.
      if (stats.driftMs > 50 || stats.maxLatenessMs > 100 || stats.droppedTicks > 0) {
        logger.warn('simulation clock behind schedule', { ...stats });
      }
    },
  });

  const server = new NetworkServer({
    host: config.host,
    port: config.port,
    wsPath: config.wsPath,
    shardId: config.shardId,
    maxPlayers: config.maxPlayers,
    logger,
    clock,
  });

  const port = await server.listen();
  logger.info('server ready', { port, players: server.playerCount });

  clock.start();

  const shutdown = (signal: string): void => {
    logger.info('shutting down', { signal });
    clock.stop();
    server.close();
    process.exitCode = 0;
  };

  process.once('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    shutdown('SIGTERM');
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection', { reason: String(reason) });
  });
  process.on('uncaughtException', (error) => {
    logger.error('uncaught exception', { error: error.message, stack: error.stack });
    process.exitCode = 1;
  });
}

main().catch((error: unknown) => {
  // The logger may not exist yet, so this one uses the console directly.
  console.error('fatal: failed to start warship server', error);
  process.exit(1);
});
