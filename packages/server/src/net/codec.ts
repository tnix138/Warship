import { decode, encode } from '@msgpack/msgpack';
import {
  MESSAGE_NAMES,
  MessageType,
  isClientMessageType,
  type ClientMessage,
  type NetMessage,
  type ServerMessage,
} from '@warship/shared';

/**
 * MessagePack codec for the WarShip wire protocol.
 *
 * The single place where bytes become messages and messages become bytes, so a
 * future move to a hand-rolled binary layout touches nothing else.
 *
 * Decoding is deliberately defensive: the bytes came off the network, so the frame
 * is validated (`v` present and numeric, `t` a known client type) before anything
 * is allowed into the typed world. Field-level validation happens in the handlers,
 * where the message type is known.
 */

export class ProtocolError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProtocolError';
  }
}

/**
 * A client frame whose `v` has not been checked yet.
 *
 * The envelopes declare `v` as the literal protocol version, which is exactly what
 * handlers want *after* validation. At the decode boundary it must still be a plain
 * number, otherwise the version check itself is statically "always false".
 */
type WidenVersion<T> = T extends { v: number } ? Omit<T, 'v'> & { v: number } : never;
export type UnvalidatedClientMessage = WidenVersion<ClientMessage>;

/** Serialise a message into a binary frame, ready for `ws.send`. */
export function encodeMessage(message: NetMessage): Uint8Array {
  return encode(message);
}

/** Parse an inbound binary frame from a client without validating the version. */
export function decodeClientFrame(payload: ArrayBuffer | Uint8Array): UnvalidatedClientMessage {
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);

  let raw: unknown;
  try {
    raw = decode(bytes);
  } catch (error) {
    throw new ProtocolError('frame is not valid MessagePack', { cause: error });
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ProtocolError('frame did not decode to an object');
  }

  const candidate = raw as { v?: unknown; t?: unknown };

  if (typeof candidate.v !== 'number' || !Number.isFinite(candidate.v)) {
    throw new ProtocolError('frame is missing a numeric protocol version');
  }

  if (!isClientMessageType(candidate.t)) {
    throw new ProtocolError(
      `unknown client message type: ${String(candidate.t)} (expected one of ${Object.values(
        MessageType,
      )
        .filter((value) => value < MessageType.WELCOME)
        .map((value) => MESSAGE_NAMES[value])
        .join(', ')})`,
    );
  }

  return candidate as UnvalidatedClientMessage;
}

/** Parse a server frame. Used by tests and future client-side tooling. */
export function decodeServerFrame(payload: ArrayBuffer | Uint8Array): ServerMessage {
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  return decode(bytes) as ServerMessage;
}
