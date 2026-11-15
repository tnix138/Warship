/**
 * Global, engine-independent constants shared by `@warship/server` and `@warship/client`.
 *
 * Rules for this file:
 *  - constants and types only — no functions, no imports, no side effects,
 *  - everything here must be safe to import from a browser bundle,
 *  - tuning values live here so client prediction and server simulation can never drift.
 *
 * Derived math (costs, XP curves, damage) lives in `formulas.ts`, never here.
 */

/* -------------------------------------------------------------------------- */
/*  Project identity                                                          */
/* -------------------------------------------------------------------------- */

export const PROJECT_NAME = 'warship' as const;
/** Bumped whenever a frame changes shape. Mismatched peers are closed with 4001. */
/**
 * Wire protocol version.
 *
 * v3 added the delta-snapshot fields (`full`, `removed`, per-entity `ackSeq`) and
 * Area-of-Interest culling. It is a breaking change with a silent failure mode — a
 * v2 client would treat a delta as a full frame and delete every entity the delta
 * did not mention — so the version is bumped and old clients are refused at the
 * handshake with `4001` rather than left to misbehave.
 */
export const PROTOCOL_VERSION = 3 as const;

/** Wire-level names. The WebSocket subprotocol is negotiated during the upgrade. */
export const WS_PATH = '/ws' as const;
export const WS_SUBPROTOCOL = 'warship' as const;

/* -------------------------------------------------------------------------- */
/*  Networking / simulation timing                                            */
/* -------------------------------------------------------------------------- */

/** Authoritative simulation frequency. The server runs one tick every 50 ms. */
export const TICK_RATE = 20 as const;
export const TICK_DURATION_MS = 1000 / TICK_RATE; // 50
export const TICK_DURATION_S = TICK_DURATION_MS / 1000; // 0.05

/** Client renders remote entities `INTERPOLATION_DELAY_MS` in the past. */
export const INTERPOLATION_DELAY_MS = 100 as const;
/** Keep at most this many seconds of snapshot history for interpolation. */
export const INTERPOLATION_BUFFER_S = 1 as const;

/**
 * The client should keep this many snapshots queued up to smooth over jitter.
 * Small values reduce perceived lag; large values hide packet loss.
 */
export const NETWORK_JITTER_BUFFER_SNAPSHOTS = 3 as const;

/** Snapshots are sent at this rate, independent of the simulation tick (MVP: same rate). */
export const SNAPSHOT_RATE = 20 as const;

/** uWS closes a connection with no traffic for this long (seconds). */
export const NETWORK_IDLE_TIMEOUT_S = 60 as const;

/**
 * Hard cap for a single inbound WebSocket payload (bytes).
 *
 * 8 KiB is enough for a full input batch plus a resume handshake, and small
 * enough that a hostile peer cannot make us allocate meaningfully.
 */
/**
 * Largest inbound WebSocket frame the server accepts (uWS `maxPayloadLength`).
 *
 * Outbound frames are not size-capped by this constant — uWS does not limit what
 * the server sends. The headroom exists for a future *inbound* world-state frame
 * (a reconnect that uploads its last known snapshot), and for UPGRADE/PICKUP
 * batches carrying ids. 16 KiB is far above anything the current protocol sends
 * (a full 100-entity SNAPSHOT is ~7 KB) while still rejecting garbage early.
 */
export const NETWORK_MAX_PAYLOAD_BYTES = 16_384 as const; // 16 KiB

/** Inbound frames allowed per connection per second; excess is dropped, not fatal. */
/**
 * Inbound frames allowed per connection per second.
 *
 * Budget: INPUT runs at 20 Hz, the heartbeat round-trip is 1/s, and PICKUP /
 * UPGRADE arrive in bursts when the player is near a box or in the dock. 40 leaves
 * ~2x headroom over the steady state instead of sitting right at it, so an honest
 * client is never punished for a hitch or a burst of clicks. Anything above this is
 * dropped and counted, never buffered.
 */
export const NETWORK_MAX_MESSAGES_PER_SECOND = 40 as const;

