/**
 * Wire protocol — MessagePack encoded, one envelope per WebSocket frame.
 *
 * Design notes (protocol v2):
 *  - Every frame is a discriminated union keyed by `t`, a numeric id. Ids are
 *    append-only: never reuse a value that was removed, or a stale client will be
 *    silently misinterpreted.
 *  - `v` carries the protocol version so a stale client is rejected before it ever
 *    touches simulation state.
 *  - Liveness uses `PING`/`PONG` in both directions with the sender's monotonic
 *    clock echoed back, so either side can measure round-trip time.
 *  - Client → server frames are *intents*. The server is authoritative: `INPUT`
 *    never mutates state directly, it only tells the server what the player wants.
 *  - This file is types + constants only. Encoding/decoding lives in each package so
 *    `@warship/shared` never takes a runtime dependency.
 */

import type { PROTOCOL_VERSION, NpcTier, ShipClass, ZoneId } from './constants.js';
import type { BoxKind, EntityKind } from './combat.js';
import type { UpgradeId } from './upgrades.js';

/* -------------------------------------------------------------------------- */
/*  Message type ids                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Numeric ids identifying each message kind. Append-only, never reuse.
 * `1xx` is client → server, `2xx` is server → client, `9xx` is either direction.
 */
export const MessageType = {
  /* client → server */
  JOIN: 101,
  INPUT: 102,
  PICKUP: 103,
  UPGRADE: 104,
  TARGET: 105,

  /* server → client */
  WELCOME: 201,
  SNAPSHOT: 202,
  PLAYER_STATE: 203,
  EVENT: 204,

  /* either direction */
  PING: 901,
  PONG: 902,
} as const;

export type MessageType = (typeof MessageType)[keyof typeof MessageType];

/** Human-readable names, used by logs, tests and the debug overlay. */
export const MESSAGE_NAMES: Readonly<Record<MessageType, string>> = {
  [MessageType.JOIN]: 'JOIN',
  [MessageType.INPUT]: 'INPUT',
  [MessageType.PICKUP]: 'PICKUP',
  [MessageType.UPGRADE]: 'UPGRADE',
  [MessageType.TARGET]: 'TARGET',
  [MessageType.WELCOME]: 'WELCOME',
  [MessageType.SNAPSHOT]: 'SNAPSHOT',
  [MessageType.PLAYER_STATE]: 'PLAYER_STATE',
  [MessageType.EVENT]: 'EVENT',
  [MessageType.PING]: 'PING',
  [MessageType.PONG]: 'PONG',
};

/* -------------------------------------------------------------------------- */
/*  Primitive value types                                                     */
/* -------------------------------------------------------------------------- */

/** Milliseconds since the Unix epoch (wall clock). */
export type UnixEpochMs = number;

/** Milliseconds from `performance.now()` on the sender's clock. Monotonic. */
export type MonotonicMs = number;

/**
 * Signed angle in radians. 0 = pointing right (+x).
 *
 * The simulation runs in a standard maths frame (clockwise-positive, y down),
 * which matches screen space exactly — the client never has to flip a sign.
 */
export type Radians = number;

/** A 2D vector. A struct (not a tuple) so it survives JSON in debug tooling. */
export interface Vec2 {
  x: number;
  y: number;
}

/** Stable id of an entity (player ship or, later, an NPC). */
export type EntityId = string;

/** One player's input for one tick. Never authoritative on its own. */
export interface InputFrame {
  /** -1 = hard left, 0 = straight, +1 = hard right. Analogue allowed. */
  readonly turn: number;
  /** -1 = full reverse, 0 = idle, +1 = full ahead. */
  readonly throttle: number;
  /*
   * There used to be `aim` and `firing` here. Both are gone, and the absence is the
   * design: the hull is steered only by `turn`, and the *server* picks the target and
   * decides when to fire. A client that cannot express "shoot at that" cannot cheat by
   * expressing it, and the whole aim/aim-assist/reconciliation stack that existed to
   * keep two aim models in sync no longer has a reason to exist.
   *
   * The player still has agency — over which target is chosen, via `TARGET` — but that
   * is a *request*, validated server-side against range like every other input.
   */
}

