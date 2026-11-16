# Milestone 1 — walkthrough

> **Historical record.** This document describes Milestone 1 exactly as delivered,
> including protocol **v1** (`Hello`/`Welcome`/`Ping`/`Pong`). The protocol has since
> moved to **v2**: see [`README.md`](README.md) for the current message table and
> [`MILESTONE-2.md`](MILESTONE-2.md) for what changed and why.

Everything in this milestone runs. This file documents _what_ was built, _how to
verify it_, and every deviation from the brief with its reason.

---

## 1. Verify in one command

```bash
pnpm install
pnpm dev
```

| Check                        | Expected                                                    |
| ---------------------------- | ----------------------------------------------------------- |
| http://localhost:5173        | Tiled ocean, one destroyer sailing an arc, HUD, debug panel |
| `curl localhost:8080/health` | `{"ok":true,"shard":"shard-0","tick":0,"connections":0}`    |
| `pnpm test`                  | 4 passing network tests                                     |

Quality gates, all green on a clean checkout:

```bash
pnpm build && pnpm lint && pnpm typecheck && pnpm format:check && pnpm test
```

---

## 2. What was built

### `@warship/shared` — contracts only, no logic

| File           | Contents                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------- |
| `constants.ts` | Tick rate, world size, network timeouts, render tuning, DB defaults, shard id                  |
| `protocol.ts`  | `MessageType` ids, `Hello`/`Ping`/`Pong`/`Welcome` envelopes, `CloseCode`, `ConnectionState`   |
| `upgrades.ts`  | `HullClass`, `HULLS`, `UpgradeId`, `UPGRADES` (8-node tech tree), `UPGRADE_ORDER`              |
| `formulas.ts`  | `declare function` signatures for movement, stats, combat, timing, progression — **no bodies** |

Per the brief, nothing in `shared` computes anything. `formulas.ts` is the
contract the server simulation and the client prediction will both import, so the
numbers can only ever live in one place.

### `@warship/server` — authoritative server, socket layer only

| File                 | Role                                                                   |
| -------------------- | ---------------------------------------------------------------------- |
| `index.ts`           | Boot: config → logger → clock → server, plus graceful SIGINT/SIGTERM   |
| `config.ts`          | Env parsing with defaults and range validation                         |
| `logger.ts`          | Zero-dep JSON-lines logger (pretty in dev), pino-shaped API            |
| `sim/clock.ts`       | Fixed-step, drift-free tick scheduler with catch-up clamping           |
| `net/server.ts`      | uWS app: upgrade, Welcome, heartbeats, protocol guards, `/health`      |
| `net/codec.ts`       | MessagePack encode/decode + defensive validation at the trust boundary |
| `net/connection.ts`  | Per-socket bookkeeping (liveness, RTT)                                 |
| `net/uws.ts`         | Single `createRequire` loader for the GitHub-only `uWebSockets.js`     |
| `net/server.test.ts` | 4 e2e tests over a real socket                                         |

### `@warship/client` — PixiJS v8 + Vite, no networking yet

| File                          | Role                                                                    |
| ----------------------------- | ----------------------------------------------------------------------- |
| `main.ts`                     | Boot, HMR teardown, boot-error overlay                                  |
| `game.ts`                     | Scene graph, frame loop, demo ship animation (cosmetic, clearly marked) |
| `render/ocean.ts`             | Two-layer `TilingSprite` parallax ocean + procedural vignette           |
| `render/ship.ts`              | Hull sprite, bow marker, procedural wake                                |
| `render/camera.ts`            | Drag-pan, cursor-anchored zoom, clamp to world                          |
| `render/assets.ts`            | Typed asset manifest, single-flight texture loading                     |
| `ui/hud.ts`                   | DOM HUD, throttled to 4 Hz                                              |
| `scripts/generate-assets.mjs` | Dependency-free PNG generator for the placeholder art                   |

---

## 3. Deviations from the brief — and why

### a) `uWebSockets.js` is pinned to `v20.52.0`, not latest

`uWebSockets.js` is **not published to npm** (the `uws` package is only a pointer
README). It is installed from GitHub, and each release ships prebuilt binaries
compiled against a specific glibc. Measured in this sandbox (Debian 12, glibc 2.36):

| Version   | Max GLIBC required | Loads here |
| --------- | ------------------ | ---------- |
| v20.71.0  | 2.38               | ❌         |
| v20.53.0+ | 2.38               | ❌         |
| v20.52.0  | **2.35**           | ✅         |
| v20.44.0  | 2.27               | ✅         |

