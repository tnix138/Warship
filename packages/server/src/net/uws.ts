/**
 * Loader for `uWebSockets.js`.
 *
 * uWebSockets.js is not published to npm with binaries; it is consumed straight
 * from its Git repository, which ships `uws.js` (a CommonJS entry) plus one
 * prebuilt `.node` binary per platform / ABI. Because it is CommonJS it is loaded
 * through `createRequire`, which works identically under `tsx` (dev) and plain
 * `node` (prod).
 *
 * Types come from the package's own `index.d.ts`, so there is exactly one
 * definition of the uWS surface and no drift.
 */

import { createRequire } from 'node:module';

import type { TemplatedApp } from 'uWebSockets.js';

export type {
  HttpRequest,
  HttpResponse,
  TemplatedApp,
  us_listen_socket,
  WebSocket as UwsWebSocket,
} from 'uWebSockets.js';

/** The module object exported by `uWebSockets.js`'s CommonJS build. */
export interface UwsModule {
  App(): TemplatedApp;
  DISABLED: number;
  SHARED_COMPRESSOR: number;
  /** Actual bound port of a listen socket — needed when binding to port 0. */
  us_socket_local_port?(listenSocket: unknown): number;
}

const require = createRequire(import.meta.url);

let cached: UwsModule | null = null;

/** Resolve `uWebSockets.js` once and reuse the module instance. */
export function loadUws(): UwsModule {
  if (cached !== null) return cached;

  try {
    const loaded = require('uWebSockets.js') as UwsModule;
    if (typeof loaded.App !== 'function') {
      throw new Error('module did not export App()');
    }
    cached = loaded;
    return cached;
  } catch (error) {
    throw new Error(
      'Failed to load uWebSockets.js. It is installed from GitHub (v20.52.0) because it is ' +
        'not published to npm with binaries. The bundled binaries require Node.js 20/22/24 ' +
        'and glibc >= 2.35 — run `pnpm install` again if node_modules is missing or incomplete.',
      { cause: error },
    );
  }
}
