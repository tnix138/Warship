import {
  CLIENT_TIMEOUT_MS,
  CloseCode,
  MAX_PLAYERS_PER_SERVER,
  MessageType,
  NETWORK_MAX_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
  TICK_RATE,
  WS_SUBPROTOCOL,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  type ClientMessage,
  type InputFrame,
  type InputMessage,
  type JoinMessage,
  type PickupMessage,
  type PongMessage,
  type ServerMessage,
  type UpgradeMessage,
} from '@warship/shared';

import type { Logger } from '../logger.js';
import { Loop } from '../game/Loop.js';
import { World } from '../game/World.js';
import type { SimulationClock } from '../sim/clock.js';
import { ProtocolError, decodeClientFrame, encodeMessage } from './codec.js';
import { createConnection, type Connection, type ConnectionContext } from './connection.js';
import { loadUws, type HttpResponse, type TemplatedApp, type UwsWebSocket } from './uws.js';

/** How often the server probes every client, in ms. */
const HEARTBEAT_INTERVAL_MS = 5_000;
/** A client that has not answered a heartbeat within this window is dropped. */
export const HEARTBEAT_TIMEOUT_MS = 15_000;
/** Smoothing factor for the round-trip estimate. */
const RTT_EWMA_ALPHA = 0.2;

export interface NetworkServerOptions {
  readonly host: string;
  readonly port: number;
  readonly wsPath: string;
  readonly shardId: string;
  readonly maxPlayers: number;
  readonly logger: Logger;
  readonly clock: SimulationClock;
}

/**
 * Owns the uWebSockets app: socket lifecycle, framing, heartbeats, rate limiting.
 *
 * The authoritative simulation lives in `World` and is advanced by `Loop`. This
 * class is the only bridge between the two: it turns inbound frames into
 * `World`/`Player` mutations and lets `Loop` push frames back out. Nothing here
 * computes gameplay.
 */
export class NetworkServer {
  readonly #options: NetworkServerOptions;
  readonly #log: Logger;
  readonly #connections = new Map<string, Connection>();
  /** connectionId -> connection, keyed the other way for O(1) broadcast by player. */
  readonly #connectionsByPlayer = new Map<string, Connection>();

  readonly world: World;
  readonly loop: Loop;

  #app: TemplatedApp | null = null;
  #heartbeat: NodeJS.Timeout | null = null;
  #nextNonce = 1;

  constructor(options: NetworkServerOptions) {
    if (options.maxPlayers > MAX_PLAYERS_PER_SERVER) {
      throw new RangeError(
        `maxPlayers cannot exceed MAX_PLAYERS_PER_SERVER (${MAX_PLAYERS_PER_SERVER.toString()})`,
      );
    }
    this.#options = options;
    this.#log = options.logger;

    this.world = new World({ shardId: options.shardId });
    this.loop = new Loop({
      world: this.world,
      logger: this.#log,
      send: (playerId, message) => {
        this.#sendToPlayer(playerId, message);
      },
      broadcast: (message) => {
        this.#broadcast(message);
      },
    });
  }

  /** Number of sockets currently connected. */
  get connectionCount(): number {
    return this.#connections.size;
  }

  /** Number of players in the world (JOINed sockets). */
  get playerCount(): number {
    return this.world.playerCount;
  }

