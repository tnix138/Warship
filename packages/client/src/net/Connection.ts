import { decode, encode } from '@msgpack/msgpack';

import {
  CLIENT_INPUT_RATE,
  MessageType,
  PROTOCOL_VERSION,
  WS_SUBPROTOCOL,
  type ClientMessage,
  type ConnectionState,
  type EventMessage,
  type InputFrame,
  type MessageType as MessageTypeId,
  type NetMessage,
  type PlayerStateMessage,
  type ServerMessage,
  type ShipClass,
  type SnapshotMessage,
  type WelcomeMessage,
} from '@warship/shared';

/**
 * Browser-side WebSocket client.
 *
 * Mirrors the server's codec (MessagePack, one envelope per frame) and owns the
 * connection state machine. It is deliberately transport-only: it validates frames,
 * keeps the socket alive and surfaces events. Everything gameplay-related is the
 * caller's job.
 *
 * The URL is same-origin by default (`ws://<origin>/ws`), which works in dev because
 * Vite proxies `/ws` to the game server, and in production because the same origin
 * serves both.
 */

export interface ConnectionListener {
  readonly onStateChange?: (state: ConnectionState) => void;
  readonly onWelcome?: (message: WelcomeMessage) => void;
  readonly onPlayerState?: (message: PlayerStateMessage) => void;
  readonly onSnapshot?: (message: SnapshotMessage) => void;
  readonly onEvent?: (message: EventMessage) => void;
  readonly onError?: (error: Error) => void;
}

export interface ConnectionOptions {
  /** Explicit URL; defaults to same-origin `/ws`. */
  readonly url?: string;
  readonly listeners?: ConnectionListener;
  /** How many seconds to wait before a reconnect attempt. `0` disables reconnects. */
  readonly reconnectDelayMs?: number;
}

/** Build the same-origin default URL. */
export function defaultSocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

export class Connection {
  #socket: WebSocket | null = null;
  #state: ConnectionState = 'idle';
  #listeners: ConnectionListener;
  #url: string;
  #reconnectDelayMs: number;
  #reconnectTimer: number | null = null;
  #closedByUser = false;

  /** Latest WELCOME, available once the socket is open. */
  welcome: WelcomeMessage | null = null;
  /** Latest private state for the local player. */
  playerState: PlayerStateMessage | null = null;
  /** Most recent snapshot, for renderers that poll instead of subscribing. */
  latestSnapshot: SnapshotMessage | null = null;

  constructor(options: ConnectionOptions = {}) {
    this.#url = options.url ?? defaultSocketUrl();
    this.#listeners = options.listeners ?? {};
    this.#reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
  }

  get state(): ConnectionState {
    return this.#state;
  }

  /** Open the socket. Idempotent. */
  connect(): void {
    if (this.#socket !== null) return;
    this.#closedByUser = false;
    this.#setState('connecting');

    const socket = new WebSocket(this.#url, [WS_SUBPROTOCOL]);
    socket.binaryType = 'arraybuffer';
    this.#socket = socket;

    socket.onopen = () => {
      this.#setState('handshaking');
    };

    socket.onmessage = (event) => {
      this.#handleFrame(event.data);
    };

    socket.onerror = () => {
      this.#listeners.onError?.(new Error(`websocket error on ${this.#url}`));
    };

    socket.onclose = (event) => {
      this.#socket = null;
      this.welcome = null;

      if (this.#closedByUser) {
        this.#setState('disconnected');
        return;
      }

      const reason = event.reason.length > 0 ? `: ${event.reason}` : '';
      this.#listeners.onError?.(new Error(`connection closed (${event.code.toString()})${reason}`));

      if (this.#reconnectDelayMs > 0) {
        this.#setState('reconnecting');
        this.#reconnectTimer = window.setTimeout(() => {
          this.#reconnectTimer = null;
          this.connect();
        }, this.#reconnectDelayMs);
      } else {
        this.#setState('disconnected');
      }
    };
  }

  /** Close and stop reconnecting. */
  disconnect(): void {
    this.#closedByUser = true;
    if (this.#reconnectTimer !== null) {
      window.clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#socket?.close(1000, 'client leaving');
    this.#socket = null;
    this.#setState('disconnected');
  }

  /**
   * Send the JOIN frame. Called by the game once the socket reports `handshaking`
   * (i.e. after WELCOME arrived) so the server already knows our protocol version.
   */
  join(shipClass: ShipClass): void {
    this.#send({
      v: PROTOCOL_VERSION,
      t: MessageType.JOIN,
      shipClass,
      client: { version: '0.0.0' },
    });
  }

  /** Send a movement/combat intent. Fire-and-forget; the server decides the outcome. */
  sendInput(seq: number, tick: number, input: InputFrame): void {
    this.#send({ v: PROTOCOL_VERSION, t: MessageType.INPUT, seq, tick, input });
  }

  /** Request a loot box. */
  sendPickup(boxId: string): void {
    this.#send({ v: PROTOCOL_VERSION, t: MessageType.PICKUP, boxId });
  }

  /* ------------------------------------------------------------------------ */
  /*  Internals                                                               */
  /* ------------------------------------------------------------------------ */

  #send(message: ClientMessage): void {
    const socket = this.#socket;
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(encode(message));
  }

  #handleFrame(data: unknown): void {
    if (!(data instanceof ArrayBuffer)) return;

    let message: ServerMessage;
    try {
      message = decode(new Uint8Array(data)) as ServerMessage;
    } catch {
      // A frame we cannot parse is a server bug or a version skew; ignore it rather
      // than tearing down a working connection.
      this.#listeners.onError?.(new Error('received an undecodable frame'));
      return;
    }

    if (!isServerMessage(message)) return;

    switch (message.t) {
      case MessageType.WELCOME: {
        this.welcome = message;
        this.#setState('joining');
        this.#listeners.onWelcome?.(message);
        return;
      }
      case MessageType.SNAPSHOT: {
        this.latestSnapshot = message;
        this.#listeners.onSnapshot?.(message);
        return;
      }
      case MessageType.PLAYER_STATE: {
        this.playerState = message;
        if (this.#state !== 'connected') this.#setState('connected');
        this.#listeners.onPlayerState?.(message);
        return;
      }
      case MessageType.EVENT: {
        this.#listeners.onEvent?.(message);
        return;
      }
      case MessageType.PING: {
        // Answer heartbeats so the server keeps us connected.
        this.#send({
          v: PROTOCOL_VERSION,
          t: MessageType.PONG,
          nonce: message.nonce,
          sentAt: message.sentAt,
          tick: this.latestSnapshot?.tick ?? 0,
        });
        return;
      }
      case MessageType.PONG: {
        return;
      }
      default: {
        /* Unknown but valid-looking message: ignore for forward compatibility. */
        return;
      }
    }
  }

  #setState(state: ConnectionState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#listeners.onStateChange?.(state);
  }
}

/** Runtime guard: only ids the client understands may reach a listener. */
function isServerMessage(message: ServerMessage): boolean {
  const known: MessageTypeId[] = [
    MessageType.WELCOME,
    MessageType.SNAPSHOT,
    MessageType.PLAYER_STATE,
    MessageType.EVENT,
    MessageType.PING,
    MessageType.PONG,
  ];
  return known.includes(message.t);
}

/** How often the client should send INPUT, exported for the game loop. */
export const INPUT_INTERVAL_MS = 1000 / CLIENT_INPUT_RATE;

export type { NetMessage };
