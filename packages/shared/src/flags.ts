/**
 * MVP scope switches.
 *
 * The project grew a full networked architecture — interpolation, client-side
 * prediction, area-of-interest culling, delta compression, parallax, buoys, wakes.
 * All of it worked, and all of it is more than "can you play it" needs. This file is
 * the single place that decides which of those run, so the answer to "what does the
 * MVP include?" is a file you can read rather than a set of comments spread across the
 * codebase.
 *
 * Nothing was deleted. Every subsystem named here is still present, still tested, and
 * still correct; it is simply not on the path the game takes. Flipping a flag is the
 * whole of the work to bring one back.
 *
 * Rules for using these flags:
 *
 *  - A flag names a *capability*, never a code path. `MVP_FLAGS.prediction` means "the
 *    client predicts its own movement", not "the if-block in Game.ts runs".
 *  - The simple branch must be the default, because the default is what ships.
 *  - A disabled subsystem's tests keep running. Deleting the tests alongside the wiring
 *    is how a "temporary" simplification becomes permanent by accident.
 */
export const MVP_FLAGS: {
  interpolation: boolean;
  prediction: boolean;
  interestManagement: boolean;
  worldDecoration: boolean;
  hullTiers: boolean;
  advancedDebug: boolean;
} = {
  /**
   * Client-side interpolation of other players' poses.
   *
   * Off: every entity is drawn at its authoritative position from the newest snapshot.
   * At 20 Hz that is a visible 50 ms stagger on remote ships, which is the trade being
   * made deliberately — smooth remote motion is polish, not playability.
   */
  interpolation: false,

  /**
   * Client-side prediction of the local ship.
   *
   * Off: the player's own ship moves on the server's tick like everyone else's, so
   * input feels one round-trip late. This is the single biggest feel regression of the
   * MVP scope and the first thing to turn back on.
   */
  prediction: false,

  /**
   * Area-of-interest culling and delta compression.
   *
   * Off: every snapshot is full and contains every entity in the world. At the MVP's
   * scale that is a few kilobytes per tick; the grid and the AoI tracker still exist
   * and still work for when the population grows.
   */
  interestManagement: false,

  /**
   * Ocean parallax, buoys, wake trail and the grid overlay.
   *
   * Off: the water is a flat, static colour. Landmarks are the reason these existed —
   * without them, movement is hard to read at speed.
   */
  worldDecoration: false,

  /**
   * Hull tier upgrades every ten levels, which multiply hp, speed, damage and range.
   *
   * Off: a hull is the same hull at level 40 as at level 1. Levelling grants upgrade
   * points and nothing else, so the only power curve is the one the player buys.
   */
  hullTiers: false,

  /**
   * The advanced debug panel: prediction error, reconciliation offsets, ease τ, buffer
   * depth, camera and renderer details.
   *
   * Off: the panel shows fps, entity count and tick, which is what "is it running?"
   * actually needs.
   */
  advancedDebug: false,
};

/**
 * Turn everything back on.
 *
 * The flags are plain mutable booleans rather than a frozen constant on purpose: a test
 * that covers an advanced subsystem has to be able to enable it, and the alternative —
 * threading a feature config through every constructor — would touch far more code than
 * the subsystem it enables. The default is the MVP, which is what ships.
 */
export function enableAllFeatures(): void {
  for (const key of Object.keys(MVP_FLAGS) as (keyof typeof MVP_FLAGS)[]) {
    MVP_FLAGS[key] = true;
  }
}

/** Restore the shipped MVP configuration. */
export function resetFeatures(): void {
  for (const key of Object.keys(MVP_FLAGS) as (keyof typeof MVP_FLAGS)[]) {
    MVP_FLAGS[key] = false;
  }
}
