import { defineConfig } from 'vite';

/**
 * Vite config.
 *
 * The dev server is bound to 0.0.0.0 and accepts any host so the app works behind
 * a preview proxy / in a container, not just on localhost.
 *
 * `/ws` is proxied to the game server with `ws: true` so the client can always talk
 * to a same-origin URL (`ws://<origin>/ws`) — no CORS, no mixed content, and no
 * environment-specific URLs baked into the bundle.
 */
const GAME_SERVER_HOST = process.env.WARSHIP_SERVER_HOST ?? '127.0.0.1';
const GAME_SERVER_PORT = process.env.WARSHIP_SERVER_PORT ?? '8080';

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      '/ws': {
        target: `ws://${GAME_SERVER_HOST}:${GAME_SERVER_PORT}`,
        ws: true,
        changeOrigin: true,
      },
      '/health': {
        target: `http://${GAME_SERVER_HOST}:${GAME_SERVER_PORT}`,
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 750,
  },
});