/** One entity inside a snapshot. Intentionally flat and short. */
export interface SnapshotEntity {
  readonly id: EntityId;
  readonly x: number;
  readonly y: number;
  /** Hull facing in radians. */
  readonly rotation: Radians;
  /** Current hull points. Always >= 0. */
  readonly hp: number;
  /**
   * What this record is: a player, an NPC, a projectile or a box.
   *
   * Optional for the same reason `shipClass` is: a delta only re-states what changed.
   * Always present on a full snapshot and on an entity's first appearance, so the client
   * can classify an id exactly once and remember.
   */
  readonly kind?: EntityKind;
  /** NPC tier, so the client can pick a colour and the HP bar scale. NPC records only. */
  readonly npcTier?: NpcTier;
  /** Box payload kind. Box records only. */
  readonly boxKind?: BoxKind;
  /**
   * What this player is currently shooting at, if anything.
   *
   * Sent on the player's own record so the client can draw the target ring on the right
   * enemy without guessing which one the server picked. Optional for the usual reason:
   * a delta omits unchanged fields, and most frames have no target change at all.
   */
  readonly targetId?: EntityId | null;
  /** Shield remaining in seconds; non-zero means the hull is invulnerable. */
  readonly shield?: number;
  /**
   * Ship class, so the client can pick a sprite without a second lookup.
   *
   * Optional on the wire because a *delta* snapshot only re-states fields that
   * changed: a ship that merely moved keeps its already-known class. Always present
   * on a full snapshot and on the first appearance of an entity.
   */
  readonly shipClass?: ShipClass;
  /**
   * Set on a delta snapshot to say "this entity is part of the update". Absent means
   * the entity moved but is otherwise unchanged — the reader should look at the
   * fields that are present rather than assume a whole record.
   */
  readonly changed?: boolean;
  /**
   * Present **only on the viewer's own entity**: the newest input sequence the
   * server has applied. Client-side prediction uses it to drop acknowledged inputs
   * before replaying the rest.
   */
  readonly ackSeq?: number;
}

/** One entity the client should stop drawing (left AoI, died, or disconnected). */
export interface RemovedEntity {
  readonly id: EntityId;
  /** Why it went away; purely informational, the client treats them all the same. */
  readonly reason?: 'aoi' | 'gone';
}

/* -------------------------------------------------------------------------- */
/*  Envelope                                                                  */
/* -------------------------------------------------------------------------- */

/** Fields present on every frame, in both directions. */
export interface MessageBase {
  /** Protocol version the sender speaks. */
  v: typeof PROTOCOL_VERSION;
  /** Message kind — see `MessageType`. */
  t: MessageType;
}

/* ------------------------------- client → server -------------------------- */

/**
 * Ask to enter the world.
 *
 * Sent after the socket opens and after `WELCOME`, once the client knows the
 * server's protocol version and tick. The server answers with a `PLAYER_STATE`
 * for the spawn and starts including the entity in snapshots.
 */
export interface JoinMessage extends MessageBase {
  t: typeof MessageType.JOIN;
  /** Desired ship class. The server may override it (validation, capacity). */
  shipClass: ShipClass;
  /**
   * Client build info; makes stale-tab-vs-fresh-server debugging trivial.
   *
   * Optional because it is *wire* data: a client that omits it is doing nothing wrong
   * that justifies dropping the connection, and the server must read it defensively.
   */
  client?: {
    version: string;
    /** Resume ticket from a previous `WELCOME` — reserved, unused in the MVP. */
    ticket?: string;
  };
}

/**
 * Movement + combat intent for one tick.
 *
 * Sent at `CLIENT_INPUT_RATE`. `seq` is a strictly increasing client counter so
 * the server can drop out-of-order frames and the client can acknowledge later.
 */
export interface InputMessage extends MessageBase {
  t: typeof MessageType.INPUT;
  /** Monotonic per-client sequence number, starting at 1. */
  seq: number;
  /** The intent itself. */
  input: InputFrame;
  /** Client tick the input was produced for; the server clamps it to "now". */
  tick: number;
}

/** Try to collect a loot box. The server decides whether it is in reach. */
export interface PickupMessage extends MessageBase {
  t: typeof MessageType.PICKUP;
  /** Id of the box, as published in a previous `EVENT` or `SNAPSHOT`. */
  boxId: string;
}

/**
 * Ask the server to focus a specific target, or to go back to automatic targeting.
 *
 * A request, not a command. The server checks the id names something alive and inside
 * weapon range before honouring it, and it clears the selection itself when the target
 * dies or slips out of range — so a client that stops sending this can never hold a
 * stale lock on something it can no longer see.
 *
 * `entityId: null` is meaningful: it means "back to nearest enemy", which is how a
 * click on empty water is expressed.
 */
export interface TargetMessage extends MessageBase {
  t: typeof MessageType.TARGET;
  /** Id to focus, or `null` to resume automatic targeting. */
  entityId: string | null;
}

