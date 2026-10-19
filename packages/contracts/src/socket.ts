import { z } from 'zod';
import { UniverseIdSchema } from './ids.js';

/**
 * Socket.IO live hints (blueprint §4, §7). Sockets carry subscriptions and disposable revision
 * hints only: no commands, no private content. A client that gets a hint (or a resync) refetches
 * through authorised HTTP reads.
 */
export const socketEvents = {
  subscribeScope: 'subscribe_scope',
  unsubscribeScope: 'unsubscribe_scope',
  scopeChanged: 'scope_changed',
  scopeResync: 'scope_resync',
} as const;

/** The socket path on the API origin (proxied by Caddy, D-008). */
export const SOCKET_PATH = '/socket.io';

export const ScopeRefSchema = z.object({ kind: z.literal('universe'), id: UniverseIdSchema });

export const SubscribeScopeRequestSchema = z.object({ scope: ScopeRefSchema });

/** Acknowledgement of `subscribe_scope`: access is checked on every subscribe. */
export const SubscribeScopeAckSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), revision: z.number().int().min(0) }),
  z.object({ ok: z.literal(false), code: z.enum(['INVALID_REQUEST', 'UNAUTHENTICATED', 'FORBIDDEN']) }),
]);

/** A committed change to a subscribed scope. `revision` only grows; duplicates are possible. */
export const ScopeChangedHintSchema = z.object({
  scope: ScopeRefSchema,
  revision: z.number().int().min(0),
  eventId: z.uuid(),
});

/** Hints may have been lost (relay reconnected): refetch every subscribed scope. */
export const ScopeResyncHintSchema = z.object({ reason: z.enum(['listening', 'reconnected']) });

export type ScopeRef = z.infer<typeof ScopeRefSchema>;
export type SubscribeScopeAck = z.infer<typeof SubscribeScopeAckSchema>;
export type ScopeChangedHint = z.infer<typeof ScopeChangedHintSchema>;
export type ScopeResyncHint = z.infer<typeof ScopeResyncHintSchema>;
