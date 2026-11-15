# Milestone 2 — authoritative simulation

Milestone 1 proved the plumbing: a client connects, the server answers, the socket
stays alive. Milestone 2 makes the server **the authority**. Two browsers open side by
side now see each other's ships in the same water, and neither of them decides where
anything is.

---

## 1. Verify in one command

```bash
pnpm install
pnpm dev
```

Then open **two** browser tabs at http://localhost:5173.

| Check                    | Expected                                                    |
| ------------------------ | ----------------------------------------------------------- |
| HUD status (top right)   | `online` with a green dot; then `shard-0 · 20 Hz`           |
| Hull bar (bottom left)   | fills to `140 / 140` for a `normal` ship                    |
| Debug panel → `entities` | `1` in one tab, `2` in both once the second joins           |
| Debug panel → `tick`     | climbing by ~20 per second                                  |
| Steering                 | `W`/`S` throttle, `A`/`D` turn; the ship moves in both tabs |
| Aiming                   | the mouse position sets the hull heading                    |
| Different classes        | `?ship=speed`, `?ship=normal`, `?ship=power`                |
| Closing a tab            | the ship disappears from the other tab within a second      |

Automated equivalent:

```bash
pnpm build && pnpm lint && pnpm typecheck && pnpm test
```

---

## 2. What was built

### Shared contracts (`@warship/shared`)

| File           | Contents                                                                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `constants.ts` | `SHIP_CLASSES` (3 classes with hp/speed/damage/turn rate/range/radius), `ZONES` (safe/mid/open rings), `GRID_SIZE` 2000 on an 8000×8000 map, `TICK_RATE` 20, `BOX_DROP_TABLE`, rate-limit and network limits |
| `protocol.ts`  | Protocol **v2**: C→S `JOIN`/`INPUT`/`PICKUP`/`UPGRADE`, S→C `WELCOME`/`SNAPSHOT`/`PLAYER_STATE`/`EVENT`, plus `PING`/`PONG` in the 9xx band                                                                  |
| `formulas.ts`  | `xpForLevel`, `levelFromXp`, `damageAfterArmor`, `upgradeCost`, `zoneMultiplier`, `computeHullStats`, `normalizeAngle`                                                                                       |
| `upgrades.ts`  | Five upgrade nodes with rank caps, cost curve and effect kinds                                                                                                                                               |

### Server (`@warship/server`)

| File             | Responsibility                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sim/clock.ts`   | Fixed 20 Hz tick with drift correction: schedules against an absolute deadline, not `setInterval`, and skips at most 5 catch-up ticks to avoid a death spiral |
| `game/Player.ts` | One ship: position, velocity, hull, `shipClass` from day one, last-accepted input sequence, `acceptInput()`                                                   |
| `game/Grid.ts`   | `SpatialGrid`, a uniform 2000-unit grid for neighbour queries. Present now, used by area-of-interest work later                                               |
| `game/World.ts`  | Owns the players, spawns them on a ring around the centre, integrates `position += velocity * dt`, builds snapshots                                           |
| `game/Loop.ts`   | The tick: drain each player's intent, apply it, broadcast a snapshot                                                                                          |
| `net/server.ts`  | uWS app: handshake, `JOIN`/`INPUT`/`PICKUP`/`UPGRADE`, 30 msg/s rate limit, 5 s heartbeat / 15 s timeout, `/health`                                           |

The tick loop is **fixed-step and authoritative**: input is an _intent_
(`turn`, `throttle`, `aim`, `firing`), never a position. The server clamps every
field, rejects replayed `seq` numbers, and integrates motion itself.

### Client (`@warship/client`)

| File                       | Responsibility                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `net/Connection.ts`        | Socket lifecycle (`idle → connecting → handshaking → joining → connected`), reconnect with backoff, `JOIN` on `WELCOME`, heartbeat replies |
| `net/Protocol.ts`          | Client-side mirror of the wire format: re-exports the shared types, adds `encodeClientMessage` / `decodeServerMessage`                     |
| `game/World.ts`            | `ClientWorld`: a snapshot-keyed view cache. Entities missing from a snapshot are dropped, so despawns need no extra message                |
| `game/Input.ts`            | WASD + arrows, pointer aim, click/space to fire; clears held keys on window blur                                                           |
| `game/Game.ts`             | PixiJS app, the frame loop, input→`INPUT` at exactly 20 Hz, camera follow                                                                  |
| `render/EntityRenderer.ts` | Pools one `Container` per entity id; draws ships, an in-world health bar when damaged, and a pulsing ring under the local ship             |
| `ui/GameHud.ts`            | Hull bar, level, class, entity count, tick, connection state, event log                                                                    |

---

## 3. How a frame travels

```
 tick (server, 20 Hz)
   ├─ for each player: apply the newest accepted intent
   │      rotation += turn * turnRate * dt
   │      velocity  = forward * throttle * speed · drag
   │      position += velocity * dt
   ├─ build SnapshotMessage { tick, entities: [ { id, x, y, rotation, hp, shipClass } ] }
   └─ send it to every connected client         ──────────────┐
                                                               │  MessagePack / WS
 browser                                                       ▼
   ├─ Connection.onmessage → decodeServerMessage
   ├─ ClientWorld.applySnapshot: upsert by id, delete the absent
   ├─ EntityRenderer: move/rotate pooled sprites
   ├─ Camera.follow(self)  (exponential smoothing, frame-rate independent)
   └─ HUD: hp bar, entity count, tick
