# How to test

A checklist for verifying a build by hand, plus the fixes for the situations that
make a working build _look_ broken.

---

## 1. Start it

```bash
git pull
pnpm install          # only needed when dependencies changed
pnpm dev
```

Open <http://localhost:5173>. Two tabs give you multiplayer.

---

## 2. What to check

| #   | Check                    | Expected                                                | If it fails |
| --- | ------------------------ | ------------------------------------------------------- | ----------- |
| 1   | Status (top right)       | green dot, `online`, then `shard-0 · 20 Hz`             | §3          |
| 2   | Hull bar (bottom left)   | fills to `140 / 140` for `normal`                       | §3          |
| 3   | **WASD**                 | `W`/`S` throttle, `A`/`D` turn                          | §4.1        |
| 4   | **Mouse aim**            | ship turns toward the cursor                            | §4.2        |
| 5   | **Wheel**                | zooms in/out around the cursor                          | §4.3        |
| 6   | Debug → `entities`       | `1` alone, `2` with a second tab nearby                 | §4.4        |
| 7   | Debug → `tick`           | climbs ~20 per second                                   | §3          |
| 8   | Debug → `interp buffer`  | `3 frames (100ms)`                                      | §4.6        |
| 9   | Debug → `sent`           | climbs while you hold a key                             | §4.1        |
| 10  | Debug → `input`          | `thr +1` / `turn -1` while holding keys                 | §4.1        |
| 11  | **AoI**                  | sail away from the other tab; `entities` drops `2 → 1`  | §4.4        |
| 12  | **Interpolation**        | the _other_ ship glides, no per-tick hopping            | §4.6        |
| 13  | **Prediction**           | _your_ ship reacts on the frame you press the key       | §4.5        |
| 14  | Debug → `prediction err` | under `1 unit`; a spike after a network hiccup is fine  | §4.8        |
| 15  | Debug → `corrections`    | `0 (last 60s)` while driving normally                   | §4.8        |
| 16  | **Buoys**                | amber/orange/white marks slide past you as you move     | §4.7        |
| 17  | **Wake**                 | a short foam trail behind your own ship                 | §4.7        |
| 18  | **Own-ship motion**      | your ship glides; it does not stutter at 20 Hz          | §4.5        |
| 19  | Debug → `offset x`       | small, and returns to `0` within ~150 ms                | §4.9        |
| 20  | Debug → `ease τ`         | `80 ms` normally; `150 ms` right after a big correction | §4.9        |

Ship classes: `?ship=speed`, `?ship=normal`, `?ship=power`.
Key-logging: `?debug=keys` (or `localStorage.warshipDebugKeys = '1'`).

---

## 3. If the game broke after `git pull`

**This is the most common failure, and it is almost never a code bug.**

`pnpm dev` runs three processes: a TypeScript watcher for `@warship/shared`, the game
server, and Vite. Two things can leave you with a _stale server_:

- **HMR reloads the browser but not the server.** If the protocol changed, the new
  page speaks v3 while the old server speaks v2.
- **A killed process keeps its port.** A leftover `tsx watch` from a previous run
  still answers on `8080`, so the new one cannot bind and the old one serves stale
  code. This was the cause of a 30-minute debugging session once — the tests were
  "flaky" because a zombie server was answering them.

### The reset that fixes both

```bash
# kill all node processes
pnpm kill      # = pkill -f "tsx watch"; pkill -f "vite"; pkill -f "concurrently"
sleep 1
pnpm dev
```

Or in one step: `pnpm restart`. The raw commands, if you want them:

```bash
pkill -f "tsx watch"
pkill -f "vite"
pkill -f "concurrently"

# verify the ports are actually free (no output = free)
ss -tlnp | grep -E ":8080|:5173"
```

On macOS the equivalent of `ss` is `lsof -i :8080 -i :5173`.

### How you can _tell_ it is a stale server

Since Milestone 3 the client detects this and says so instead of looping silently:

- The status turns into **`error — see console`** with a red dot.
- An event line appears, and the console logs:

  ```
  server and client speak different protocol versions — the server is running
  older code than the page. Restart it: pkill -f "tsx watch"; pnpm dev
  ```

- In the browser console, the socket closes with code **`4001`**.
- In the server terminal:

  ```
  WARN protocol version mismatch {"client":2,"server":3}
  ```

