const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A room's address. The same room ID everywhere; only where the station sits on a map is personal. */
export const roomHref = (roomId: string): string => `/rooms/${roomId}`;

/** One discussion of a room (R02). */
export const discussionHref = (roomId: string, discussionId: string): string => `/rooms/${roomId}/t/${discussionId}`;

/** A room's optional activity (R03): its list, and one poll or quiz. Reached only from inside the room. */
export const activitiesHref = (roomId: string): string => `/rooms/${roomId}/activity`;
export const activityHref = (roomId: string, activityId: string): string => `/rooms/${roomId}/activity/${activityId}`;

/** Whether a route parameter is a well-formed ID, so a malformed address is never sent to the API. */
export const isRoomId = (value: string | undefined): value is string => value !== undefined && UUID.test(value);

/** A room's Today (R3 B): the day's question and Spot the flaw over the Today discussion. */
export const todayHref = (roomId: string): string => `/rooms/${roomId}/today`;
