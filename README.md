# warship

A 2D browser naval game with an **authoritative server**.
This repository is a pnpm monorepo: shared contracts, the authoritative game server, and the PixiJS client.

- **Milestone 1 (done):** monorepo, shared contracts, WebSocket server, PixiJS client rendering a tiled ocean.
- **Milestone 2 (current):** an **authoritative simulation at 20 Hz**. Players join, steer with WASD, aim with the mouse, and every client renders the same world from full snapshots. `World` / `Player` / `Grid` / `Loop` on the server, `Connection` / `ClientWorld` / `Input` / `EntityRenderer` on the client.
- Still no NPCs, loot boxes, XP or persistence wiring — those arrive once the simulation loop is proven. Deliberately absent from the network layer: interpolation, prediction, delta compression, area-of-interest culling.

## Stack

| Layer      | Choice                                               |
| ---------- | ---------------------------------------------------- |
| Runtime    | Node.js 22 LTS                                       |
| Language   | TypeScript 5.9, `strict`, `noUncheckedIndexedAccess` |
| Monorepo   | pnpm workspaces                                      |
| Server     | uWebSockets.js v20.52.0                              |
| Protocol   | MessagePack (`@msgpack/msgpack`)                     |
| Database   | SQLite (`better-sqlite3`) + Drizzle ORM              |
| Client     | PixiJS v8 + Vite 8                                   |
| Simulation | 20 Hz authoritative server tick, full snapshots      |
| License    | AGPL-3.0-only                                        |

## Layout

```
.
├── packages/
│   ├── shared/          # @warship/shared — constants, protocol types, upgrades, formula signatures
│   ├── server/          # @warship/server — uWebSockets.js authoritative server
│   └── client/          # @warship/client — PixiJS v8 + Vite client
├── pnpm-workspace.yaml
├── tsconfig.base.json   # strict compiler options every package extends
└── eslint.config.mjs    # flat config, type-aware, Prettier-compatible
```

## Requirements

- Node.js **>= 22.12** (`better-sqlite3` v13 requires Node >= 22, Vite 8 requires >= 22.12)
- pnpm **>= 10** (`corepack enable && corepack prepare pnpm@10.34.9 --activate`)

## Getting started

```bash
pnpm install
pnpm dev            # shared (watch) + server (tsx watch) + client (vite) together
```

| URL                          | What                           |
| ---------------------------- | ------------------------------ |
| http://localhost:5173        | Client (Vite dev server)       |
| ws://localhost:8080/ws       | Game server WebSocket endpoint |
| http://localhost:8080/health | Server health probe (JSON)     |

The client proxies `/ws` and `/health` to the game server, so from application
code the socket URL is always same-origin: `new WebSocket(\`${location.origin.replace('http','ws')}/ws\`)`.

Useful single-package scripts:

```bash
pnpm dev:server        # shared build + server only
pnpm dev:client        # shared build + client only
```

## Scripts

| Script                 | Effect                                                            |
| ---------------------- | ----------------------------------------------------------------- |
| `pnpm dev`             | Run all three packages (shared in watch mode)                     |
| `pnpm build`           | Build `shared`, then `server` and `client`                        |
| `pnpm start`           | Run the compiled server (`packages/server/dist/index.js`)         |
| `pnpm lint`            | ESLint, type-aware, whole repo                                    |
| `pnpm lint:fix`        | ESLint with `--fix`                                               |
| `pnpm format`          | Prettier, whole repo                                              |
| `pnpm format:check`    | Prettier in check mode (CI)                                       |
| `pnpm typecheck`       | `tsc -b` for every package                                        |
| `pnpm assets:generate` | Regenerate the placeholder art in `packages/client/public/assets` |
| `pnpm clean`           | Remove every `dist/` and `*.tsbuildinfo`                          |

## Environment variables

All optional; the defaults just work.

| Variable              | Default               | Used by |
| --------------------- | --------------------- | ------- |
| `PORT`                | `8080`                | server  |
| `HOST`                | `0.0.0.0`             | server  |
| `SHARD_ID`            | `shard-0`             | server  |
| `MAX_PLAYERS`         | `100`                 | server  |
| `WARSHIP_DB_FILE`     | `data/warship.sqlite` | server  |
| `LOG_LEVEL`           | `debug` / `info`      | server  |
| `WARSHIP_SERVER_HOST` | `127.0.0.1`           | client  |
| `WARSHIP_SERVER_PORT` | `8080`                | client  |

