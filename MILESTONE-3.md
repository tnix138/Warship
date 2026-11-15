# Milestone 3 — smooth motion and scale

Milestone 2 proved the server is the authority. Milestone 3 makes that authority
_feel_ right and makes it affordable: ships glide instead of teleporting, your own
input is never late, and a client is only told about what it can actually see.

---

## 1. Verify

```bash
pnpm install
pnpm dev
```

Open http://localhost:5173. Then, instead of a screenshot, run the headless
inspector in a second terminal — it prints exactly what the client is receiving:

```bash
pnpm --filter @warship/server run state -- --seconds 4
# or, to watch it live once per second:
pnpm --filter @warship/server run state -- --watch --seconds 10
```

| Check                       | Expected                                                      |
| --------------------------- | ------------------------------------------------------------- |
| Debug panel → `buffer`      | `2`–`5` frames (the interpolation buffer)                     |
| Debug panel → `pending`     | `0`–`2` unacknowledged inputs while moving                    |
| Debug panel → `corrections` | `0` (or `0 (max 0.0u)`) while driving normally                |
| Ship motion                 | smooth, no per-tick hopping                                   |
| Two tabs, far apart         | each sees only itself (`entities 1`)                          |
| Two tabs, close together    | each sees both (`entities 2`)                                 |
| `state` script              | reports `full` vs `delta` counts, bandwidth, `avg delta size` |

---

## 2. What was built

### Client-side interpolation — `packages/client/src/net/Interpolation.ts`

The server ticks at 20 Hz, the screen refreshes at 60–144 Hz. Drawing the newest
snapshot directly makes ships jump 12 units at a time. The fix is to **render in the
past**: hold a short buffer and draw the world as it was `INTERPOLATION_DELAY_MS`
(100 ms = two ticks) ago, blending between the two snapshots that straddle that
moment.

```
server time ─────────────────────────────────────▶
              s1        s2        s3        s4
                       ▲         ▲
                       │ render  │
                 now - 100ms     │
                           (bracketed by s2 and s3)
```

- **Rotation** blends with `angleDelta`, so a ship turning through ±π takes the short
  arc. Linear blending would spin it almost a full turn the wrong way.
- **Timestamps are local receive times**, not server clocks, so a client whose clock
  is minutes off still interpolates correctly.
- **Departed entities fade** over 180 ms rather than popping.
- The buffer is capped at 32 frames so a long session cannot grow without bound.

### Client-side prediction — `packages/client/src/game/Prediction.ts`

Without prediction, your ship only moves when a snapshot arrives, so every keypress
feels one round-trip late. Prediction applies your own input immediately using
`stepMotion` — **the same function the server runs**, imported from
`@warship/shared`, so the two can never drift apart.

Reconciliation follows the standard sequence:

```
pending = [i1, i2, i3, i4]      // sent, not yet acknowledged
on snapshot:
   drop every input with seq <= ackSeq     // ackSeq rides on your own entity
   position = server position              // trust the authority
   replay the remaining inputs             // keep motion smooth
```

Beyond `snapThreshold` (64 units) the ship **snaps** instead of easing — a large
correction eased over several frames looks like a rubber band; snapped, it is
invisible. Scope is deliberately **movement and rotation only**: combat outcomes are
server facts that prediction must never invent.

### Server-side Area of Interest — `packages/server/src/game/AoI.ts`

A player is only told about entities within `AOI_INTEREST_RADIUS` (3000 units).

Two details are where the bugs live:

1. **Radius, not neighbourhood.** 3000 / 2000 = 1.5 cells, so a ship near a cell
   corner reaches _two_ cells out. The code walks `gridCellsInRadius`, not a 3×3
   block. On the 4×4 world grid a 3000 radius actually touches **all 16 cells** —
   which is exactly why culling must be done by real distance, not by cell
   membership.
2. **Visibility is a set difference.** The client only learns an entity vanished if
   it is told. Each player carries the set of ids they were told about last tick;
   anything that leaves it becomes an explicit `removed` entry.

Distance is **toroidal**: the world wraps, so (10, 4000) and (7990, 4000) are 20
units apart, not 7980.

### Delta compression — `packages/server/src/game/Loop.ts`

`SNAPSHOT` now carries `full: boolean`:

- **`full`** — the first frame of a session, and one **keyframe per second**
  (`SNAPSHOT_KEYFRAME_INTERVAL_TICKS = TICK_RATE`) so any desync is bounded to ≤1 s.
- **`delta`** — only entities whose position/rotation/hp changed, plus `removed`.
  A ship that merely moved omits `shipClass`.
- **No frame at all** when nothing changed: a stationary ship in empty water costs
  zero bytes.

Keyframes are cheap insurance. TCP guarantees ordering today, but the moment a
transport without that guarantee is added, delta-only would be unrecoverable.

---

## 3. Measured results

### Bandwidth — 20 players, 2 seconds at 20 Hz

Half the population moving, spread across the map (a realistic scene, not the
worst case of everyone sprinting).

|                                                | Total bytes | Per client        |
| ---------------------------------------------- | ----------- | ----------------- |
| Before (full snapshot to everyone, every tick) | 1 550 400   | 6056 kbit/s       |
| After (AoI + delta + 1 Hz keyframes)           | 472 580     | 1846 kbit/s       |
| **Reduction**                                  | **69.5%**   | **3.28× smaller** |

Average delta frame: **503 bytes**.

### One frame, 10 entities in view, 4 moving

|                                                | Bytes     |
| ---------------------------------------------- | --------- |
| Before (full, 10 records, `shipClass` on each) | 1 020     |
| After (delta, 4 records, no `shipClass`)       | 396       |
| **Reduction**                                  | **61.2%** |

### AoI — 20 simulated players

A viewer sees **11 of 20** entities: itself plus the 10 nearby, and none of the 9
outside the radius. The test asserts both directions (none leak in, and the count is
strictly less than the population).

---

## 4. Tests added

