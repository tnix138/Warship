# Milestone 3.1 — Smooth motion and a world that moves

Two reported problems: **jitter/flicker while moving**, and **no sense of motion**
because the background never changes.

Both are fixed. Neither had the cause described in the request — the investigation is
below, because the difference matters for what will break next.

---

## 1. The jitter: three separate defects

The hypothesis was that `reconcile()` snaps on small errors, that the interpolation
buffer is too short, and that `renderTime` is unstable. Measured against the code:

| Hypothesis               | Reality                                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| error > threshold → snap | Threshold is **64 units**. Normal prediction error is **< 12 units**, so it never fired. Snapping was not the cause. |
| buffer < 100 ms          | Already **100 ms** (two ticks), the recommended value.                                                               |
| `renderTime` unstable    | Correct — but it was not what a player feels while _their own_ ship stutters.                                        |

The actual defects, in order of how much they hurt:

### 1.1 The prediction was under-sampled (the visible stutter)

`applyInput()` integrated **one whole 50 ms tick per input**. Inputs arrive at 20 Hz
while the screen draws at 60 Hz, so the player's own ship changed position **20 times a
second** while every other ship moved every frame — interpolation is continuous, the
prediction was not. Measured on the old code: **80 position changes over 240 frames**
(20 Hz). That is the "jitter" — no network involvement at all.

The fix is a fixed-timestep simulation with a blending render step, exactly what the
interpolator already did for remote ships:

```
    tick 1 ────────── tick 2 ────────── tick 3      (20 Hz simulation)
      │        │        │        │        │
     60 Hz frames draw between the two ticks
```

`Prediction.update(deltaS, input, seq)` now accumulates real time, integrates on the
server's 20 Hz tick, and draws the blend between the last two tick states.

Measured after: **179 of 179 frames moving, 0 % variation, 0 backward steps**, 4.000
units per frame at 240 u/s — exactly the theoretical value.

### 1.2 The client and server ran different physics

The server treats `aim` as **authoritative**: it rotates the hull toward the cursor,
capped at `turnRate × 2.5 × dt`. The client's prediction used `stepMotion`, which has
no concept of `aim` and silently dropped that rotation.

The two ends therefore disagreed on _every tick_ while aiming. Smoothing corrections
cannot hide a permanent disagreement, so it showed up as continuous rubber-banding.

Rather than duplicate the logic, movement now lives in `@warship/shared` as
`stepShipMotion` and **both ends call it**. Verified: 5 intent patterns × 500 ticks,
**0 divergences, max difference 0.00e+0**.

### 1.3 A second under-sampling bug, found only by the live test

Unit tests passed, then a live run against the running server showed motion on **25 %
of frames**. Cause: `reconcile()` ran at 20 Hz and called a helper that flattened the
drawn pose back to the raw tick boundary, discarding the blend. It now re-derives the
blended pose.

This is worth stating plainly: **the unit tests did not catch it.** The end-to-end test
against a real server did. A test that never reconciles is not testing a networked
client.

### 1.4 Interpolation no longer inherits network jitter

The interpolator used packet **arrival times** as its time base, so every hiccup in
delivery became a hiccup on screen. It now blends on **server tick timestamps**, which
advance perfectly evenly, and converts the render clock into server time using a
minimum-delay offset estimate.

Measured motion variation, 60 s at 60 Hz:

| Network jitter | Arrival-based (before) | Tick-based (after) |
| -------------- | ---------------------- | ------------------ |
| 0 ms           | 0.0 %                  | 0.0 %              |
| 15 ms          | **35.8 %**             | **0.3 %**          |
| 30 ms          | **62.5 %**             | **0.9 %**          |

### 1.5 Reconciliation policy (as requested)

| Error        | Behaviour                                                   |
| ------------ | ----------------------------------------------------------- |
| < 0.01 units | ignored — far below a pixel                                 |
| 0.01 – 64    | **eased** out exponentially (τ = 80 ms)                     |
| > 64         | **snapped** — this is a teleport, and easing it looks worse |

Two mechanisms run in sequence, and keeping them apart is what made this work:

1. **The tick blend** owns motion between ticks. The drawn pose is
   `previous + (sim − previous) × (accumulator / 50 ms)`. Measured on a step input this
   has **0.0 % frame-to-frame variation**, against 39.6 % for a first-order follow
   filter — the blend is exact because both endpoints are one tick apart and the factor
   is proportional to elapsed time.
2. **The correction offset** owns the disagreement with the server. On reconciliation the
   simulation's `sim` moves by `delta`; the offset absorbs `−delta × alpha` on that very
   frame, so the drawn pose is **continuous at the instant of correction** instead of
   snapping, then decays to zero with τ = 80 ms.

The offset is stored apart from the simulation state, so smoothing can never feed back
into the physics and compound. It decays monotonically and never accumulates, so the two
mechanisms cannot fight — which is exactly what an earlier version did when it decayed a
_time-based_ offset while also advancing the blend (17 backward steps, 390 % variance).

#### Measured result (live server, 60 fps client, real WebSocket)

| Metric                      | Before | After              |
| --------------------------- | ------ | ------------------ |
| Frames that move            | 33 %   | **100 %**          |
| Backward steps              | —      | **0**              |
| Distance per frame (steady) | —      | **4.00 u** (exact) |
| Predicted error, steady     | 21.75  | **0.00**           |
| Outliers outside ±0.15 u    | —      | 12 of 151 frames   |

The 12 outliers are a single real correction event at frame 61–73 that eases out over
~80 ms (`9.64 → 4.59 → 4.48 → 4.39 → 4.00`) — the intended behaviour, not a defect.

---

## 2. Sense of motion

The water is a **screen-space tiling texture**. It is identical everywhere, so it cannot
communicate movement — by construction, not by tuning. What proves motion is something
_fixed_ going past you, plus a surface that responds to your own travel.

### 2.1 Why the sea looked static (the actual bug)

The tiles did animate — but at a **fixed cosmetic rate**:

```ts
this.#near.tilePosition.x += RENDER_WATER_SCROLL_X * dt; // 6 u/s, always
```

Nothing in that expression depends on the ship. The ocean looked _exactly_ the same
standing still as it did at flank speed, which reads as a frozen sea no matter how
smoothly the texture moves. Adding landmarks helps, but the water itself still denies
that you are moving.

The scroll is now the sum of two terms:

```ts
const travel = shipSpeed * RENDER_WATER_PARALLAX; // 1.0
this.#near.tilePosition.x += (RENDER_WATER_SCROLL_X + travel) * dt;
```

A small constant current keeps calm water alive; the speed term makes the surface stream
past in proportion to travel. `Ocean.update(deltaMS, shipSpeed)` takes the predicted
speed from the same `Prediction` the camera follows, so the water and the ship always
agree.

Measured on the live server: travelling at 240 u/s, the drawn displacement implies
**248.5 u/s** (3.5 % high, within timer noise), with **zero** frames of negative travel.

All cues are `Graphics` primitives. No new assets, no textures.

**Buoys (primary cue).** 120 world-space markers in four shapes (can, cone, sphere,
spar) and four colours, placed by a deterministic hash of the index. Every client
computes the identical layout with **zero server bandwidth** and **zero entities** — a
buoy never enters a snapshot, never affects AoI, and never needs synchronising.
Rejection sampling keeps them from clumping. Distance is measured across the
**torus seam**, so a buoy at x = 7 950 is correctly visible from x = 100 rather than
7 850 units away.

**Wake (secondary cue).** Foam behind the player's own ship only. A 40-slot object
pool, one particle per 90 ms, 1.4 s fade and spread. Emission is on a fixed clock, not
per frame, so the trail looks the same at 30 and 144 fps. Deliberately not drawn for
remote ships: it would multiply the particle count for a detail you cannot see on
another hull.

**Grid (tertiary cue).** A lattice every 2 000 units at 5 % alpha, rebuilt only when
the visible line range changes and wrapped across the seam. It is there for open water
where no buoy is in view.

Everything is viewport-culled: only what is on screen is drawn, so cost is independent
of world size.

---

## 3. Debug panel

The rows now answer the three questions a jitter report needs:

```
interp buffer    3 frames (100ms)
prediction err   0.32 units
corrections      0 (last 60s) · max 0.0u
```

`interp buffer` below 2 means snapshots are not arriving (network). `prediction err`
climbing steadily means the two ends disagree (build mismatch). Both are explained in
`docs/HOW-TO-TEST.md` §4.5–4.8.

---

## 4. Tests

**151 total** (was 119): 61 shared, 57 client, 33 server. All green, plus build, lint,
typecheck and format at zero.

Every fix was proven by failing first:

| Test                                          | Without the fix           |
| --------------------------------------------- | ------------------------- |
| `Prediction — smooth local motion` (4 tests)  | 9 of 10 new tests fail    |
| `reconciliation must not break smooth motion` | fails (25 % of frames)    |
| `aim parity with the server`                  | fails (hull never turns)  |
| `resistance to network jitter` (4 tests)      | 35.8 % / 62.5 % variation |
| `buoys` (11 tests)                            | n/a — new                 |
| `ocean parallax` (3 tests)                    | n/a — new                 |

**End-to-end.** `smoothness.e2e.test.ts` boots the **real server binary** as a
subprocess, connects a real WebSocket, and drives the real `Prediction` and
`Interpolation` with the frames that come back. It asserts:

- position logged every 100 ms is strictly increasing and never stalls;
- interpolated motion changes on ≥ 90 % of 60 Hz frames and never reverses.

**Live verification** against the running dev stack — a real server, a real WebSocket,
the real `Prediction`, and 121 captured snapshots replayed on a perfect 60 Hz virtual
clock:

| Metric                  | Result                      |
| ----------------------- | --------------------------- |
| Frames that move        | **240 / 240**               |
| Mean distance per frame | **4.000 u** (exactly right) |
| Frame-to-frame variance | **0.0 %**                   |
| Backward steps          | **0**                       |
| Corrections applied     | **0**                       |

On a wall clock driven by Node's `setTimeout` the same run implies a drawn speed of
**248.5 u/s** against a true 240 u/s (3.5 % high), with **zero** negative travel. The
residual is timer jitter in the harness, not the client: a browser ticker is vsync-locked,
which is what the virtual-clock run models.

---

## 5. What was not done, and why

- **No extrapolation.** When the render clock runs past the newest snapshot, the world
  holds its pose instead of predicting forward. Extrapolation overshoots on every
  course change and then snaps back, which is worse than a few ms of held pose.
- **No drag-to-pan.** The camera follows the ship; a pan would be undone on the next
  frame. Wheel zoom is the one camera control that composes with a following camera.
- **No buoy networking.** They are decoration. Generating them client-side from a
  constant keeps them free, and the hash makes the layout identical everywhere.
- **Interpolation delay stays at 100 ms.** Raising it hides more jitter but makes
  everyone else feel laggier; 100 ms is the working compromise.

Scope is unchanged: no NPCs, boxes, level or combat. That is step 4.

---

## 6. Files

| File                                              | Change                                                      |
| ------------------------------------------------- | ----------------------------------------------------------- |
| `packages/shared/src/formulas.ts`                 | **new** `stepShipMotion` — the one movement implementation  |
| `packages/server/src/game/Loop.ts`                | calls the shared step; local `approachAngle` deleted        |
| `packages/client/src/game/Prediction.ts`          | rewritten: fixed timestep, blending, eased corrections      |
| `packages/client/src/net/Interpolation.ts`        | tick-based sampling, smoothed render clock, offset estimate |
| `packages/client/src/render/buoys.ts`             | **new** deterministic buoy layout and seam-aware query      |
| `packages/client/src/render/ocean.ts`             | water scroll now speed-linked; the static-sea fix           |
| `packages/client/src/render/WorldObjects.ts`      | **new** buoys, wake pool, culled grid                       |
| `packages/shared/src/constants.ts`                | **new** `RENDER_WATER_PARALLAX`                             |
| `packages/client/src/game/Game.ts`                | per-frame prediction, world objects wiring                  |
| `packages/client/src/ui/GameHud.ts`, `index.html` | new debug rows                                              |
| `docs/HOW-TO-TEST.md`                             | checklist, symptom table, jitter explanations               |