`v20.52.0` is the newest release that runs unmodified. It still supports Node
20/22/24 and has the complete v20 API used here (`ws`, `upgrade`, `publish`,
`subscribe`, heartbeats). **Bumping it requires checking the target host's glibc.**

### b) Art is generated, not downloaded from kenney.nl

The sandbox has no outbound access to `kenney.nl`. Per the brief's fallback, the
assets are coloured placeholders — but generated _procedurally_ rather than
committed as opaque blobs:

- `water-tile.png` — 256² seamless ocean tile. Every sine term uses a whole
  number of periods per tile and the noise lattice wraps modulo its own size, so
  the tile is genuinely seamless (no seam lines when repeated).
- `ship-{scout,destroyer,battleship}.png` — top-down hull sprites with tapered
  bows, deck stripe and turret rings.

Run `pnpm assets:generate` to regenerate. Because the manifest in
`render/assets.ts` refers to files by name, dropping in licensed kenney.nl art of
the same names needs **zero code changes**.

### c) `formulas.ts` has no implementations

The brief said "types and constants only, no logic" — so every formula is a
`declare function` signature. They compile, they are importable, and implementing
one is a one-line change in exactly one file. Nothing silently returns `0`.

### d) `better-sqlite3` build scripts are intentionally not run

`better-sqlite3@13` ships N-API prebuilds for every tier-1 platform. Its
`node-gyp` build script would fail on machines without Node headers, and it is not
needed. `pnpm-workspace.yaml` therefore lists it under `ignoredBuiltDependencies`
(and `esbuild` under `onlyBuiltDependencies`). The prebuilt binary loads fine —
verified.

### e) Drizzle is installed but has no schema yet

`drizzle-orm`, `better-sqlite3` and `@types/better-sqlite3` are wired into the
server's dependencies so the stack is fixed from day one, but no tables exist yet:
schema design belongs with the gameplay milestone that needs it. The DB file path
is already a config value (`WARSHIP_DB_FILE`, default `data/warship.sqlite`, and
`data/` is gitignored).

### f) Added beyond the brief (small, justified)

- **`/health` endpoint** — one curl proves the server is alive without a WS client.
- **`Ping`/`Pong` in both directions** — the brief asked for the server to send
  `PING`; the same frame type now flows both ways so the client can measure RTT.
  Server-side heartbeats (5 s interval, 15 s timeout, close code `4002`) mean an
  idle player is still detected.
- **`Welcome` frame** — the socket is useful immediately and gives the client its
  session id, shard, tick and tick rate.
- **Protocol guards** — version mismatch closes with `4001`, malformed frames with
  `1002`. Both covered by tests.
- **4 network tests** via `node:test` (`pnpm test`) — no test framework dependency.
- **`/ws` and `/health` dev proxy** in Vite — the client can always use a
  same-origin URL, so there is no CORS or mixed-content class of bug later.
- **`SERVER_DEFAULTS`**, `SHARD_ID`, structured logging — multi-shard readiness,
  as requested, without implementing sharding.

---

## 4. Design decisions worth reviewing

**Fixed-step clock, drift-free.** `SimulationClock` schedules against an absolute
deadline rather than accumulating `setTimeout(50)`, and clamps catch-up to 5 ticks
so a stalled event loop cannot spiral. It is not started yet — there is nothing to
simulate — but every future system will hang off its tick counter.

**The protocol is append-only.** `MessageType` ids are numeric (a string type name
would be re-sent 20×/s per player) and must never be reused once removed. This is
documented at the declaration so a future contributor does not break old clients.

**`shared` is isomorphic by construction.** It has one dev dependency
(`typescript`) and zero runtime dependencies. That property is the reason the
client can import protocol types without dragging in server code.

**The client's demo motion is quarantined.** `animateDemoShip()` in `game.ts` is
the only fake simulation, is marked as cosmetic, and is called from exactly one
place — replacing it with snapshot interpolation will not touch the renderer.

---

## 5. Known limitations of this milestone

- **No gameplay:** no input, no ships on the wire, no snapshots. `game.ts` renders
  a hardcoded demo ship.
- **The client does not open a socket yet.** The contract and the dev proxy are
  ready; `ConnectionState` and the `Ping`/`Pong` types exist for that step.
- **`MAX_PAYLOAD` is 1 KiB.** Fine for `Hello`/`Ping`, will need raising for input
  batches.
- **No rate limiting or auth.** A client can send `Ping` at any rate; the payload
  cap and the heartbeat are the only guards today.
- **No CI config.** Gates are scripted and pass; wiring them into a workflow is a
  separate task.
- **`data/` is gitignored** so the future SQLite file never lands in Git.