  /** Bind the port and start accepting upgrades. Resolves with the bound port. */
  listen(): Promise<number> {
    const uws = loadUws();
    const app = uws.App();
    this.#app = app;

    app.get('/health', (res) => {
      respondJson(res, 200, {
        ok: true,
        shard: this.#options.shardId,
        tick: this.#options.clock.tick,
        connections: this.#connections.size,
        players: this.world.playerCount,
        droppedTicks: this.#options.clock.droppedTicks,
      });
    });

    app.ws<ConnectionContext>(this.#options.wsPath, {
      /* WebSocket tuning — see the uWS user manual for the trade-offs. */
      compression: uws.DISABLED,
      maxPayloadLength: NETWORK_MAX_PAYLOAD_BYTES,
      idleTimeout: 0, // we run our own application-level heartbeat instead
      sendPingsAutomatically: false,
      maxBackpressure: 256 * 1024,
      closeOnBackpressureLimit: false,

      upgrade: (res, req, context) => {
        const offered = req.getHeader('sec-websocket-protocol');
        // Echo the subprotocol back so the browser's `onopen` sees a match.
        const protocol = offered === WS_SUBPROTOCOL ? WS_SUBPROTOCOL : '';
        const remoteAddress = req.getHeader('x-forwarded-for') || 'direct';

        res.upgrade<ConnectionContext>(
          { connectionId: '', remoteAddress, connectedAt: Date.now() },
          req.getHeader('sec-websocket-key'),
          protocol,
          req.getHeader('sec-websocket-extensions'),
          context,
        );
      },

      open: (ws) => {
        this.#onOpen(ws);
      },
      message: (ws, message, isBinary) => {
        this.#onMessage(ws, message, isBinary);
      },
      pong: (ws) => {
        this.#touch(ws);
      },
      dropped: (ws) => {
        this.#log.warn('dropped frame from slow client', {
          connection: ws.getUserData().connectionId,
        });
      },
      close: (ws, code, message) => {
        this.#onClose(ws, code, message);
      },
    });

    return new Promise<number>((resolve, reject) => {
      app.listen(this.#options.host, this.#options.port, (token) => {
        if (!token) {
          reject(
            new Error(
              `Failed to bind ${this.#options.host}:${this.#options.port.toString()} — port already in use?`,
            ),
          );
          return;
        }

        this.#heartbeat = setInterval(() => {
          this.#beat();
        }, HEARTBEAT_INTERVAL_MS);
        this.#heartbeat.unref();

        this.#log.info('websocket server listening', {
          host: this.#options.host,
          port: this.#options.port,
          wsPath: this.#options.wsPath,
          maxPlayers: this.#options.maxPlayers,
          shardId: this.#options.shardId,
          maxPayloadBytes: NETWORK_MAX_PAYLOAD_BYTES,
        });

        // Binding to port 0 lets the OS choose; report the port we actually got.
        const bound =
          typeof uws.us_socket_local_port === 'function'
            ? uws.us_socket_local_port(token)
            : this.#options.port;
        resolve(bound > 0 ? bound : this.#options.port);
      });
    });
  }

  /** Close every socket and release the port. */
  close(): void {
    if (this.#heartbeat !== null) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = null;
    }
    for (const connection of this.#connections.values()) {
      safeEnd(connection.ws, CloseCode.GoingAway, 'server shutting down');
    }
    this.#connections.clear();
    this.#connectionsByPlayer.clear();
    this.world.players.clear();
    this.#app?.close();
    this.#app = null;
  }

  /* ------------------------------------------------------------------------ */
  /*  Socket lifecycle                                                        */
  /* ------------------------------------------------------------------------ */

  #onOpen(ws: UwsWebSocket<ConnectionContext>): void {
    if (this.#connections.size >= this.#options.maxPlayers) {
      safeEnd(ws, CloseCode.ServerFull, 'server full');
      return;
    }

    const connection = createConnection(ws, textOf(ws.getRemoteAddressAsText()) || 'unknown');
    ws.getUserData().connectionId = connection.id;
    this.#connections.set(connection.id, connection);

    this.#log.info('connection opened', {
      connection: connection.id,
      remote: connection.remoteAddress,
      total: this.#connections.size,
    });

    this.#send(connection, {
      v: PROTOCOL_VERSION,
      t: MessageType.WELCOME,
      sessionId: connection.id,
      shardId: this.#options.shardId,
      serverTime: Date.now(),
      tick: this.world.tick,
      tickRate: TICK_RATE,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      worldWidth: WORLD_WIDTH,
      worldHeight: WORLD_HEIGHT,
      resumeToken: connection.id,
    });
  }

  #onMessage(ws: UwsWebSocket<ConnectionContext>, frame: ArrayBuffer, isBinary: boolean): void {
    const connection = this.#connections.get(ws.getUserData().connectionId);
    if (!connection) return;
    connection.lastSeenAt = performance.now();

    if (!isBinary) {
      this.#disconnect(connection, CloseCode.UnsupportedData, 'binary frames only');
      return;
    }

    // Rate limiting happens before decoding: a hostile client must not be able to
    // make us allocate by flooding us with frames we are going to throw away.
    if (!connection.rateLimiter.tryConsume()) {
      this.#log.warn('rate limit exceeded, frame dropped', {
        connection: connection.id,
        dropped: connection.rateLimiter.droppedCount,
        limitPerSecond: connection.rateLimiter.limit,
      });
      return;
    }

    let frameMessage;
    try {
      frameMessage = decodeClientFrame(frame);
    } catch (error) {
      const reason = error instanceof ProtocolError ? error.message : 'malformed frame';
      this.#log.warn('protocol error', { connection: connection.id, reason });
      this.#disconnect(connection, CloseCode.ProtocolError, reason);
      return;
    }

    if (frameMessage.v !== PROTOCOL_VERSION) {
      this.#log.warn('protocol version mismatch', {
        connection: connection.id,
        client: frameMessage.v,
        server: PROTOCOL_VERSION,
      });
      this.#disconnect(connection, CloseCode.VersionMismatch, 'protocol version mismatch');
      return;
    }

    const message = frameMessage as ClientMessage;

    switch (message.t) {
      case MessageType.JOIN: {
        this.#onJoin(connection, message);
        return;
      }
      case MessageType.INPUT: {
        this.#onInput(connection, message);
        return;
      }
      case MessageType.PICKUP: {
        this.#onPickup(connection, message);
        return;
      }
      case MessageType.UPGRADE: {
        this.#onUpgrade(connection, message);
        return;
      }
      case MessageType.PING: {
        this.#send(connection, {
          v: PROTOCOL_VERSION,
          t: MessageType.PONG,
          nonce: message.nonce,
          sentAt: message.sentAt,
          tick: this.world.tick,
        });
        return;
      }
      case MessageType.PONG: {
        this.#onPong(connection, message);
        return;
      }
      default: {
        /* Exhaustive: adding a MessageType id must produce a compile error here. */
        message satisfies never;
      }
    }
  }

  /* ------------------------------------------------------------------------ */
  /*  Game handlers                                                           */
  /* ------------------------------------------------------------------------ */

  #onJoin(connection: Connection, message: JoinMessage): void {
    if (connection.playerId !== null) {
      this.#log.warn('duplicate JOIN', { connection: connection.id });
      return;
    }

    if (this.world.playerCount >= this.#options.maxPlayers) {
      this.#disconnect(connection, CloseCode.ServerFull, 'server full');
      return;
    }

    const shipClass = message.shipClass;
    const player = this.world.addPlayer({ id: connection.id, shipClass });

    connection.playerId = player.id;
    connection.state = 'connected';
    this.#connectionsByPlayer.set(player.id, connection);

    this.#log.info('player joined', {
      player: player.id,
      shipClass: player.shipClass,
      clientVersion: message.client.version,
      players: this.world.playerCount,
      tick: this.world.tick,
    });

    // Private state first, so the client can render its own HUD on the same frame
    // that the first snapshot arrives.
    this.loop.sendPlayerState(player);
    this.loop.announceJoin(player);
  }

  #onInput(connection: Connection, message: InputMessage): void {
    const player = this.#playerOf(connection);
    if (player === undefined) return;

    // Clamp at the boundary: a client may send anything, the server decides what is
    // a legal intent. Declared as `Partial<InputFrame>` because the wire is not
    // trusted — every field may be missing or of the wrong type despite the types.
    const input = readInputFrame(message.input);

    const accepted = player.acceptInput(
      message.seq,
      {
        turn: input.turn ?? 0,
        throttle: input.throttle ?? 0,
        aim: input.aim ?? null,
        firing: input.firing ?? false,
      },
      performance.now(),
    );

    if (!accepted) {
      this.#log.debug('stale INPUT dropped', {
        player: player.id,
        seq: message.seq,
        lastSeq: player.lastInputSeq,
      });
    }
  }

  #onPickup(connection: Connection, message: PickupMessage): void {
    const player = this.#playerOf(connection);
    if (player === undefined) return;
    // Loot boxes do not exist yet; acknowledge the frame shape without acting on it
    // so the client's protocol path is exercised end to end.
    this.#log.debug('PICKUP ignored (no boxes in MVP)', {
      player: player.id,
      boxId: message.boxId,
    });
  }

  #onUpgrade(connection: Connection, message: UpgradeMessage): void {
    const player = this.#playerOf(connection);
    if (player === undefined) return;
    // Purchase validation lands with the dock UI milestone. The frame is parsed and
    // attributed here so the protocol surface is already exercised.
    this.#log.debug('UPGRADE ignored (dock not implemented)', {
      player: player.id,
      upgradeId: message.upgradeId,
    });
  }

  #onPong(connection: Connection, message: PongMessage): void {
    if (message.nonce !== connection.lastPingNonce) return;

    connection.lastPongAt = performance.now();
    const sample = connection.lastPongAt - message.sentAt;
    connection.rttMs =
      connection.rttMs === null
        ? sample
        : connection.rttMs + RTT_EWMA_ALPHA * (sample - connection.rttMs);

    this.#log.debug('heartbeat pong', {
      connection: connection.id,
      rttMs: Math.round(connection.rttMs),
    });
  }

  #onClose(ws: UwsWebSocket<ConnectionContext>, code: number, message: ArrayBuffer): void {
    const connection = this.#connections.get(ws.getUserData().connectionId);
    if (!connection) return;

    this.#connections.delete(connection.id);

    if (connection.playerId !== null) {
      this.#connectionsByPlayer.delete(connection.playerId);
      this.loop.announceLeave(connection.playerId);
      this.world.removePlayer(connection.playerId);
    }

    this.#log.info('connection closed', {
      connection: connection.id,
      code,
      reason: textOf(message),
      total: this.#connections.size,
      players: this.world.playerCount,
    });
  }

  /* ------------------------------------------------------------------------ */
  /*  Heartbeat                                                               */
  /* ------------------------------------------------------------------------ */

  #beat(): void {
    const now = performance.now();

    for (const connection of this.#connections.values()) {
      if (now - connection.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
        this.#log.warn('heartbeat timeout', {
          connection: connection.id,
          silentMs: Math.round(now - connection.lastPongAt),
        });
        this.#disconnect(connection, CloseCode.HeartbeatTimeout, 'heartbeat timeout');
        continue;
      }

      connection.lastPingNonce = this.#nextNonce;
      this.#nextNonce += 1;
      this.#send(connection, {
        v: PROTOCOL_VERSION,
        t: MessageType.PING,
        nonce: connection.lastPingNonce,
        sentAt: now,
      });
    }
  }

  /* ------------------------------------------------------------------------ */
  /*  Transport helpers                                                       */
  /* ------------------------------------------------------------------------ */

  #send(connection: Connection, message: ServerMessage): void {
    const status = connection.ws.send(encodeMessage(message).slice(), true, false);
    if (status === 2) {
      this.#log.warn('dropped frame: backpressure limit', { connection: connection.id });
    }
  }

  #sendToPlayer(playerId: string, message: ServerMessage): void {
    const connection = this.#connectionsByPlayer.get(playerId);
    if (connection === undefined) return;
    this.#send(connection, message);
  }

  #broadcast(message: ServerMessage): void {
    const frame = encodeMessage(message);
    for (const connection of this.#connections.values()) {
      if (connection.playerId === null) continue;
      /* uWS may hold a reference to the buffer until the socket drains, so every
         send gets its own copy. Sharing one frame across sockets corrupts delivery
         when the same tick fans out (verified: bursts silently lost snapshots). */
      connection.ws.send(frame.slice(), true, false);
    }
  }

  #playerOf(connection: Connection): ReturnType<World['getPlayer']> {
    if (connection.playerId === null) return undefined;
    return this.world.getPlayer(connection.playerId);
  }

  #disconnect(connection: Connection, code: number, reason: string): void {
    // Remove first: `ws.end()` fires the close handler synchronously, and the
    // handler must not log the same disconnect a second time.
    this.#connections.delete(connection.id);
    if (connection.playerId !== null) {
      this.#connectionsByPlayer.delete(connection.playerId);
      this.world.removePlayer(connection.playerId);
    }
    safeEnd(connection.ws, code, reason);
    this.#log.info('connection closed by server', {
      connection: connection.id,
      code,
      reason,
      total: this.#connections.size,
    });
  }

  #touch(ws: UwsWebSocket<ConnectionContext>): void {
    const connection = this.#connections.get(ws.getUserData().connectionId);
    if (connection) connection.lastSeenAt = performance.now();
  }
}

