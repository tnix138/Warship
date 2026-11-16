/**
 * Client-side mirror of the wire protocol.
 *
 * The server and the client both import the message *types* from `@warship/shared`,
 * so there is exactly one definition of the protocol in the repository. This module
 * is the client's single import point: it re-exports the shared types and adds the
 * two things that only the browser needs — an encoder for the frames we send, and
 * a narrow, defensive decoder for the frames we receive.
 *
 * Keeping it in one file means a protocol change touches `shared/protocol.ts`, then
 * either compiles here or fails loudly — never silently drifts.
 */

import { decode, encode } from '@msgpack/msgpack';

import {
  MessageType,
  PROTOCOL_VERSION,
  type ClientMessage,
  type InputFrame,
  type ServerMessage,
  type SnapshotEntity,
  type SnapshotMessage,
} from '@warship/shared';

export {
  CloseCode,
  EventKind,
  MessageType,
  PROTOCOL_VERSION,
  WS_SUBPROTOCOL,
} from '@warship/shared';

export type {
  ClientMessage,
  ConnectionState,
  EventMessage,
  InputFrame,
  InputMessage,
  JoinMessage,
  NetMessage,
  PickupMessage,
  PlayerStateMessage,
  ServerMessage,
  SnapshotEntity,
  SnapshotMessage,
  UpgradeMessage,
  WelcomeMessage,
} from '@warship/shared';

/** Encode one client message into a WebSocket binary frame. */
export function encodeClientMessage(message: ClientMessage): Uint8Array {
  return encode(message);
}

/**
 * Decode a binary frame from the server.
 *
 * Returns `null` when the frame is not MessagePack, or when it is not an object
 * carrying a numeric `t` — the two cheap checks that catch a version-skewed server
 * before it reaches gameplay code.
 */
export function decodeServerMessage(data: ArrayBuffer | Uint8Array): ServerMessage | null {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);

  let value: unknown;
  try {
    value = decode(bytes);
  } catch {
    return null;
  }

  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as { t?: unknown; v?: unknown };
  if (typeof candidate.t !== 'number') return null;

  return value as ServerMessage;
}

/** True when the message carries full world state. */
export function isSnapshot(message: ServerMessage): message is SnapshotMessage {
  return message.t === MessageType.SNAPSHOT;
}

/** Build a zeroed input frame; the caller fills in what it read from the devices. */
export function neutralInput(): InputFrame {
  return { turn: 0, throttle: 0, aim: null, firing: false };
}

/** Clamp an input value to the range the server accepts. */
export function clampAxis(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}

/** Compact one-line description of an entity, used by the debug overlay. */
export function describeEntity(entity: SnapshotEntity): string {
  return `${entity.id.slice(0, 8)} @ ${entity.x.toFixed(0)},${entity.y.toFixed(0)} hp ${String(entity.hp)}`;
}

/** Protocol version this build expects; surfaced by the HUD on a mismatch. */
export const EXPECTED_PROTOCOL_VERSION = PROTOCOL_VERSION;