/** Pings are sent by the client at this interval so middleboxes keep the socket warm. */
export const CLIENT_HEARTBEAT_INTERVAL_MS = 5_000 as const;
/** A client that has not answered within this window is considered disconnected. */
export const CLIENT_TIMEOUT_MS = 15_000 as const;

/** How often the client sends its INPUT intent. Mirrors the tick rate. */
export const CLIENT_INPUT_RATE = 20 as const;
/** Client sends PLAYER_STATE every N ticks (server side, 20 ticks/s ÷ 5 = 4 Hz). */
export const PLAYER_STATE_INTERVAL_TICKS = 5 as const;

/**
 * How often a client is guaranteed a **full** snapshot even when nothing changed.
 *
 * Delta snapshots only carry what changed, which is what makes them cheap — but it
 * also means the client's world is only correct as long as it applied every delta in
 * order. TCP guarantees delivery and ordering today; this keyframe is cheap insurance
 * against a future transport change (WebTransport, an unreliable datagram channel for
 * the fast path) and against a client-side bug that drops one frame.
 *
 * One per second: at 20 Hz that is 5% of frames, and it bounds any desync to ≤1 s.
 */
export const SNAPSHOT_KEYFRAME_INTERVAL_TICKS = TICK_RATE;

/** Server rounds snapshot coordinates to this many decimals to save bytes. */
export const SNAPSHOT_COORDINATE_DECIMALS = 2 as const;

/** Maximum players per server. */
export const MAX_PLAYERS_PER_SERVER = 100 as const;

/* -------------------------------------------------------------------------- */
/*  World                                                                     */
/* -------------------------------------------------------------------------- */

/** World is a square, origin at the top-left, units are "world units" (≈1 px at zoom 1). */
export const WORLD_WIDTH = 8_000 as const;
export const WORLD_HEIGHT = 8_000 as const;

/** Horizontal wrap-around: the map behaves like a torus (no hard walls at the edge). */
export const WORLD_WRAPS_X = true as const;
export const WORLD_WRAPS_Y = true as const;

/**
 * Spatial hash edge length, in world units.
 *
 * 2000 over an 8000×8000 world gives a 4×4 grid: coarse enough that a cell holds a
 * meaningful crowd, fine enough that neighbour queries touch a handful of cells.
 * The MVP only exposes cell maths (no culling yet), but the constant is fixed now
 * so the wire protocol and any future AoI work agree on it.
 */
export const GRID_SIZE = 2_000 as const;
export const GRID_COLUMNS = WORLD_WIDTH / GRID_SIZE; // 4
export const GRID_ROWS = WORLD_HEIGHT / GRID_SIZE; // 4

/**
 * How far a player can see, in world units.
 *
 * This is the Area-of-Interest radius: the server only tells a client about
 * entities inside it. 3000 on a 2000-unit grid means the 3x3 neighbourhood is not
 * enough — a ship sitting in a cell corner reaches two cells out — so AoI walks
 * `gridCellsInRadius` rather than assuming a 3x3 block.
 *
 * It is also comfortably larger than the longest weapon range (1100), so a ship you
 * can shoot is always a ship you can see.
 */
export const AOI_INTEREST_RADIUS = 3_000 as const;

/**
 * How much faster a hull may rotate when steered by mouse aim than by keyboard.
 *
 * Mouse aim is absolute ("face this way") while `turn` is relative ("rotate this
 * fast"), so adopting a heading directly would let a flick of the cursor spin a
 * battleship on the spot. This multiplier caps the assist at a few times the hull's
 * own turn rate: responsive, but never instant. 1.0 would make the mouse feel as
 * slow as the keyboard and defeat the point; 2.5 lands in one or two ticks for a
 * normal flick.
 */
export const AIM_ASSIST_FACTOR = 2.5 as const;

/** Where every new player is spawned: a ring inside the safe zone. */
export const SPAWN_CENTER_X = WORLD_WIDTH / 2;
export const SPAWN_CENTER_Y = WORLD_HEIGHT / 2;
export const SPAWN_RING_RADIUS = 260 as const;
/** Each successive spawn is rotated by this angle around the ring. */
export const SPAWN_ANGLE_STEP = 0.7 as const;