| Suite                                           | Count | Covers                                                                                                                                                   |
| ----------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client/src/net/Interpolation.test.ts`          | 10    | two-snapshot blending, ±π rotation seam, delta carry-forward, removal fade, bounded buffer, monotonic jitter-free motion                                 |
| `server/src/game/AoI.test.ts`                   | 15    | cell maths, 5×5 coverage for a 3000 radius, torus seam, circle-not-square, boundary inclusion, removal reported once, 20-player culling, stable ordering |
| `server/src/net/server.test.ts` (new describes) | 3     | two clients apart see nothing of each other, two close clients see each other, a departing ship is removed                                               |

Total: **115 tests** (61 shared + 21 client + 33 server) after the input fixes.

---

## 5. Deviations and decisions

1. **Protocol bumped v2 → v3.** The snapshot shape changed in a way that fails
   _silently_ — a v2 client would read a delta as a full frame and delete every
   entity it did not mention. Bumping the version means old clients are refused at
   the handshake (`4001`) instead of corrupting their view.
2. **Tests had to change to match deltas.** Any test that read one frame and
   concluded "this entity is gone" was wrong under delta compression. The suite now
   reconstructs state exactly like the real client (`materialise()`), which is a
   better test than what it replaced.
3. **`HullStats`/`computeHullStats` renamed** to `ShipStats`/`computeShipStats` for
   consistency with `ShipClass`. No `HullClass` or `HULLS` reference remains.
4. **Rate limit 30 → 40 msg/s**, **max inbound payload 8 KiB → 16 KiB**.
   `NETWORK_MAX_PAYLOAD_BYTES` is uWS's `maxPayloadLength`, which limits **inbound
   frames only** — outbound is not capped by it. The headroom is for a future
   inbound world-state frame (reconnect upload), not for this milestone.
5. **The AoI test initially failed for a geometry reason, not a code reason.** The
   first attempt placed players at (1000,1000) and (7000,7000) expecting them to be
   far apart. On a torus those points are **2828 units apart** — inside the radius.
   The maximum distance on an 8000×8000 torus is only 5657, so the test now uses true
   antipodes (2000,2000) vs (6000,6000).
6. **`AOI_INTEREST_RADIUS` (3000) is larger than `GRID_SIZE` (2000).** This is fine
   and intentional — it means the weapon range (max 1100) is always inside the view
   radius, so a ship you can shoot is a ship you can see.

---

## 6. Input fixes (post-release regression report)

A tester running the game in Codespaces reported: multiplayer, rendering, HUD,
snapshots, delta and interpolation all worked — but **WASD did nothing, the ship was
completely still**, and mouse aim and wheel zoom appeared dead too.

Three separate defects, all on the client, all invisible to the server-side tests:

### 6.1 WASD dead on non-QWERTY keyboards (`Input.ts`)

Keys were read from `event.key`, which reports **the character the key produces**:

| Layout         | Physical W key reports | Result                       |
| -------------- | ---------------------- | ---------------------------- |
| QWERTY (US/UK) | `"w"`                  | worked                       |
| AZERTY (FR/BE) | `"z"`                  | **dead**                     |
| QWERTZ (DE)    | `"w"`                  | worked (but `y`/`z` swapped) |
| Dvorak         | `","`                  | **dead**                     |

`event.key` also returns `"W"` when Shift is held, which `.toLowerCase()` papered
over — but the layout problem could not be fixed that way. The controller now reads
**`event.code`** (`"KeyW"`), which identifies the _physical_ key and is layout
independent, keeping `event.key` only as a fallback for synthetic events with no
`code`.

`Input.test.ts` reproduces this exactly: dispatching a key event with
`{ key: 'z', code: 'KeyW' }` must still throttle forward. That test failed before
the fix and passes after.

### 6.2 Wheel zoom and mouse aim were never connected (`Game.ts`, `camera.ts`)

`Camera.attachInput()` existed but **was never called** — so neither drag-to-pan nor
wheel-zoom was wired. Worse, drag-to-pan is wrong for this game: the camera _follows
the ship_, so every drag is undone on the next tick and reads as "the mouse is
broken". Added `Camera.attachZoom()` (wheel only, `{ passive: false }` so
`preventDefault` actually stops the page/iframe scrolling) and wired it in `Game.ts`
with proper teardown.

### 6.3 `aim` was sent but never applied (`Loop.ts`)

The client sent a world-space aim angle every input; the server parsed, clamped and
stored it — then **never used it**. Mouse aiming could not have worked. It is now
authoritative: the hull turns toward the aim angle, limited to
`turnRate × AIM_ASSIST_FACTOR (2.5) × dt` per tick so a cursor flick cannot pivot a
battleship instantly. `aim: null` still leaves the heading to `turn`, so WASD
steering is unaffected.

Verified live: holding W with `aim = -π/2` reaches rotation `-1.571` (error 0.000)
and moves the ship 346 units.

### 6.4 Making it diagnosable next time

- HUD debug panel gained **`input`** (the intent currently being sent: `thr +1`,
  `turn -1`, `fire`) and **`sent`** (INPUT frames sent). `sent` climbing with
  `input –` while pressing W means the listener never fired; `input` showing values
  means the client is fine and the fault is server-side.
- `?debug=keys` in the URL (or `localStorage.warshipDebugKeys = '1'`) logs every
  resolved key to the console.
- The canvas is now focusable (`tabIndex`) and takes focus on pointer down.

### 6.5 Test coverage that would have caught all three

| Test                                                    | Guards against                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------- |
| `client/src/game/Input.test.ts` — 11 tests              | keys never firing, wrong mapping, layout dependence, blur, focus stealing |
| `server/.../server.test.ts` — _aim turns the hull_      | aim parsed but ignored                                                    |
| `server/.../server.test.ts` — _aim: null uses keyboard_ | aim override breaking WASD                                                |

The aim test was verified to **fail** with the fix reverted, so it is a real
regression test rather than a test written to match the code.

---

## 7. Known limitations

- **No HTTP-level compression.** MessagePack is already compact; gzip on a 300-byte
  delta frame mostly adds CPU.
- **AoI uses the player's centre point**, so a ship is either fully in or fully out.
  With 30-unit radii against a 3000-unit view this never matters in practice.
- **Prediction does not predict firing**, by design.
- **The interpolation delay is fixed at 100 ms.** An adaptive delay based on measured
  jitter would be better over poor links.
- **Client visuals still cannot be verified in this environment** — no browser. The
  `state` script is the substitute; the user confirms visually with `pnpm dev`.
- **`pnpm --filter @warship/server run state` requires a running server.** It prints
  a clear error and exits non-zero if none is reachable.
