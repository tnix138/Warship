/**
 * Minimal zero-dependency logger.
 *
 * JSON lines in production (so `jq` and log shippers work out of the box) and a
 * human-readable single line in development. Replaced by pino once we need log
 * rotation, sampling or transports — the interface is intentionally pino-shaped.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const LEVEL_LABEL: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info: 'INFO ',
  warn: 'WARN ',
  error: 'ERROR',
};

/** Arbitrary structured fields attached to a log line. */
export type LogContext = Record<string, unknown>;

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  /** Returns a logger that merges `bindings` into every line (e.g. `{ shardId }`). */
  child(bindings: LogContext): Logger;
}

export interface LoggerOptions {
  readonly minLevel: LogLevel;
  /** Pretty output for humans; JSON lines for machines. */
  readonly pretty: boolean;
  readonly bindings?: LogContext;
}

export function createLogger(options: LoggerOptions): Logger {
  const { minLevel, pretty } = options;
  const bindings = options.bindings ?? {};

  const emit = (level: LogLevel, message: string, context?: LogContext): void => {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[minLevel]) return;

    const fields: LogContext = { ...bindings, ...context };
    const line = pretty
      ? formatPretty(level, message, fields)
      : JSON.stringify({ level, time: new Date().toISOString(), msg: message, ...fields });

    if (level === 'error') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  };

  const logger: Logger = {
    debug: (message, context) => {
      emit('debug', message, context);
    },
    info: (message, context) => {
      emit('info', message, context);
    },
    warn: (message, context) => {
      emit('warn', message, context);
    },
    error: (message, context) => {
      emit('error', message, context);
    },
    child: (extra) => createLogger({ minLevel, pretty, bindings: { ...bindings, ...extra } }),
  };

  return logger;
}

function formatPretty(level: LogLevel, message: string, fields: LogContext): string {
  const timestamp = new Date().toISOString().slice(11, 23);
  const context = Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : '';
  return `${timestamp} ${LEVEL_LABEL[level]} ${message}${context}`;
}