/* -------------------------------------------------------------------------- */
/*  Module-level helpers                                                      */
/* -------------------------------------------------------------------------- */

/** uWS hands us `ArrayBuffer`; decode without copying through Node buffers. */
function textOf(value: ArrayBuffer | string | undefined): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  return new TextDecoder().decode(new Uint8Array(value));
}

/** Clamp any inbound number into -1..1, mapping garbage to 0 (neutral). */
/**
 * Read an INPUT payload defensively.
 *
 * The decoder guarantees a MessagePack object with a numeric `t`, but the `input`
 * field is entirely attacker-controlled: it may be missing, a string, or carry
 * out-of-range numbers. Taking `unknown` here keeps that visible to readers (and to
 * the linter) instead of pretending the type is trustworthy.
 */
function readInputFrame(value: unknown): Partial<InputFrame> {
  if (typeof value !== 'object' || value === null) return {};
  const candidate = value as Record<string, unknown>;

  const aim = candidate.aim;
  return {
    turn: clampUnit(candidate.turn),
    throttle: clampUnit(candidate.throttle),
    aim: typeof aim === 'number' && Number.isFinite(aim) ? aim : null,
    firing: candidate.firing === true,
  };
}

function clampUnit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return value < -1 ? -1 : value > 1 ? 1 : value;
}

/** Send a JSON response through uWS's cork (one syscall for headers + body). */
function respondJson(res: HttpResponse, status: number, body: unknown): void {
  const statusLine = status === 200 ? '200 OK' : `${status.toString()} Error`;
  res.cork(() => {
    res
      .writeStatus(statusLine)
      .writeHeader('Content-Type', 'application/json; charset=utf-8')
      .end(JSON.stringify(body));
  });
}

function safeEnd(ws: UwsWebSocket<ConnectionContext>, code: number, reason: string): void {
  try {
    ws.end(code, reason);
  } catch {
    /* socket already closed — nothing to do */
  }
}

/** Defaults re-exported so tests and the CLI do not need to import `@warship/shared`. */
export const SERVER_DEFAULTS = {
  heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
  clientTimeoutMs: CLIENT_TIMEOUT_MS,
} as const;
