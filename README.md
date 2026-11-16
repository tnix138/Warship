# warship

A 2D browser naval game with an **authoritative server**.
This repository is a pnpm monorepo: shared contracts, the authoritative game server, and the PixiJS client.

- **Milestone 1 (done):** monorepo, shared contracts, WebSocket server, PixiJS client rendering a tiled ocean.
- **Milestone 3 (current):** smooth motion and scale. Client-side **interpolation** (render 100 ms in the past), client-side **prediction** with server reconciliation, server-side **Area of Interest** culling on a spatial grid, and **delta compression** with 1 Hz keyframes. Snapshot traffic drops ~70% at 20 players.
- **Milestone 2:** an **authoritative simulation at 20 Hz**. Players join, steer with WASD, and every client renders the same world from full snapshots. Targeting and firing are decided by the server; the client only sends steering and a target selection. `World` / `Player` / `Grid` / `Loop` on the server, `Connection` / `ClientWorld` / `Input` / `EntityRenderer` on the client.
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

## Controls

| Input             | Action                                                         |
| ----------------- | -------------------------------------------------------------- |
| `W` / `S`         | ahead / astern                                                 |
| `A` / `D`         | turn                                                           |
| Click an enemy    | manual target (red ring); the guns then track it automatically |
| Click empty water | drop the manual target and return to automatic targeting       |
| Mouse wheel       | zoom                                                           |

Firing is **automatic** and entirely server-side. The client sends steering and, on a
click, one entity id; the server re-checks range and liveness every tick and decides
what gets shot. There is no aim control and no trigger, so there is nothing for a
client to lie about.

## Scripts

| Script                 | Effect                                                            |
| ---------------------- | ----------------------------------------------------------------- |
| `pnpm dev`             | Run all three packages (shared in watch mode)                     |
| `pnpm kill`            | Stop every dev process (`tsx watch`, `vite`, `concurrently`)      |
| `pnpm restart`         | `pnpm kill` then `pnpm dev` — the fix for a stale server          |
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

## Protocol (v3)

Binary MessagePack frames, one message per WebSocket frame, on `/ws`, negotiated
with the `warship` subprotocol. Defined in
[`packages/shared/src/protocol.ts`](packages/shared/src/protocol.ts).

| `t` | Message        | Direction | Purpose                                                                   |
| --- | -------------- | --------- | ------------------------------------------------------------------------- |
| 101 | `JOIN`         | C → S     | requested ship class (`speed` / `normal` / `power`)                       |
| 102 | `INPUT`        | C → S     | `{ seq, tick, input: { turn, throttle } }`                                |
| 103 | `PICKUP`       | C → S     | box id (no boxes exist yet; the frame is parsed)                          |
| 104 | `UPGRADE`      | C → S     | upgrade id (no dock UI yet; the frame is parsed)                          |
| 105 | `TARGET`       | C → S     | `{ entityId: string \| null }` — manual lock, `null` returns to auto-aim  |
| 201 | `WELCOME`      | S → C     | session, shard, tick, tick rate, world size                               |
| 202 | `SNAPSHOT`     | S → C     | `{ tick, entities: [{ id, x, y, rotation, hp, shipClass }] }`, every tick |
| 203 | `PLAYER_STATE` | S → C     | private state: hp, maxHp, level, xp, scrap, zone, upgrades                |
| 204 | `EVENT`        | S → C     | discrete facts: kill, levelup, pickup, damaged, join, leave               |
| 901 | `PING`         | both      | `{ nonce, sentAt }` liveness probe                                        |
| 902 | `PONG`         | both      | echoes `nonce` + `sentAt`                                                 |

`SNAPSHOT` carries a `full: boolean` flag. The first frame of a session, and one frame
per second thereafter, are `full` (authoritative reset). Everything in between is a
**delta**: only entities whose position, rotation or HP changed, plus a `removed`
list for anything that left the client's Area of Interest. A stationary ship in
empty water costs zero bytes — the server skips the frame entirely.

Entities are culled by **Area of Interest** (radius 3000 units). Your own ship also
carries `ackSeq`, the newest input the server applied, which is what client-side
prediction uses to reconcile.

The server sends a `Ping` every 5 s and closes the socket (code `4002`) when a
client has not answered within 15 s. Mismatched protocol versions are closed with
`4001`, frames before `JOIN` with `4003`, malformed frames with `1002`. Input is
rate-limited to **30 messages per second per connection**; the excess is dropped
and counted, never buffered.

### v1 → v2

| v1                  | v2                           | Change                                                       |
| ------------------- | ---------------------------- | ------------------------------------------------------------ |
| `1 Hello`           | `101 JOIN`                   | added `shipClass`; `client.version` kept                     |
| —                   | `102 INPUT`                  | new: steering intent, 20 Hz                                  |
| —                   | `103 PICKUP` / `104 UPGRADE` | new: parsed and attributed, no gameplay yet                  |
| `10 Welcome`        | `201 WELCOME`                | added `tickRate`, `worldWidth`, `worldHeight`, `resumeToken` |
| —                   | `202 SNAPSHOT`               | new: the world, every tick                                   |
| —                   | `203 PLAYER_STATE`           | new: private state, 4×/s                                     |
| —                   | `204 EVENT`                  | new: kill / levelup / pickup / join / leave                  |
| `2 Ping` / `3 Pong` | `901 PING` / `902 PONG`      | ids moved into the reserved 9xx band                         |

`PROTOCOL_VERSION` is `2`; a v1 client is rejected at the handshake.

## Assets

`packages/client/public/assets` holds the water tile, one hull sprite per player
class, one shared NPC hull, and two particle families (explosions and fire).

**Ship and NPC sprites are the Kenney _Pirate Pack_ (CC0).** The NPC hull is shared
by every tier on purpose: the tier is conveyed by **scale** (Coastal 0.7×, Raider
1.0×, Warship 1.5×) and by a **threat ring** drawn under the hull (green / yellow /
red), plus an always-visible health bar. One sprite plus those three cues is easier
to read than three near-identical hulls at distance.

The water tile was originally a generated placeholder
(`packages/client/scripts/generate-assets.mjs`, zero dependencies, deterministic PNG
output); the three original hull files are still present but unused.

Sprite orientation is easy to get backwards: the art faces **south** (bow at the
bottom of the image), so the renderer applies `-π/2` to line the art up with world
rotation 0 = +x.

## Testing

See [`docs/HOW-TO-TEST.md`](docs/HOW-TO-TEST.md) for the manual checklist, the
symptom→cause table, and the reset that fixes a stale server after a `git pull`.

## Notes for the next milestones

- `packages/shared/src/formulas.ts` declares the movement / upgrade / combat
  formulas as `declare function` signatures. They are intentionally unimplemented:
  the numbers live in one place so client prediction and the authoritative
  simulation can never drift.
- The simulation clock (`packages/server/src/sim/clock.ts`) is fixed-step and
  drift-free; it is not started yet because there is nothing to simulate.
- `@warship/shared` must stay isomorphic — no `node:*`, no DOM.

## Credits

- Ship sprites from Kenney.nl (Pirate Pack), CC0.
- Water tile and particle sprites generated in-repo (see `## Assets`).

## License

[AGPL-3.0-only](LICENSE).
