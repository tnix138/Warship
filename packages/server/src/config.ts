import {
  DB_FILE_DEFAULT,
  DEFAULT_SHARD_ID,
  MAX_PLAYERS_PER_SERVER,
  WS_PATH,
  type RuntimeEnvironment,
} from '@warship/shared';

/** Everything the server boots with. Immutable once created. */
export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly env: RuntimeEnvironment;
  /** Identifies this simulation process. MVP runs a single shard. */
  readonly shardId: string;
  readonly wsPath: string;
  readonly maxPlayers: number;
  readonly databaseFile: string;
  /** Log verbosity, derived from `env` unless overridden. */
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
}

const DEFAULT_PORT = 8080;

/**
 * Read configuration from the environment. Every variable is optional and has a
 * sane default so `pnpm dev` works with zero setup.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const runtimeEnv = parseEnvironment(env.NODE_ENV);

  return {
    host: env.HOST ?? '0.0.0.0',
    port: parsePort(env.PORT),
    env: runtimeEnv,
    shardId: env.SHARD_ID ?? DEFAULT_SHARD_ID,
    wsPath: WS_PATH,
    maxPlayers: parsePositiveInt(env.MAX_PLAYERS, MAX_PLAYERS_PER_SERVER),
    databaseFile: env.WARSHIP_DB_FILE ?? DB_FILE_DEFAULT,
    logLevel: parseLogLevel(env.LOG_LEVEL, runtimeEnv === 'production' ? 'info' : 'debug'),
  };
}

function parseEnvironment(value: string | undefined): RuntimeEnvironment {
  if (value === 'production' || value === 'test') return value;
  return 'development';
}

function parsePort(value: string | undefined): number {
  const parsed = parsePositiveInt(value, DEFAULT_PORT);
  if (parsed > 65_535) {
    throw new RangeError(`PORT must be <= 65535, received ${parsed.toString()}`);
  }
  return parsed;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new RangeError(`Expected a positive integer, received "${value}"`);
  }
  return parsed;
}

function parseLogLevel(
  value: string | undefined,
  fallback: ServerConfig['logLevel'],
): ServerConfig['logLevel'] {
  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') {
    return value;
  }
  return fallback;
}
