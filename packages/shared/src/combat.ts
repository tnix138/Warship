/**
 * Combat, NPCs, loot and progression constants for milestone 4.
 *
 * Everything the server enforces and the client draws lives here, so a tuning change
 * is one edit and neither side can disagree with the other. The server is authoritative
 * for every number that decides an outcome; the client only needs enough to render and
 * to predict its own reload.
 */

import { NpcTier, ZoneId } from './constants.js';

/* -------------------------------------------------------------------------- */
/*  Entity kinds                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The kind of thing an id refers to.
 *
 * Ids are opaque strings, so without this a client cannot tell which pool an id in a
 * snapshot belongs to, and a projectile would be drawn as a ship. This travels with
 * every entity record.
 */
export const EntityKind = {
  Player: 'player',
  Npc: 'npc',
  Projectile: 'projectile',
  Box: 'box',
} as const;

export type EntityKind = (typeof EntityKind)[keyof typeof EntityKind];

/* -------------------------------------------------------------------------- */
/*  NPC tiers                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Which NPC tier spawns where.
 *
 * This is the "risk pays" curve: the safe centre is contested by weak ships, the rim by
 * strong ones, and the reward table already scales with tier. A tier that spawned in the
 * wrong zone would make one band of the map pointless.
 */
export const NPC_TIER_ZONE: Readonly<Record<NpcTier, ZoneId>> = {
  [NpcTier.Small]: ZoneId.Safe,
  [NpcTier.Medium]: ZoneId.Mid,
  [NpcTier.Large]: ZoneId.Open,
};

/** Player-facing name for each tier, used by the HUD and the kill feed. */
export const NPC_TIER_NAMES: Readonly<Record<NpcTier, string>> = {
  [NpcTier.Small]: 'Coastal',
  [NpcTier.Medium]: 'Raider',
  [NpcTier.Large]: 'Warship',
};

/** Hull colour per tier, so the client and the debug panel agree with the docs. */
export const NPC_TIER_COLORS: Readonly<Record<NpcTier, number>> = {
  [NpcTier.Small]: 0x5cc98a,
  [NpcTier.Medium]: 0xf0a04b,
  [NpcTier.Large]: 0xa874e0,
};

/** Combat and movement stats for one NPC tier. */
export interface NpcStats {
  readonly tier: NpcTier;
  readonly displayName: string;
  readonly maxHp: number;
  readonly damage: number;
  readonly maxSpeed: number;
  readonly turnRate: number;
  readonly range: number;
  readonly reloadTime: number;
  readonly radius: number;
  /** How far away the NPC notices a player, in world units. */
  readonly detectRadius: number;
  readonly color: number;
  /** XP the client should expect before zone and level multipliers. */
  readonly xp: number;
}

/**
 * The three tier stat blocks.
 *
 * Calibrated against the player hulls rather than in isolation: a `Normal` player has
 * 140 hp and 14 damage, so a Coastal dies to ~8 player hits and kills its own tier in a
 * few seconds of sustained fire. A Warship needs a group or a Power hull — which is the
 * point of the rim being lucrative.
 */
export const NPC_STATS: Readonly<Record<NpcTier, NpcStats>> = {
  [NpcTier.Small]: {
    tier: NpcTier.Small,
    displayName: 'Coastal',
    maxHp: 60,
    damage: 6,
    maxSpeed: 150,
    turnRate: 1.4,
    range: 430,
    reloadTime: 1.1,
    radius: 16,
    detectRadius: 800,
    color: NPC_TIER_COLORS[NpcTier.Small],
    xp: 8,
  },
  [NpcTier.Medium]: {
    tier: NpcTier.Medium,
    displayName: 'Raider',
    maxHp: 140,
    damage: 12,
    maxSpeed: 195,
    turnRate: 1.6,
    range: 620,
    reloadTime: 0.85,
    radius: 20,
    detectRadius: 900,
    color: NPC_TIER_COLORS[NpcTier.Medium],
    xp: 24,
  },
  [NpcTier.Large]: {
    tier: NpcTier.Large,
    displayName: 'Warship',
    maxHp: 320,
    damage: 22,
    maxSpeed: 165,
    turnRate: 1.2,
    range: 850,
    reloadTime: 1.4,
    radius: 26,
    detectRadius: 1_000,
    color: NPC_TIER_COLORS[NpcTier.Large],
    xp: 70,
  },
} as const;

/* -------------------------------------------------------------------------- */
/*  NPC lifecycle                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Hard cap on live NPCs, across all tiers.
 *
 * This is a performance budget, not a difficulty knob: every NPC costs physics, an AoI
 * slot and potentially a projectile stream. Past this, spawning is refused rather than
 * degrading everyone's frame time.
 */
export const NPC_MAX_ALIVE = 50;

/** How many NPCs the world tries to keep alive, per tier. Sums below the cap. */
export const NPC_TARGET_COUNTS: Readonly<Record<NpcTier, number>> = {
  [NpcTier.Small]: 24,
  [NpcTier.Medium]: 16,
  [NpcTier.Large]: 8,
};

/** Seconds a spawn slot waits after a kill before it is refilled. */
export const NPC_RESPAWN_MIN_S = 30;
export const NPC_RESPAWN_MAX_S = 60;