## Protocol (v2)

Binary MessagePack frames, one message per WebSocket frame, on `/ws`, negotiated
with the `warship` subprotocol. Defined in
[`packages/shared/src/protocol.ts`](packages/shared/src/protocol.ts).

| `t` | Message        | Direction | Purpose                                                                   |
| --- | -------------- | --------- | ------------------------------------------------------------------------- |
| 101 | `JOIN`         | C → S     | requested ship class (`speed` / `normal` / `power`)                       |
| 102 | `INPUT`        | C → S     | `{ seq, tick, input: { turn, throttle, aim, firing } }`                   |
| 103 | `PICKUP`       | C → S     | box id (no boxes exist yet; the frame is parsed)                          |
| 104 | `UPGRADE`      | C → S     | upgrade id (no dock UI yet; the frame is parsed)                          |
| 201 | `WELCOME`      | S → C     | session, shard, tick, tick rate, world size                               |
| 202 | `SNAPSHOT`     | S → C     | `{ tick, entities: [{ id, x, y, rotation, hp, shipClass }] }`, every tick |
| 203 | `PLAYER_STATE` | S → C     | private state: hp, maxHp, level, xp, scrap, zone, upgrades                |
| 204 | `EVENT`        | S → C     | discrete facts: kill, levelup, pickup, damaged, join, leave               |
| 901 | `PING`         | both      | `{ nonce, sentAt }` liveness probe                                        |
| 902 | `PONG`         | both      | echoes `nonce` + `sentAt`                                                 |

Snapshots are **full, not delta**: every tick, every entity, to every client. That is
intentionally wasteful — correctness first, bandwidth once there is something worth
optimising (see `MILESTONE-2.md`).

The server sends a `Ping` every 5 s and closes the socket (code `4002`) when a
client has not answered within 15 s. Mismatched protocol versions are closed with
`4001`, frames before `JOIN` with `4003`, malformed frames with `1002`. Input is
rate-limited to **30 messages per second per connection**; the excess is dropped
and counted, never buffered.

### v1 → v2

| v1                  | v2                           | Change                                                       |
| ------------------- | ---------------------------- | ------------------------------------------------------------ |
| `1 Hello`           | `101 JOIN`                   | added `shipClass`; `client.version` kept                     |
| —                   | `102 INPUT`                  | new: movement + aim + fire intent, 20 Hz                     |
| —                   | `103 PICKUP` / `104 UPGRADE` | new: parsed and attributed, no gameplay yet                  |
| `10 Welcome`        | `201 WELCOME`                | added `tickRate`, `worldWidth`, `worldHeight`, `resumeToken` |
| —                   | `202 SNAPSHOT`               | new: the world, every tick                                   |
| —                   | `203 PLAYER_STATE`           | new: private state, 4×/s                                     |
| —                   | `204 EVENT`                  | new: kill / levelup / pickup / join / leave                  |
| `2 Ping` / `3 Pong` | `901 PING` / `902 PONG`      | ids moved into the reserved 9xx band                         |

`PROTOCOL_VERSION` is `2`; a v1 client is rejected at the handshake.

## Assets

`packages/client/public/assets` holds a seamless 256×256 water tile and three
top-down hull sprites. **They are generated placeholders**, produced by
`packages/client/scripts/generate-assets.mjs` (zero dependencies, deterministic
PNG output). Replace the files with any licensed tileable water texture and
top-down ship art of the same names; no code changes are required.

## Notes for the next milestones

- `packages/shared/src/formulas.ts` declares the movement / upgrade / combat
  formulas as `declare function` signatures. They are intentionally unimplemented:
  the numbers live in one place so client prediction and the authoritative
  simulation can never drift.
- The simulation clock (`packages/server/src/sim/clock.ts`) is fixed-step and
  drift-free; it is not started yet because there is nothing to simulate.
- `@warship/shared` must stay isomorphic — no `node:*`, no DOM.

## License

[AGPL-3.0-only](LICENSE).
