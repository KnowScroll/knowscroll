import { io } from 'socket.io-client';
import {
  PRESENCE_HEARTBEAT_MS,
  SOCKET_PATH,
  ScopeChangedHintSchema,
  socketEvents,
  type ScopeRef,
} from '@knowscroll/contracts';
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
  /**
   * Whether the app is open and visible right now. Heartbeats go only while it is, so a closed tab or
   * a backgrounded app stops looking "Online" within a minute. Omitted means always visible.
   */
  readonly visible?: () => boolean;
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
 *
 * A room is subscribed only while a screen watches it (`AccountScope.watchRoom`): its hint marks that room's
 * queries and every open room discussion stale, so a message or a face appearing is read within seconds without
 * waiting for the slow poll.
 *
 * It also says "I'm around" every `PRESENCE_HEARTBEAT_MS` while connected and visible. The server
 * stores that only for a person who chose to show availability, and answers the same either way, so the
 * socket never learns the choice. A beat is not consumption evidence.
 */
export function connectScopeSocket(scope: AccountScope, context: SocketContext): ScopeConnection {
  const token = context.bearerToken();
  // The handshake names the scope it opens for (review M1), as every HTTP request does.
  const socket = io(context.baseUrl, {
    path: SOCKET_PATH,
    transports: ['websocket'],
    auth: token === undefined ? { scope: scope.id } : { scope: scope.id, token },
  });
  const highest: Record<Exclude<ScopeRef['kind'], 'room'>, number> = { universe: -1, inbox: -1 };
  const highestRoom = new Map<string, number>();
  const desiredRooms = new Set<string>();
  const subscribedRooms = new Set<string>();
  const refreshRoom = (roomId: string) => {
    if (!scope.active) return;
    void scope.queryClient.invalidateQueries({ queryKey: scope.queryKey(TALK_QUERY_KEY, 'room', roomId) });
    void scope.queryClient.invalidateQueries({ queryKey: scope.queryKey(TALK_QUERY_KEY, 'room-discussion') });
  };
  /** Brings the server's subscriptions in line with the rooms screens are watching. */
  const syncRooms = () => {
    if (!socket.connected) return;
    for (const roomId of subscribedRooms)
      if (!desiredRooms.has(roomId)) {
        subscribedRooms.delete(roomId);
        highestRoom.delete(roomId);
        socket.emit(socketEvents.unsubscribeScope, { scope: { kind: 'room', id: roomId } });
      }
    for (const roomId of desiredRooms)
      if (!subscribedRooms.has(roomId)) {
        subscribedRooms.add(roomId);
        socket.emit(socketEvents.subscribeScope, { scope: { kind: 'room', id: roomId } }, (ack: { ok: boolean }) => {
          // Whatever happened while this subscription was not there is only visible by reading again.
          if (ack.ok) refreshRoom(roomId);
          else subscribedRooms.delete(roomId);
        });
      }
  };
  const refresh = (kind: Exclude<ScopeRef['kind'], 'room'> | 'all') => {
    if (!scope.active) return;
    void scope.queryClient.invalidateQueries({
      queryKey: kind === 'inbox' ? scope.queryKey(TALK_QUERY_KEY) : scope.queryKey(),
    });
  };
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const beat = () => {
    if (scope.active && socket.connected && (context.visible?.() ?? true))
      socket.emit(socketEvents.presenceHeartbeat, () => undefined);
  };
  const stopHeartbeat = () => {
    if (heartbeat !== undefined) clearInterval(heartbeat);
    heartbeat = undefined;
  };
  socket.on('connect', () => {
    stopHeartbeat();
    beat();
    heartbeat = setInterval(beat, PRESENCE_HEARTBEAT_MS);
    // A new connection has no subscriptions: ask for the rooms again.
    subscribedRooms.clear();
    syncRooms();
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
    if (!hint.success) return;
    const named = hint.data.scope;
    if (named.kind === 'room') {
      if (!desiredRooms.has(named.id) || hint.data.revision <= (highestRoom.get(named.id) ?? -1)) return;
      highestRoom.set(named.id, hint.data.revision);
      refreshRoom(named.id);
      return;
    }
    if (named.id !== scope.account.universeId) return;
    if (hint.data.revision <= highest[named.kind]) return;
    highest[named.kind] = hint.data.revision;
    refresh(named.kind);
  });
  socket.on(socketEvents.scopeResync, () => {
    refresh('all');
    for (const roomId of desiredRooms) refreshRoom(roomId);
  });
  socket.on('disconnect', (reason) => {
    stopHeartbeat();
    if (reason === 'io server disconnect' && scope.active) context.onRevoked();
  });
  socket.on('connect_error', (error: Error) => {
    if (error.message === 'SCOPE_MISMATCH' && scope.active) context.onMismatch();
  });
  return {
    watchRooms(roomIds) {
      desiredRooms.clear();
      for (const roomId of roomIds) desiredRooms.add(roomId);
      syncRooms();
    },
    close() {
      stopHeartbeat();
      socket.removeAllListeners();
      socket.close();
    },
  };
}