/** Spend scrap on one rank of an upgrade. Validated server-side. */
export interface UpgradeMessage extends MessageBase {
  t: typeof MessageType.UPGRADE;
  upgradeId: UpgradeId;
}

/** Every frame a client is allowed to send. */
export type ClientMessage =
  | JoinMessage
  | InputMessage
  | PickupMessage
  | UpgradeMessage
  | TargetMessage
  | PingMessage
  | PongMessage;

/* ------------------------------- server → client -------------------------- */

/**
 * Sent immediately after the socket upgrade succeeds.
 *
 * Carries everything the client needs to render before its first snapshot:
 * who it is, which shard, the tick it is joining at, and the world shape.
 */
export interface WelcomeMessage extends MessageBase {
  t: typeof MessageType.WELCOME;
  sessionId: string;
  shardId: string;
  /** Server wall-clock time at handshake (ms since epoch), for clock alignment. */
  serverTime: UnixEpochMs;
  /** Authoritative tick at handshake. */
  tick: number;
  /** Echo of `TICK_RATE` so the client never hardcodes it. */
  tickRate: number;
  /** How often the server sends `PING`, in ms. */
  heartbeatIntervalMs: number;
  /** World edge length, so the client can size its camera and minimap. */
  worldWidth: number;
  worldHeight: number;
  /** Opaque token for a future reconnect flow. */
  resumeToken: string;
}

/**
 * Full state of every relevant entity, every tick. No deltas yet by design:
 * correctness first, bandwidth later.
 */
export interface SnapshotMessage extends MessageBase {
  t: typeof MessageType.SNAPSHOT;
  /** Authoritative tick this snapshot describes. */
  tick: number;
  /** Server wall clock when the snapshot was built. */
  serverTime: UnixEpochMs;
  /**
   * `full` = everything in this client's Area of Interest, authoritative.
   * `delta` = only what changed since the previous snapshot, applied on top of it.
   *
   * The very first snapshot of a session is always `full`; the server then sends
   * deltas while the set of visible entities is stable and falls back to `full`
   * whenever it is not (join, leave, AoI churn) so a dropped frame can never
   * desynchronise the client for longer than one tick.
   */
  readonly full: boolean;
  /** Entities to create or update. */
  entities: readonly SnapshotEntity[];
  /** Entities to forget. Only meaningful on a `delta`. */
  removed?: readonly RemovedEntity[];
}

/**
 * Private state of the receiving player, sent a few times per second.
 *
 * Anything the *others* must not see goes here: exact HP, scrap, XP, level.
 */
export interface PlayerStateMessage extends MessageBase {
  t: typeof MessageType.PLAYER_STATE;
  tick: number;
  entityId: EntityId;
  shipClass: ShipClass;
  hp: number;
  maxHp: number;
  level: number;
  xp: number;
  /** XP still needed to reach the next level; 0 at `MAX_LEVEL`. */
  xpToNextLevel: number;
  scrap: number;
  /** Zone the player currently occupies. */
  zone: ZoneId;
  /** Ranks purchased per upgrade id. Missing keys mean rank 0. */
  upgrades: Partial<Record<UpgradeId, number>>;
  /** Server tick this player last fired on, for the client's reload indicator. */
  lastFiredTick: number;
  /** Hull tier, 1..`MAX_HULL_TIER`; rises every `LEVELS_PER_HULL_TIER` levels. */
  hullTier?: number;
  /** Unspent upgrade points, so the HUD badge is right immediately on connect. */
  upgradePoints?: number;
  /** Seconds of spawn shield remaining; > 0 means damage is ignored. */
  shieldS?: number;
  /** True while dead, so the client shows the countdown instead of a hull. */
  dead?: boolean;
  /** Seconds until respawn while dead. */
  respawnInS?: number;
}

/** What happened. Discrete, one-off facts — never used for continuous state. */
export const EventKind = {
  Kill: 'kill',
  LevelUp: 'levelup',
  Pickup: 'pickup',
  /** The local player took damage. */
  Damaged: 'damaged',
  /** A loot box appeared in the world. */
  BoxSpawn: 'box-spawn',
  /** A loot box was claimed (by anyone). */
  BoxClaimed: 'box-claimed',
  /** A player entered or left the world. */
  Join: 'join',
  Leave: 'leave',
} as const;

export type EventKind = (typeof EventKind)[keyof typeof EventKind];