```

Input travels the other way every 50 ms and is **never** applied directly to a
position. There is no interpolation and no prediction: the renderer draws exactly
what the last snapshot said. That is the deliberate scope of this milestone, and it
is why the camera, not the ships, does the smoothing.

---

## 4. Deviations from the brief — and why

1. **No interpolation, prediction, delta compression or AoI culling.** Not a
   shortcut: each one needs a stable baseline to measure against, and the baseline
   did not exist until this milestone. Full snapshots are the honest starting point.
2. **`PICKUP` and `UPGRADE` are parsed but inert.** The message shapes, rate limiting
   and attribution are all exercised end to end so that adding boxes and a dock later
   is a server-side change only. Both are logged at `debug`.
3. **The client sends input at a fixed 20 Hz from a frame accumulator**, not once per
   rendered frame. A 144 Hz monitor therefore does not send 144 inputs per second,
   and a 20 Hz floor still delivers exactly one intent per tick.
4. **`Grid` is built but not yet queried.** Snapshots go to everyone because there are
   at most 100 players in one shard; the grid exists so culling is a swap, not a
   rewrite.
5. **`maxHp` is sent in `PLAYER_STATE`**, even though the client could derive it from
   `SHIP_CLASSES[class].hp`. Sending it means a future upgrade that raises max hull
   does not require a client release.
6. **The `warship` WebSocket subprotocol is still required.** It gives a browser a
   clean failure mode (no subprotocol → no `onopen`) instead of a half-open socket.
7. **A stale test server can shadow the suite.** The e2e tests bind port `0` and ask
   the OS for a free port, then report it back through `listen()`; a hardcoded port
   meant a leftover process from a killed run would answer clients with no simulation
   attached, producing snapshots that were valid but empty.

---

## 5. Known limitations

- **A killed test process can leave a listening socket behind.** `pnpm dev` and the
  test suite are fine now (ephemeral ports), but if you kill a server with `SIGKILL`
  and immediately restart on the same port, the old socket may still answer for a few
  seconds.
- **No client-side prediction means input feels like 20 Hz** on a slow link. Expected
  at this stage; smoothing the local ship is the first prediction task.
- **Bandwidth grows linearly with player count** — every client receives every entity,
  every tick. At 100 players that is ~100 entities × 20 Hz ≈ 2 000 entity updates per
  second per client. Fine for a LAN demo; the first thing to fix after Milestone 3.
- **No auth or persistence.** A refresh creates a new player; nothing is stored.
- **The HUD cannot be visually verified in this environment** (no browser available),
  so the DOM/CSS side is covered by typechecking and by the build only.
