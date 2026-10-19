import { io } from 'socket.io-client';
import { SOCKET_PATH, ScopeChangedHintSchema, socketEvents } from '@knowscroll/contracts';
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

/**
 * The account scope's hint socket (blueprint §4, §18): Socket.IO on the API origin, subscribed to
 * the scope's own universe. Hints carry no data: a `scope_changed` above what the scope has seen,
 * or a `scope_resync`, marks the scope's queries stale so they refetch through authorised HTTP
 * reads. "io server disconnect" means the server dropped the account's sockets: the manager
 * rechecks the session; a handshake refused as `SCOPE_MISMATCH` (another account or epoch is now
 * this device's) makes it reread the session. Closing it (the scope's first step when it ends) removes every handler
 * first, so no hint of an ended scope reaches anything.
 */
export function connectScopeSocket(scope: AccountScope, context: SocketContext): ScopeConnection {
  const token = context.bearerToken();
  // The handshake names the scope it is for (review M1), as every HTTP request does.
  const socket = io(context.baseUrl, {
    path: SOCKET_PATH,
    transports: ['websocket'],
    auth: token === undefined ? { scope: scope.id } : { scope: scope.id, token },
  });
  let highest = -1;
  const refresh = () => {
    if (scope.active) void scope.queryClient.invalidateQueries({ queryKey: scope.queryKey() });
  };
  socket.on('connect', () => {
    socket.emit(
      socketEvents.subscribeScope,
      { scope: { kind: 'universe', id: scope.account.universeId } },
      (ack: { ok: boolean; revision?: number }) => {
        if (ack.ok && typeof ack.revision === 'number') highest = Math.max(highest, ack.revision);
        // Anything committed while this socket was away is only visible by reading again.
        refresh();
      },
    );
  });
  socket.on(socketEvents.scopeChanged, (raw: unknown) => {
    const hint = ScopeChangedHintSchema.safeParse(raw);
    if (!hint.success || hint.data.scope.id !== scope.account.universeId || hint.data.revision <= highest) return;
    highest = hint.data.revision;
    refresh();
  });
  socket.on(socketEvents.scopeResync, refresh);
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
