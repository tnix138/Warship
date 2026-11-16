import { randomUUID } from 'node:crypto';

import { NETWORK_MAX_MESSAGES_PER_SECOND, type ConnectionState } from '@warship/shared';

import type { UwsWebSocket } from './uws.js';
import { RateLimiter } from './rateLimit.js';

/** Extra data uWebSockets carries on every socket. Created during `upgrade`. */
export interface ConnectionContext {
  connectionId: string;
  remoteAddress: string;
  connectedAt: number;
}

/**
 * Server-side bookkeeping for one socket.
 *
 * Transport and session concerns only: liveness, heartbeat, rate limiting and the
 * link to the player this connection controls. Ship state lives in `Player`.
 */
export interface Connection {
  readonly id: string;
  readonly ws: UwsWebSocket<ConnectionContext>;
  readonly remoteAddress: string;
  /** Wall-clock ms when the TCP/WS connection was accepted. */
  readonly connectedAt: number;
  state: ConnectionState;
  /** Monotonic ms of the last frame received from this client. */
  lastSeenAt: number;
  /** Monotonic ms of the last heartbeat answer we got back. */
  lastPongAt: number;
  /** Nonce of the heartbeat currently in flight (0 = none). */
  lastPingNonce: number;
  /** Smoothed round-trip time in ms; `null` until the first pong arrives. */
  rttMs: number | null;
  /** Entity id of the player this socket drives; `null` until JOIN succeeds. */
  playerId: string | null;
  /** Per-connection message budget. */
  readonly rateLimiter: RateLimiter;
}

/** Build the mutable record for a freshly accepted socket. */
export function createConnection(
  ws: UwsWebSocket<ConnectionContext>,
  remoteAddress: string,
): Connection {
  const now = performance.now();
  return {
    id: randomUUID(),
    ws,
    remoteAddress,
    connectedAt: Date.now(),
    state: 'handshaking',
    lastSeenAt: now,
    lastPongAt: now,
    lastPingNonce: 0,
    rttMs: null,
    playerId: null,
    rateLimiter: new RateLimiter({
      limit: NETWORK_MAX_MESSAGES_PER_SECOND,
      windowMs: 1_000,
    }),
  };
}
