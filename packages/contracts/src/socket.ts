import { z } from 'zod';
import { UniverseIdSchema, UuidSchema } from './ids.js';

/**
 * Socket.IO live hints (blueprint §4, §7). Sockets carry subscriptions and disposable revision
 * hints only: no commands, no private content. A client that gets a hint (or a resync) refetches
 * through authorised HTTP reads.
 *
 * Three scopes exist. `universe` and `inbox` are named by the caller's own universe ID. `universe`
 * changes when the person's universe changes. `inbox` changes when a conversation the person belongs
 * to has a new message or the person's own conversation settings change; its revision is the person's
 * inbox revision. A peer's reading, muting or typing never moves it. `room` is named by a room's ID and
 * only a current member may subscribe: it changes when someone sends a message in the room or when who
 * has the room open changes. A hint never says what changed, and a room has nothing to catch up from: its
 * revision is only the commit time in milliseconds, not a position.
 *
 * Client rules:
 * - For `universe` and `inbox`, revisions only grow, but hints, acks, command responses and reads can
 *   arrive in any order and more than once: keep the **highest** revision seen per scope and refetch only
 *   when a hint is above it. A `room` hint is never deduplicated by revision (two messages a second apart
 *   have nothing to tell them apart but a clock): coalesce a burst with a short quiet window, refetching
 *   once at the start and once at the end.
 * - When the server closes the connection ('transport close'), reconnect (which authenticates
 *   again) and resubscribe; the API does this to every socket when its notice relay reconnects,
 *   because a revocation sent while it was away may have been lost. 'io server disconnect' means
 *   the account's access was revoked: reconnect only after signing in again.
 *
 * Presence is the one thing a client says over the socket: `presence_heartbeat`, every
 * `PRESENCE_HEARTBEAT_MS` while the app is open and visible. The answer is always the same
 * `{ ok: true }` for a signed-in socket, so it cannot tell a person whether their availability is
 * shared. The server stores a heartbeat only for a person who chose to show availability, and an
 * availability that is not renewed expires on its own (blueprint §17).
 */
export const socketEvents = {
  subscribeScope: 'subscribe_scope',
  unsubscribeScope: 'unsubscribe_scope',
  scopeChanged: 'scope_changed',
  scopeResync: 'scope_resync',
  scopeRevoked: 'scope_revoked',
  presenceHeartbeat: 'presence_heartbeat',
  roomTyping: 'room_typing',
} as const;

/** How often an open, visible app sends `presence_heartbeat`. The server lets an availability lapse
 * after three missed heartbeats, so a closed tab or a lost connection cannot stay "Online". */
export const PRESENCE_HEARTBEAT_MS = 20_000;

/**
 * The second thing a client says over the socket: `room_typing`, while a member of a room types in a discussion
 * (D-067, D-165). The only use is to hold back an AI turn. The server writes no person and no text, relays it to no
 * one, shows it to no one, and answers `{ ok: true }` whether or not it was understood or the sender is a member.
 * A device sends at most one every `ROOM_TYPING_HINT_MS`.
 */
export const RoomTypingSchema = z.strictObject({ roomId: UuidSchema, discussionId: UuidSchema });
export type RoomTyping = z.infer<typeof RoomTypingSchema>;
export const ROOM_TYPING_HINT_MS = 4_000;

/** Acknowledgement of `presence_heartbeat`. Identical whether or not availability is shared. */
export const PresenceHeartbeatAckSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), code: z.enum(['UNAUTHENTICATED', 'UNAVAILABLE']) }),
]);
export type PresenceHeartbeatAck = z.infer<typeof PresenceHeartbeatAckSchema>;

/** The socket path on the API origin (proxied by Caddy, D-008). */
export const SOCKET_PATH = '/socket.io';

export const SCOPE_KINDS = ['universe', 'inbox', 'room'] as const;
/** `id` is the caller's own universe for `universe` and `inbox`, and a room's ID for `room`. */
export const ScopeRefSchema = z.object({ kind: z.enum(SCOPE_KINDS), id: UniverseIdSchema });

export const SubscribeScopeRequestSchema = z.object({ scope: ScopeRefSchema });

/** Acknowledgement of `subscribe_scope`: access is checked on every subscribe. */
export const SubscribeScopeAckSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), revision: z.number().int().min(0) }),
  z.object({ ok: z.literal(false), code: z.enum(['INVALID_REQUEST', 'UNAUTHENTICATED', 'FORBIDDEN', 'UNAVAILABLE']) }),
]);

/** A committed change to a subscribed scope. `revision` only grows; duplicates are possible. */
export const ScopeChangedHintSchema = z.object({
  scope: ScopeRefSchema,
  revision: z.number().int().min(0),
  eventId: z.uuid(),
});

/** Hints may have been lost (relay reconnected): refetch every subscribed scope. */
export const ScopeResyncHintSchema = z.object({ reason: z.enum(['listening', 'reconnected']) });

/** Access to a subscribed scope no longer holds: the subscription was dropped; stop showing it. */
export const ScopeRevokedHintSchema = z.object({ scope: ScopeRefSchema });

export type ScopeRef = z.infer<typeof ScopeRefSchema>;
export type ScopeRevokedHint = z.infer<typeof ScopeRevokedHintSchema>;
export type SubscribeScopeAck = z.infer<typeof SubscribeScopeAckSchema>;
export type ScopeChangedHint = z.infer<typeof ScopeChangedHintSchema>;
export type ScopeResyncHint = z.infer<typeof ScopeResyncHintSchema>;