/** A ship older than this has its input treated as neutral (dropped packet safety). */
export const INPUT_STALE_AFTER_MS = 500 as const;

/** Client-side camera limits. */
export const CAMERA_MIN_ZOOM = 0.25 as const;
export const CAMERA_MAX_ZOOM = 2.5 as const;
export const CAMERA_DEFAULT_ZOOM = 1 as const;
/** How fast the camera catches up to the followed ship (per second, 0..1). */
export const CAMERA_FOLLOW_LERP = 6 as const;

/* -------------------------------------------------------------------------- */
/*  Ship classes                                                              */
/* -------------------------------------------------------------------------- */

/** The three MVP ship classes. Each one maps to a single sprite in the client. */
export const ShipClass = {
  Speed: 'speed',
  Normal: 'normal',
  Power: 'power',
} as const;

export type ShipClass = (typeof ShipClass)[keyof typeof ShipClass];

/**
 * Static stats of a ship class before upgrades.
 *
 * `reloadTime` is authoritative; `fireRate` is the reciprocal exposed for UI and
 * ballistics code that thinks in shots-per-second. A unit test asserts the two
 * stay consistent, so they can never drift apart.
 */
export interface ShipClassDefinition {
  readonly id: ShipClass;
  readonly displayName: string;
  readonly description: string;
  /** Hull points at full health. */
  readonly hp: number;
  /** Top speed in world units per second. */
  readonly speed: number;
  /** Damage of one shot, before armor and upgrades. */
  readonly damage: number;
  /** Shots per second (== 1 / reloadTime). */
  readonly fireRate: number;
  /** Radians per second the hull rotates. */
  readonly turnRate: number;
  /** Seconds between shots. */
  readonly reloadTime: number;
  /** Weapon reach in world units. */
  readonly range: number;
  /** Collision radius in world units. */
  readonly radius: number;
  /** Sprite key the client resolves against its texture set. */
  readonly spriteKey: string;
  /** Hull colour, reused by the client for the minimap dot and the HP bar. */
  readonly color: number;
}

export const SHIP_CLASSES: Readonly<Record<ShipClass, ShipClassDefinition>> = {
  [ShipClass.Speed]: {
    id: ShipClass.Speed,
    displayName: 'Speed',
    description: 'Fast, fragile raider. Low hull, quick reload, short reach.',
    hp: 80,
    speed: 320,
    damage: 8,
    fireRate: 4,
    turnRate: 2.4,
    reloadTime: 0.25,
    range: 600,
    radius: 14,
    spriteKey: 'ship-scout',
    color: 0x5ca884,
  },
  [ShipClass.Normal]: {
    id: ShipClass.Normal,
    displayName: 'Normal',
    description: 'Balanced all-rounder. The default choice.',
    hp: 140,
    speed: 240,
    damage: 14,
    fireRate: 2.5,
    turnRate: 1.7,
    reloadTime: 0.4,
    range: 800,
    radius: 20,
    spriteKey: 'ship-destroyer',
    color: 0x58769e,
  },
  [ShipClass.Power]: {
    id: ShipClass.Power,
    displayName: 'Power',
    description: 'Slow, heavily armed bruiser. Long reach, long reload.',
    hp: 240,
    speed: 160,
    damage: 30,
    fireRate: 1.4,
    turnRate: 1.1,
    reloadTime: 1 / 1.4,
    range: 1_100,
    radius: 30,
    spriteKey: 'ship-battleship',
    color: 0x686078,
  },
} as const;

/** Every ship class id, in menu order. */
export const SHIP_CLASS_ORDER: readonly ShipClass[] = [
  ShipClass.Speed,
  ShipClass.Normal,
  ShipClass.Power,
] as const;

/** The class a player gets when they ask for nothing in particular. */
export const DEFAULT_SHIP_CLASS: ShipClass = ShipClass.Normal;

/* -------------------------------------------------------------------------- */
/*  Zones                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The map is three concentric rings around the world centre:
 *
 *   safe  — no PvP, weak NPCs, reduced XP   (where you spawn and learn)
 *   mid   — PvP, mid-tier NPCs, normal XP
 *   open  — PvP, strong NPCs, bonus XP      (the dangerous, lucrative rim)
 *
 * `radius` is the outer edge, in world units. `null` means "everything that is
 * left", which keeps the innermost-to-outermost ordering explicit.
 */
