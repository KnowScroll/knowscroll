import { io } from 'socket.io-client';
import { SOCKET_PATH, ScopeChangedHintSchema, socketEvents, type ScopeRef } from '@knowscroll/contracts';
import type { AccountScope, ScopeConnection } from './account-scope';

/** What the socket needs from the scope manager besides the scope. */
export interface SocketContext {
  readonly baseUrl: string;
  /** The scope's own native bearer token, or `undefined` on the web (the same-origin cookie authenticates). */
  readonly bearerToken: () => string | undefined;
  /** The server dropped this account's sockets (sign-out or revocation): recheck the session. */
  readonly onRevoked: () => void;
  /** The server refused the handshake as made for another scope (`SCOPE_MISMATCH`): reread the session. */
  readonly onMismatch: () => void;
}

/** The query-key prefix under which Talk's queries live; an inbox hint refreshes only these. */
export const TALK_QUERY_KEY = 'talk';

/**
 * The account scope's hint socket (blueprint §4, §18): Socket.IO on the API origin, subscribed to
 * the scope's own universe and its inbox (both named by the person's own universe ID). Hints carry
 * no data: a `scope_changed` above what the scope has seen for that scope kind, or a `scope_resync`,
 * marks queries stale so they refetch through authorised HTTP reads. A universe hint refreshes
 * every query of the scope; an inbox hint only Talk's (`TALK_QUERY_KEY`). "io server disconnect"
 * means the server dropped the account's sockets: the manager rechecks the session; a handshake
 * refused as `SCOPE_MISMATCH` (another account or epoch is now this device's) makes it reread the
 * session. Closing it (the scope's first step when it ends) removes every handler first, so no hint
 * of an ended scope reaches anything.
 */
export function connectScopeSocket(scope: AccountScope, context: SocketContext): ScopeConnection {
  const token = context.bearerToken();
  // The handshake names the scope it opens for (review M1), as every HTTP request does.
  const socket = io(context.baseUrl, {
    path: SOCKET_PATH,
    transports: ['websocket'],
    auth: token === undefined ? { scope: scope.id } : { scope: scope.id, token },
  });
  const highest: Record<ScopeRef['kind'], number> = { universe: -1, inbox: -1 };
  const refresh = (kind: ScopeRef['kind'] | 'all') => {
    if (!scope.active) return;
    void scope.queryClient.invalidateQueries({
      queryKey: kind === 'inbox' ? scope.queryKey(TALK_QUERY_KEY) : scope.queryKey(),
    });
  };
  socket.on('connect', () => {
    for (const kind of ['universe', 'inbox'] as const)
      socket.emit(
        socketEvents.subscribeScope,
        { scope: { kind, id: scope.account.universeId } },
        (ack: { ok: boolean; revision?: number }) => {
          if (ack.ok && typeof ack.revision === 'number') highest[kind] = Math.max(highest[kind], ack.revision);
          // Anything committed while this socket was away is only visible by reading again.
          refresh(kind);
        },
      );
  });
  socket.on(socketEvents.scopeChanged, (raw: unknown) => {
    const hint = ScopeChangedHintSchema.safeParse(raw);
    if (!hint.success || hint.data.scope.id !== scope.account.universeId) return;
    const kind = hint.data.scope.kind;
    if (hint.data.revision <= highest[kind]) return;
    highest[kind] = hint.data.revision;
    refresh(kind);
  });
  socket.on(socketEvents.scopeResync, () => refresh('all'));
  socket.on('disconnect', (reason) => {
    if (reason === 'io server disconnect' && scope.active) context.onRevoked();
  });
  socket.on('connect_error', (error: Error) => {
    if (error.message === 'SCOPE_MISMATCH' && scope.active) context.onMismatch();
  });
  return {
    close() {
      socket.removeAllListeners();
      socket.close();
    },
  };
}
