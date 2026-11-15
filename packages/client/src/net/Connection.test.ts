import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { CloseCode } from '@warship/shared';

/**
 * `Connection` reconnect-policy tests.
 *
 * These exist because of a real trap: when the browser reloads onto a new build while
 * an older server process is still running, the server closes every attempt with
 * `4001`. The client used to treat that as a transient failure and reconnect forever,
 * leaving the HUD flickering "reconnecting…" — indistinguishable from the game being
 * broken, and with the real cause invisible.
 *
 * The policy under test: transient closes retry, fatal closes stop and explain.
 */

/* -------------------------------------------------------------------------- */
/*  Minimal DOM shim (Connection only needs a WebSocket and a timer)           */
/* -------------------------------------------------------------------------- */

class FakeSocket {
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  static readonly CLOSED = 3;

  static instances: FakeSocket[] = [];

  readonly url: string;
  readonly protocols: readonly string[];
  readyState = FakeSocket.CONNECTING;
  binaryType = 'blob';

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  readonly sent: Uint8Array[] = [];

  constructor(url: string, protocols: readonly string[] = []) {
    this.url = url;
    this.protocols = protocols;
    FakeSocket.instances.push(this);
  }

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED;
  }

  /** Simulate the socket opening. */
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  /** Simulate the server closing the socket. */
  serverClose(code: number, reason = ''): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}

function installShim(): void {
  const globals = globalThis as unknown as {
    WebSocket: unknown;
    window: unknown;
  };

  // `Connection` reads `WebSocket.OPEN` and constructs with `new WebSocket(url, [...])`.
  globals.WebSocket = class extends FakeSocket {
    static override readonly OPEN = 1;
  };

  // Only `setTimeout`/`clearTimeout` are used, which Node already provides; `window`
  // is needed as their namespace.
  globals.window = {
    setTimeout: (handler: () => void, timeout?: number) => setTimeout(handler, timeout),
    clearTimeout: (handle: number) => {
      clearTimeout(handle);
    },
    location: { protocol: 'http:', host: 'localhost:5173' },
  };
}

const { Connection } = await import('./Connection.js');

describe('Connection close policy', { concurrency: 1 }, () => {
  beforeEach(() => {
    installShim();
    FakeSocket.instances = [];
  });

  test('a protocol mismatch stops retrying and explains itself', () => {
    const errors: string[] = [];
    const connection = new Connection({
      listeners: { onError: (error) => errors.push(error.message) },
      reconnectDelayMs: 1_000,
    });

    connection.connect();
    const socket = FakeSocket.instances[0];
    assert.ok(socket !== undefined, 'a socket should have been created');

    socket.open();
    socket.serverClose(CloseCode.VersionMismatch, 'protocol version mismatch');

    assert.equal(connection.state, 'disconnected', 'must not enter the reconnecting state');
    assert.ok(connection.fatalReason !== null, 'the reason must be recorded');
    assert.match(
      connection.fatalReason,
      /different protocol versions/,
      'the message must name the cause',
    );
    assert.match(
      connection.fatalReason,
      /pkill|restart/i,
      'the message must tell the player how to fix it',
    );

    // And it must not have scheduled another attempt.
    assert.equal(FakeSocket.instances.length, 1, 'no reconnect may be attempted');
  });

  test('a full server stops retrying', () => {
    const connection = new Connection({ reconnectDelayMs: 1_000 });
    connection.connect();
    const socket = FakeSocket.instances[0];
    assert.ok(socket !== undefined);

    socket.open();
    socket.serverClose(CloseCode.ServerFull, 'server full');

    assert.equal(connection.state, 'disconnected');
    assert.equal(connection.fatalReason, 'the server is full');
    assert.equal(FakeSocket.instances.length, 1);
  });

  test('a normal close still reconnects', () => {
    const connection = new Connection({ reconnectDelayMs: 5 });
    connection.connect();
    const first = FakeSocket.instances[0];
    assert.ok(first !== undefined);

    first.open();
    // 1001 = going away: a deploy or a server restart. Retrying is correct.
    first.serverClose(CloseCode.GoingAway, 'server shutting down');

    assert.equal(connection.state, 'reconnecting');
    assert.equal(connection.fatalReason, null, 'a transient close is not fatal');

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        assert.equal(FakeSocket.instances.length, 2, 'a second socket must have been created');
        resolve();
      }, 30);
    });
  });

  test('a deliberate disconnect does not retry', () => {
    const connection = new Connection({ reconnectDelayMs: 5 });
    connection.connect();
    const socket = FakeSocket.instances[0];
    assert.ok(socket !== undefined);

    socket.open();
    connection.disconnect();

    assert.equal(connection.state, 'disconnected');
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        assert.equal(FakeSocket.instances.length, 1, 'disconnect must not reconnect');
        resolve();
      }, 30);
    });
  });
});