/** One game event. `data` is a small, event-specific payload. */
export interface EventMessage extends MessageBase {
  t: typeof MessageType.EVENT;
  tick: number;
  kind: EventKind;
  /** Entity the event is about, when there is one. */
  entityId?: EntityId;
  /** Player-facing detail. Kept tiny because it may be broadcast. */
  data?: {
    readonly killerId?: EntityId;
    readonly victimId?: EntityId;
    readonly level?: number;
    readonly xp?: number;
    readonly amount?: number;
    readonly boxId?: string;
    readonly shipClass?: ShipClass;
    /** Box payload, for spawn/claim events. */
    readonly boxKind?: BoxKind;
    /** NPC tier, for kill events. */
    readonly npcTier?: NpcTier;
    /** Upgrade choices offered on a level-up (the modal renders these). */
    readonly choices?: readonly UpgradeId[];
    /**
     * Unspent points after the award.
     *
     * Sent with the level-up rather than derived on the client: the client cannot know
     * how many levels a single award crossed, so any local arithmetic would show the
     * wrong badge exactly when a player is most likely to look at it.
     */
    readonly upgradePoints?: number;
    /** Current ranks, so the modal can label each offer with its true rank. */
    readonly upgrades?: Partial<Record<UpgradeId, number>>;
    /** Seconds until respawn, for a death event. */
    readonly respawnInS?: number;
    /** XP still needed for the next level. */
    readonly xpToNext?: number;
  };
}

/** Every frame the server is allowed to send. */
export type ServerMessage =
  WelcomeMessage | SnapshotMessage | PlayerStateMessage | EventMessage | PingMessage | PongMessage;

/* ------------------------------- both directions -------------------------- */

/** Liveness probe. The receiver answers with a `PONG` carrying the same nonce. */
export interface PingMessage extends MessageBase {
  t: typeof MessageType.PING;
  /** Correlates request and answer; a pong with an unknown nonce is discarded. */
  nonce: number;
  /** Sender's monotonic clock when the frame was written. Echoed back verbatim. */
  sentAt: MonotonicMs;
}

/** Answer to a `PING`. The receiver measures RTT as `now() - sentAt`. */
export interface PongMessage extends MessageBase {
  t: typeof MessageType.PONG;
  /** Mirrors `PingMessage.nonce`. */
  nonce: number;
  /** Mirrors `PingMessage.sentAt` from the ping that triggered this pong. */
  sentAt: MonotonicMs;
  /** Tick the responder was on when it wrote the frame. */
  tick?: number;
}

/** Either direction — handy for generic transport code and test doubles. */
export type NetMessage = ClientMessage | ServerMessage;

/* -------------------------------------------------------------------------- */
/*  Narrowing helpers                                                         */
/* -------------------------------------------------------------------------- */

/** Runtime guard: does this message carry a `t` we understand? */
export function isKnownMessageType(value: unknown): value is MessageType {
  return typeof value === 'number' && value in MESSAGE_NAMES;
}

/** Runtime guard used by the server's decoder to classify an inbound frame. */
export function isClientMessageType(
  value: unknown,
): value is (typeof MessageType)[keyof Pick<
  typeof MessageType,
  'JOIN' | 'INPUT' | 'PICKUP' | 'UPGRADE' | 'TARGET' | 'PING' | 'PONG'
>] {
  return (
    value === MessageType.JOIN ||
    value === MessageType.INPUT ||
    value === MessageType.PICKUP ||
    value === MessageType.UPGRADE ||
    value === MessageType.TARGET ||
    value === MessageType.PING ||
    value === MessageType.PONG
  );
}

/* -------------------------------------------------------------------------- */
/*  Connection lifecycle                                                      */
/* -------------------------------------------------------------------------- */

/** What the UI shows while the socket moves between these states. */
export type ConnectionState =
  'idle' | 'connecting' | 'handshaking' | 'joining' | 'connected' | 'reconnecting' | 'disconnected';

/**
 * Close codes used by the server. 4xxx is the application-defined range.
 * `1000`/`1001`/`1002`/`1011` are the standard codes we reuse.
 */
export const CloseCode = {
  Normal: 1000,
  GoingAway: 1001,
  ProtocolError: 1002,
  UnsupportedData: 1003,
  InternalError: 1011,
  /** beyond capacity */
  ServerFull: 4000,
  /** protocol version mismatch */
  VersionMismatch: 4001,
  /** heartbeat missed */
  HeartbeatTimeout: 4002,
  /** input before JOIN, or a second JOIN */
  NotJoined: 4003,
} as const;

export type CloseCode = (typeof CloseCode)[keyof typeof CloseCode];