export const ZoneId = {
  Safe: 'safe',
  Mid: 'mid',
  Open: 'open',
} as const;

export type ZoneId = (typeof ZoneId)[keyof typeof ZoneId];

export interface ZoneDefinition {
  readonly id: ZoneId;
  readonly displayName: string;
  /** Outer radius in world units, measured from the world centre. `null` = unbounded. */
  readonly radius: number | null;
  /** Whether player-vs-player damage is allowed. */
  readonly pvp: boolean;
  /** Multiplier applied to all XP earned inside the zone. */
  readonly xpMultiplier: number;
  /** Inclusive NPC level band that spawns here. */
  readonly npcLevelRange: { readonly min: number; readonly max: number };
  /** Tint the client uses for the zone ring. */
  readonly color: number;
}

export const ZONES: readonly ZoneDefinition[] = [
  {
    id: ZoneId.Safe,
    displayName: 'Safe Waters',
    radius: 1_000,
    pvp: false,
    xpMultiplier: 0.5,
    npcLevelRange: { min: 1, max: 3 },
    color: 0x4fd1c5,
  },
  {
    id: ZoneId.Mid,
    displayName: 'Contested Waters',
    radius: 2_800,
    pvp: true,
    xpMultiplier: 1,
    npcLevelRange: { min: 3, max: 6 },
    color: 0xf6c86b,
  },
  {
    id: ZoneId.Open,
    displayName: 'Open Sea',
    radius: null,
    pvp: true,
    xpMultiplier: 1.5,
    npcLevelRange: { min: 6, max: 10 },
    color: 0xff6b6b,
  },
] as const;

/** Zone a player is dropped into on their first join. */
export const DEFAULT_ZONE: ZoneId = ZoneId.Safe;

/* -------------------------------------------------------------------------- */
/*  Loot                                                                      */
/* -------------------------------------------------------------------------- */

/** NPC size tiers. Drops scale with tier; the server rolls on `BOX_DROP_TABLE`. */
export const NpcTier = {
  Small: 'small',
  Medium: 'medium',
  Large: 'large',
} as const;

export type NpcTier = (typeof NpcTier)[keyof typeof NpcTier];

/** What a destroyed NPC of a given tier can drop. */
export interface BoxDropTable {
  readonly tier: NpcTier;
  /** Scrap (soft currency) awarded, before zone and level multipliers. */
  readonly scrap: { readonly min: number; readonly max: number };
  /** XP awarded, before zone and level multipliers. */
  readonly xp: { readonly min: number; readonly max: number };
  /** Probability in 0..1 that an upgrade part drops. */
  readonly partChance: number;
  /** How many boxes a single kill can spawn. */
  readonly boxCount: number;
}

export const BOX_DROP_TABLE: Readonly<Record<NpcTier, BoxDropTable>> = {
  [NpcTier.Small]: {
    tier: NpcTier.Small,
    scrap: { min: 2, max: 6 },
    xp: { min: 4, max: 10 },
    partChance: 0.05,
    boxCount: 1,
  },
  [NpcTier.Medium]: {
    tier: NpcTier.Medium,
    scrap: { min: 8, max: 18 },
    xp: { min: 15, max: 30 },
    partChance: 0.18,
    boxCount: 2,
  },
  [NpcTier.Large]: {
    tier: NpcTier.Large,
    scrap: { min: 25, max: 55 },
    xp: { min: 45, max: 90 },
    partChance: 0.4,
    boxCount: 3,
  },
} as const;

/* -------------------------------------------------------------------------- */
/*  Progression                                                               */
/* -------------------------------------------------------------------------- */

/** Level 1 is the starting level; XP is earned from kills and box pickups. */
export const STARTING_LEVEL = 1 as const;
/** Total XP a brand-new player has. */
export const STARTING_XP = 0 as const;
/** Highest level reachable in the MVP. */
export const MAX_LEVEL = 50 as const;

