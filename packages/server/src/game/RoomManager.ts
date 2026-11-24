export interface RoomInfo {
  readonly id: string;
  readonly maxPlayers: number;
  readonly players: Set<number>;
}

/**
 * Lightweight multi-room / shard registry for matchmaking.
 * Automatically assigns incoming players to a room with available capacity,
 * creating new rooms on demand.
 */
export class RoomManager {
  readonly #rooms = new Map<string, RoomInfo>();
  readonly #playerRoom = new Map<number, string>();
  readonly #maxPlayersPerRoom: number;
  #nextRoomIndex = 0;

  constructor(maxPlayersPerRoom = 100) {
    this.#maxPlayersPerRoom = maxPlayersPerRoom;
  }

  assignPlayer(playerId: number): RoomInfo {
    const existingRoomId = this.#playerRoom.get(playerId);
    if (existingRoomId) {
      const existing = this.#rooms.get(existingRoomId);
      if (existing) return existing;
    }

    for (const room of this.#rooms.values()) {
      if (room.players.size < room.maxPlayers) {
        room.players.add(playerId);
        this.#playerRoom.set(playerId, room.id);
        return room;
      }
    }

    const id = `shard-${(this.#nextRoomIndex++).toString()}`;
    const room: RoomInfo = {
      id,
      maxPlayers: this.#maxPlayersPerRoom,
      players: new Set([playerId]),
    };
    this.#rooms.set(id, room);
    this.#playerRoom.set(playerId, id);
    return room;
  }

  removePlayer(playerId: number): void {
    const roomId = this.#playerRoom.get(playerId);
    if (!roomId) return;
    this.#playerRoom.delete(playerId);
    const room = this.#rooms.get(roomId);
    if (!room) return;
    room.players.delete(playerId);
    if (room.players.size === 0 && this.#rooms.size > 1) {
      this.#rooms.delete(roomId);
    }
  }

  getRoomForPlayer(playerId: number): RoomInfo | undefined {
    const roomId = this.#playerRoom.get(playerId);
    return roomId ? this.#rooms.get(roomId) : undefined;
  }

  getStats(): { roomCount: number; totalPlayers: number } {
    return {
      roomCount: this.#rooms.size,
      totalPlayers: this.#playerRoom.size,
    };
  }
}