/** Ticks between spawn-slot top-ups. Cheap enough to run once a second. */
export const NPC_SPAWN_INTERVAL_TICKS = 20;

/**
 * NPC behaviour states.
 *
 * Deliberately four, and deliberately without memory: this is a patrol/chase/fire drone,
 * not an opponent with tactics. Anything cleverer needs pathfinding, which needs a
 * navigation mesh, which is a different milestone.
 */
export const NpcState = {
  /** Circling a home point, ignoring the world. */
  Patrol: 'patrol',
  /** A player crossed the detection radius; closing in. */
  Chase: 'chase',
  /** In weapon range; holding station and firing. */
  Engage: 'engage',
  /** Dead, waiting to be respawned. */
  Dead: 'dead',
} as const;

export type NpcState = (typeof NpcState)[keyof typeof NpcState];

/** Radius, in world units, within which a patrolling NPC wanders around its home. */
export const NPC_PATROL_RADIUS = 420;

/** How far outside weapon range an engaged NPC will chase before giving up. */
export const NPC_CHASE_GIVE_UP = 1_400;

/* -------------------------------------------------------------------------- */
/*  Projectiles                                                               */
/* -------------------------------------------------------------------------- */

/** Hard cap on live projectiles. Reaching it drops the shot, it never grows. */
export const PROJECTILE_MAX_ALIVE = 500;

/** Collision radius of a projectile, in world units. */
export const PROJECTILE_RADIUS = 5;

/** Seconds a projectile lives before it is recycled. */
export const PROJECTILE_LIFETIME_S = 2;

/**
 * Speed multiplier applied to the firing ship's top speed.
 *
 * A projectile that outruns its owner by a large factor feels like a hitscan; one that
 * barely does feels sluggish. 3x a `Normal` hull is ~720 u/s, which crosses its 800-unit
 * range in about a second — long enough to see, short enough to aim.
 */
export const PROJECTILE_SPEED_FACTOR = 3;

/** Below this speed the projectile still travels, so a stationary ship can shoot. */
export const PROJECTILE_MIN_SPEED = 420;

/**
 * How far ahead of the firing ship a projectile is placed, in world units.
 *
 * Zero would let a ship shoot itself when the muzzle offset and the hull radius
 * disagree; this clears the hull plus a margin.
 */
export const PROJECTILE_MUZZLE_OFFSET = 24;

/* -------------------------------------------------------------------------- */
/*  Loot boxes                                                                */
/* -------------------------------------------------------------------------- */

export const BoxKind = {
  Scrap: 'scrap',
  Repair: 'repair',
  Part: 'part',
} as const;

export type BoxKind = (typeof BoxKind)[keyof typeof BoxKind];

/** Radius within which a box is collected automatically, in world units. */
export const BOX_PICKUP_RADIUS = 150;

/** Seconds a box survives before it despawns, so the sea does not fill with loot. */
export const BOX_LIFETIME_S = 120;

/** Hard cap on live boxes, for the same reason the projectile cap exists. */
export const BOX_MAX_ALIVE = 200;

/** Colour per box kind, for the client. */
export const BOX_COLORS: Readonly<Record<BoxKind, number>> = {
  [BoxKind.Scrap]: 0xffce4a,
  [BoxKind.Repair]: 0x5ce0a8,
  [BoxKind.Part]: 0x7fb8ff,
};

/** Hull points restored by a repair box, as a fraction of max HP. */
export const BOX_REPAIR_FRACTION = 0.25;

/* -------------------------------------------------------------------------- */
/*  Progression                                                               */
/* -------------------------------------------------------------------------- */

/** Upgrade points granted per level. */
export const UPGRADE_POINTS_PER_LEVEL = 1;

/** Every this many levels, the hull itself is upgraded to the next tier. */
export const LEVELS_PER_HULL_TIER = 10;

/** Highest hull tier reachable (tier 1 is the starting hull). */
export const MAX_HULL_TIER = 3;

/** Stat multiplier applied per hull tier above the first. */
export const HULL_TIER_MULTIPLIER = 1.2;

/* -------------------------------------------------------------------------- */
/*  Respawn                                                                   */
/* -------------------------------------------------------------------------- */

/** Seconds between death and respawn. */
export const RESPAWN_DELAY_S = 5;

/** Seconds of invulnerability granted after respawning. */
export const RESPAWN_SHIELD_S = 3;

/** Radius of the safe-zone spawn ring, in world units, measured from centre. */
export const RESPAWN_RING_RADIUS = 260;

/**
 * Whether dying drops carried boxes.
 *
 * Off for now: the box economy is not yet worth punishing, and a full-loot rule makes
 * an unlucky first engagement feel like a wipe. The flag exists so turning it on is a
 * one-line change once the loop is proven.
 */
export const DEATH_DROPS_CARGO = false;

/* -------------------------------------------------------------------------- */
/*  Client rendering                                                          */
/* -------------------------------------------------------------------------- */

/** Radius the client draws an impact flash at, in world units. */
export const IMPACT_FLASH_RADIUS = 18;

/** How long an impact flash lingers, in milliseconds. */
export const IMPACT_FLASH_MS = 300;

/** How long a level-up toast stays on screen, in milliseconds. */
export const LEVEL_UP_TOAST_MS = 2_000;

/** How many upgrade choices the modal offers at once. */
export const UPGRADE_CHOICES = 3;