/** XP needed to go from level 1 to level 2. */
export const XP_BASE = 100 as const;
/** Every level costs this much more than the previous one (quadratic-ish curve). */
export const XP_GROWTH = 1.18 as const;
/** Flat armor mitigation used when a target has no armor at all. */
export const MIN_DAMAGE = 1 as const;

/** Scrap a new player starts with. */
export const STARTING_SCRAP = 0 as const;

/* -------------------------------------------------------------------------- */
/*  Rendering                                                                 */
/* -------------------------------------------------------------------------- */

export const RENDER_BACKGROUND_COLOR = 0x04121e as const;
export const RENDER_WATER_TINT = 0xffffff as const;
export const RENDER_MAX_DPR = 2 as const;
/** The water tile is repeated at this size in world units. */
export const RENDER_WATER_TILE_SIZE = 512 as const;
/** Water scroll rate, in world units per second, purely cosmetic. */
export const RENDER_WATER_SCROLL_X = 6 as const;
export const RENDER_WATER_SCROLL_Y = 3 as const;
/** Blink period of the "you are here" ring under the local player's ship. */
export const RENDER_SELF_RING_PULSE_MS = 1_400 as const;

/**
 * Whether to log every key press the input controller resolves.
 *
 * Enabled by `?debug=keys` in the URL or `localStorage.warshipDebugKeys = '1'`.
 * This exists because "my keys do nothing" cannot be diagnosed from a screenshot:
 * either the events never arrive, or they arrive and map to nothing — and only the
 * console can tell those two apart.
 *
 * A function rather than a constant because it reads `location`/`localStorage`, and
 * a module-level read would (a) execute under Node during tests and (b) freeze the
 * answer before the user can flip the flag.
 */
export function inputDebugEnabled(): boolean {
  if (typeof globalThis === 'undefined') return false;

  const location = (globalThis as { location?: { search?: unknown } }).location;
  if (typeof location?.search === 'string' && location.search.includes('debug=keys')) return true;

  try {
    // `localStorage` is absent under Node, and throws in sandboxed iframes.
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    return storage?.getItem('warshipDebugKeys') === '1';
  } catch {
    // localStorage throws in sandboxed iframes; a debug flag is not worth a crash.
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/*  Physics / gameplay                                                        */
/* -------------------------------------------------------------------------- */

/** Below this fraction of hull points the ship counts as "damaged" (visuals). */
export const SHIP_DAMAGED_HP_FRACTION = 0.35 as const;
/** How quickly a ship reaches its target speed, in units of speed per second². */
export const SHIP_ACCELERATION = 900 as const;
/** How quickly a ship bleeds off speed when the throttle is released. */
export const SHIP_DRAG = 520 as const;
/** How many round-trip samples the client keeps for its EWMA estimate. */
export const PING_SAMPLE_COUNT = 10 as const;
/** Smoothing factor of the client-side round-trip estimate. */
export const PING_EWMA_ALPHA = 0.2 as const;
/** Thresholds the UI uses to colour the ping indicator. */
export const PING_GOOD_MS = 80 as const;
export const PING_WARN_MS = 200 as const;

/* -------------------------------------------------------------------------- */
/*  Persistence (SQLite / Drizzle)                                            */
/* -------------------------------------------------------------------------- */

/** Where the SQLite file lives, relative to the server package (overridable via env). */
export const DB_FILE_DEFAULT = 'data/warship.sqlite' as const;
export const DB_BUSY_TIMEOUT_MS = 5_000 as const;

/* -------------------------------------------------------------------------- */
/*  Multi-shard readiness                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A shard is one authoritative simulation process. The MVP runs a single shard
 * (`shard-0`), but every id, envelope and log line carries the shard so we can
 * fan out later without touching the protocol.
 */
export const DEFAULT_SHARD_ID = 'shard-0' as const;

/** Environments a server can run in. */
export type RuntimeEnvironment = 'development' | 'production' | 'test';

/** Reason carried by every disconnect so the client can show a meaningful message. */
export type DisconnectReason = 'client-closed' | 'server-shutdown' | 'timeout' | 'protocol-error';
