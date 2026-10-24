const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A room's address. The same room ID everywhere; only where the station sits on a map is personal. */
export const roomHref = (roomId: string): string => `/rooms/${roomId}`;

/** One discussion of a room (R02). */
export const discussionHref = (roomId: string, discussionId: string): string => `/rooms/${roomId}/t/${discussionId}`;

/** Whether a route parameter is a well-formed ID, so a malformed address is never sent to the API. */
export const isRoomId = (value: string | undefined): value is string => value !== undefined && UUID.test(value);