Any of those means: **restart the server.** Nothing is wrong with your build.

Before this check existed the client retried forever and the HUD just flickered
`reconnecting…`, which looks identical to a broken game.

### When does the server actually need a restart?

Measured on this repo, not assumed:

| What changed                               | Server restarts by itself? | Why                                                                                        |
| ------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------ |
| `packages/server/src/**`                   | **yes**                    | `tsx watch` watches `src/`                                                                 |
| `packages/shared/src/**` (rebuilds `dist`) | **yes**, in `pnpm dev`     | restarting the server re-imports `@warship/shared`, which now resolves to the fresh `dist` |
| `packages/client/src/**`                   | n/a                        | Vite HMR handles it; the server is untouched                                               |
| A server started with `node dist/index.js` | **no**                     | `dist` imports `@warship/shared` once at startup and Node caches it forever                |
| A server left over from a previous run     | **no**                     | it is not the process the watcher manages — see the zombie case above                      |

Verified experimentally: with the stack running, `TICK_RATE` was changed `20 → 19`.
The server tick counter reset and settled at exactly **19 Hz**, then returned to
**20 Hz** when reverted. A separately started `node dist/index.js` on the same change
stayed at **20 Hz** — it never saw the new value until it was restarted.

**So:** in a normal `pnpm dev` workflow you do **not** need to restart anything after
a `git pull`; only a `dist`/production server needs an explicit restart. What bites
is a _stale process still holding the port_, which is what §3's reset is for.

**A protocol bump is different from a data change.** The version check runs per
frame, so a mismatched pair fails loudly with `4001` instead of half-working. That is
not a reason to restart _more_ often — it is why a mismatch is impossible to miss.

### Checking versions by hand

```bash
curl -s localhost:8080/health          # {"ok":true,"shard":"shard-0","tick":…}
grep PROTOCOL_VERSION packages/shared/src/constants.ts
```

If `droppedTicks` in `/health` keeps climbing while nothing is connected, the clock
is struggling on a loaded machine — usually harmless, but it explains jerky motion.

---

## 4. Symptom → cause

### 4.1 Keys do nothing

1. Hold a key and watch Debug → `sent`. If it climbs, the client is sending; the
   problem is server-side. If it stays at `0`, the listener never fired.
2. Add `?debug=keys` to the URL and press keys. Console should log
   `[INPUT] keydown {code: 'KeyW', key: 'w', action: 'forward'}`.
3. **Non-QWERTY layouts used to break WASD.** The controller reads `event.code`
   (the physical key) for exactly this reason — a Persian, AZERTY or Dvorak layout
   must still steer. If `code` is missing entirely from an event, `key` is used as a
   fallback.
4. Click the canvas once: it takes focus so keystrokes are delivered (needed inside
   iframes like Codespaces).
5. Shortcuts that hold Cmd/Ctrl/Alt are deliberately ignored, so browser shortcuts
   keep working. Release the modifier.

### 4.2 Mouse aim does nothing

- The ship turns toward the cursor **only while the pointer is over the canvas**.
  Move it off the canvas and the last known heading is kept.
- Turn speed is capped (`turnRate × 2.5`), so a battleship takes a moment to come
  about. That is deliberate, not lag.
- `aim` is applied by the server — if `input` shows a value but the hull never
  turns, restart the server (§3).

### 4.3 Wheel does not zoom

The listener uses `{ passive: false }`, which is required for `preventDefault` to
stop the page scrolling. If the page scrolls _and_ nothing zooms, the listener is
attached to the wrong element — check that the debug panel is inside the viewport
and not intercepting the wheel.

### 4.4 `entities` does not drop when you sail apart

AoI radius is **3000 units** on an 8000×8000 **wrapping** world.

- The world is a torus: sailing off the right edge brings you back on the left. Two
  ships at `(1000,1000)` and `(7000,7000)` are only **2828 units apart**, so they
  stay visible.
- The maximum possible distance is **5657** (a diagonal half-world), reached at the
  antipodes — e.g. `(2000,2000)` and `(6000,6000)`.
- So to see culling you must travel a _real_ 3000+ units, which is about 12 seconds
  at `normal` speed (240 u/s).

### 4.5 Your own ship stutters / `corrections` keeps climbing

Your ship and everyone else's are drawn by different machinery, so they fail
differently:

- **Your ship** is drawn from the _prediction_, which runs the same 20 Hz physics as
  the server and blends between two ticks for display. It must move on every rendered
  frame. If it visibly advances in steps, the blend is broken — not the network.
- **Other ships** are drawn from the _interpolation buffer_, 100 ms behind. Their
  smoothness depends on snapshots arriving; see §4.6.

`corrections` counts disagreements between the prediction and the server:

- `0 (last 60s)` while driving normally is the healthy state.
- A handful after a network hiccup is expected: the client is being told what really
  happened and eases the difference out over a few hundred milliseconds.
- A large `max` (hundreds of units) means the two are running _different physics_.
  There is only one movement implementation (`stepShipMotion` in `@warship/shared`),
  so that almost always means the page and the server are on different builds — §3.
- Errors above 64 units are snapped rather than eased, because easing a teleport looks
  like the ship is on a rubber band.

### 4.6 Remote ships look jerky

Interpolation renders `INTERPOLATION_DELAY_MS` (100 ms, two ticks) behind the newest
data, so it always has a pair of snapshots to blend between. That reduces, but cannot
remove, the need for both ends of the pair to exist.

- `interp buffer` below `2` means snapshots are not arriving fast enough to
  interpolate at all — look at the network, not the interpolation code.
- Jerkiness that only appears on a _laggy_ connection is arrival jitter. The sampler
  time-bases on **server ticks**, not on arrival times, precisely so packet jitter does
  not reach the screen; the measured difference is 62 % motion variation before that
  change and under 1 % after.

### 4.7 The world feels static — no sense of motion

The water is a **screen-space tiling texture**: identical everywhere, and scrolling on
its own, so it cannot show you moving. What proves motion is something _fixed_ going
past you. Three cues were added for that:

- **Buoys** — 120 world-space markers, derived deterministically from an index hash so
  every client sees the same layout with no server bandwidth. Drive past one and the
  movement is unambiguous.
- **Wake** — foam behind your own ship only (not every entity: it would multiply the
  particle count for something barely visible on other hulls). Pooled, 40 particles,
  1.4 s fade.
- **Grid** — a faint lattice every 2 000 units, drawn only for the visible region.

If none of these appear, the world layer is not being added to the camera — check the
console for a Pixi error rather than the network panel.

### 4.8 Motion is smooth but the ship is in the wrong place

That is the server disagreeing with the prediction, and it is what `prediction err` and
`corrections` are for. A steadily climbing error means the two are running different
physics: the shared `stepShipMotion` is the only movement implementation, so a large
mismatch almost always means the page and the server are on different builds — §3.

### 4.9 A correction is visible — which number explains it?

Four rows exist purely for this. Read them in this order:

| Row          | What it tells you                                                                                        |
| ------------ | -------------------------------------------------------------------------------------------------------- |
| `offset x`   | How far the drawn pose is displaced right now. Non-zero is normal; it falls to 0 within ~150 ms.         |
| `offset rot` | The same displacement in angle. Large values mean the server and you disagree on heading, not position.  |
| `max offset` | The worst displacement in the last minute. A steady climb means snapshots are arriving late or unevenly. |
| `ease τ`     | Which time constant is in use: `80 ms` routine, `150 ms` once the offset passes 6 units.                 |

If `offset x` spikes and takes noticeably longer than `ease τ` to return to 0, the
network is dropping or delaying snapshots — check `interp buffer` (§4.6). If `offset x`
stays near zero while the ship still stutters, the problem is not reconciliation at all
and is worth reporting with the value of every row in this table.

---

## 5. Headless checks (no browser needed)

```bash
# Everything must be green before you test by hand
pnpm build && pnpm lint && pnpm typecheck && pnpm test

# What a real client is receiving, printed to the terminal
pnpm --filter @warship/server run state -- --seconds 4
pnpm --filter @warship/server run state -- --watch --seconds 10
```

The `state` tool connects exactly like the browser (through `/ws`), drives the ship,
and prints tick, position, AoI membership, full-vs-delta counts and bandwidth. It is
the fastest way to tell a client bug from a server bug.

---

## 6. Restarting cleanly

```bash
# stop the dev stack
pnpm kill

# confirm the ports are free
ss -tlnp | grep -E ":8080|:5173"

# rebuild shared types if you changed them
pnpm --filter @warship/shared run build

pnpm dev
```
