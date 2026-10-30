import { Inject } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  type OnGatewayInit,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import {
  ROOM_TYPING_HINT_MS,
  RoomTypingSchema,
  SOCKET_PATH,
  SubscribeScopeRequestSchema,
  socketEvents,
  type PresenceHeartbeatAck,
  type ScopeChangedHint,
  type ScopeRef,
  type ScopeResyncHint,
  type ScopeRevokedHint,
  type SubscribeScopeAck,
} from '@knowscroll/contracts';
import type { ApiConfig } from '@knowscroll/backend/infrastructure/config';
import type { ScopeNotice, ScopeNoticeSink } from '@knowscroll/backend/infrastructure/notices';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { READ_UNIVERSE_ACCESS, type ReadUniverseAccess } from '@knowscroll/backend/modules/identity';
import {
  HOLD_CAST,
  READ_ROOM_MEMBERSHIP,
  type HoldCast,
  type ReadRoomMembership,
} from '@knowscroll/backend/modules/rooms';
import {
  READ_INBOX_REVISION,
  RECORD_HEARTBEAT,
  type ReadInboxRevision,
  type RecordHeartbeat,
} from '@knowscroll/backend/modules/social';
import { API_CONFIG, CALLERS, LOG_EVENT } from '../tokens.js';
import { cookieValue, sessionCookieName } from '../http/auth-credentials.js';
import { scopeClaimMatches, type AuthenticatedCallers, type Caller } from '../http/callers.js';

function room(scope: ScopeRef): string {
  return `scope:${scope.kind}:${scope.id}`;
}

function callerOf(socket: { readonly data: unknown }): Caller | undefined {
  return (socket.data as { caller?: Caller } | undefined)?.caller;
}

/** Whether a socket may still receive a scope's hints: yes, not this scope, or not at all. */
type Authorisation = 'ok' | 'scope_revoked' | 'session_invalid';

/** A socket's heartbeats closer together than this are answered without a write (the client sends one every 20 s). */
const HEARTBEAT_FLOOR_MS = 10_000;

/** Typing hints closer together than this on one socket are dropped without a write (the client sends one per `ROOM_TYPING_HINT_MS`). */
const TYPING_FLOOR_MS = ROOM_TYPING_HINT_MS - 1_000;

/** One cache entry per session, scope and epoch; a room's ID cannot collide with a universe's. */
function cacheKey(caller: Caller, scope: ScopeRef): string {
  return `${caller.accountId}:${caller.sessionId}:${scope.id}:${caller.privacyEpoch}`;
}

/**
 * Socket.IO gateway for live hints (blueprint §4, §7): authenticated connections, authorised
 * `subscribe_scope`/`unsubscribe_scope` (the caller's `universe` and `inbox` scopes, both named by
 * their own universe, and a `room` scope, named by a room the caller is a current member of), and `scope_changed`/`scope_resync`/`scope_revoked` hints
 * from the LISTEN relay. The one socket command is `presence_heartbeat`, which says an open, visible
 * app is around (D-047). Everything else durable is read and written over HTTP.
 *
 * Room membership is a delivery aid, never authority:
 * - every subscribe joins first and then checks the caller's session validity and current access
 *   (so a change committed between the read and the join cannot be missed), and leaves again
 *   when either is refused;
 * - every relayed hint is re-authorised per socket — session validity and scope access, cached at
 *   most `KS_SOCKET_AUTH_CACHE_MS` (≤ 30 s) per session, scope and epoch; a socket whose access no
 *   longer holds leaves the room and is told `scope_revoked`; one whose session is no longer valid
 *   is disconnected (a `room` scope is never cached: membership is one indexed row, so a removed member
 *   hears nothing more at once);
 * - an access-revocation notice (`revokeAccountSockets`, S1.3 sign-out / session revocation /
 *   epoch change) disconnects every socket of that account at once;
 * - when the relay reconnects, notices sent meanwhile (revocations included) are lost, so the
 *   gateway forgets every cached authorisation and closes every socket's connection before it
 *   relays anything again: each client reconnects and authenticates again (validating its
 *   session), then resubscribes and refetches.
 */
@WebSocketGateway({ path: SOCKET_PATH, serveClient: false })
export class ScopeGateway implements OnGatewayInit, ScopeNoticeSink {
  @WebSocketServer() private server!: Server;
  private readonly authorisations = new Map<string, { readonly result: Authorisation; readonly at: number }>();

  constructor(
    @Inject(CALLERS) private readonly callers: AuthenticatedCallers,
    @Inject(READ_UNIVERSE_ACCESS) private readonly readAccess: ReadUniverseAccess,
    @Inject(READ_INBOX_REVISION) private readonly readInboxRevision: ReadInboxRevision,
    @Inject(READ_ROOM_MEMBERSHIP) private readonly readRoomMembership: ReadRoomMembership,
    @Inject(RECORD_HEARTBEAT) private readonly recordHeartbeat: RecordHeartbeat,
    @Inject(HOLD_CAST) private readonly holdCast: HoldCast,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(LOG_EVENT) private readonly logEvent: LogEvent,
  ) {}

  afterInit(server: Server): void {
    const cookieName = sessionCookieName(this.config.identity.secureCookies);
    server.use((socket, next) => {
      // Native clients send their bearer token in `auth.token`; browsers send the session cookie,
      // which every page could make them attach, so a cookie handshake must come from this origin
      // (cross-site WebSocket hijacking). Every handshake names its scope in `auth.scope`.
      const token: unknown = (socket.handshake.auth as { token?: unknown }).token;
      const cookie = socket.handshake.headers.cookie;
      if (
        typeof token !== 'string' &&
        cookieValue(cookie, cookieName) !== undefined &&
        socket.handshake.headers.origin !== this.config.identity.publicOrigin
      ) {
        this.logEvent('realtime.connection_refused', { reasonCode: 'ORIGIN_NOT_ALLOWED' });
        next(new Error('ORIGIN_NOT_ALLOWED'));
        return;
      }
      const scope: unknown = (socket.handshake.auth as { scope?: unknown }).scope;
      this.callers.resolve(typeof token === 'string' ? { authorization: `Bearer ${token}` } : { cookie }).then(
        (caller) => {
          if (caller === undefined) {
            this.logEvent('realtime.connection_refused', { reasonCode: 'UNAUTHENTICATED' });
            next(new Error('UNAUTHENTICATED'));
            return;
          }
          // The handshake names the scope it opens for (review M1): another account's or an
          // older epoch's socket is refused, and the client rereads its session.
          if (!scopeClaimMatches(caller, scope)) {
            this.logEvent('realtime.connection_refused', { reasonCode: 'SCOPE_MISMATCH' });
            next(new Error('SCOPE_MISMATCH'));
            return;
          }
          (socket.data as { caller?: Caller }).caller = caller;
          next();
        },
        (error: unknown) => {
          this.logEvent('realtime.connection_refused', { reasonCode: 'INTERNAL', error });
          next(new Error('INTERNAL'));
        },
      );
    });
  }

  @SubscribeMessage(socketEvents.subscribeScope)
  async subscribe(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<SubscribeScopeAck> {
    const request = SubscribeScopeRequestSchema.safeParse(body);
    if (!request.success) return { ok: false, code: 'INVALID_REQUEST' };
    const caller = callerOf(socket);
    if (caller === undefined) return { ok: false, code: 'UNAUTHENTICATED' };
    const name = room(request.data.scope);
    // Join first, then read: a change committed after the read reaches this socket. A hint may
    // therefore arrive before the ack; revisions only grow and clients tolerate duplicates.
    await socket.join(name);
    try {
      if (!(await this.callers.sessionValid(caller))) {
        await socket.leave(name);
        this.logEvent('realtime.subscription_refused', { reasonCode: 'SESSION_INVALID' });
        return { ok: false, code: 'UNAUTHENTICATED' };
      }
      if (request.data.scope.kind === 'room') {
        // A room's hints go to current members only. The ack carries no revision to catch up from: a room hint says
        // that something changed, and the subscriber rereads.
        if (!(await this.readRoomMembership(caller.accountId, request.data.scope.id))) {
          await socket.leave(name);
          this.logEvent('realtime.subscription_refused', { reasonCode: 'FORBIDDEN' });
          return { ok: false, code: 'FORBIDDEN' };
        }
        return { ok: true, revision: 0 };
      }
      const access = await this.readAccess(caller.accountId, request.data.scope.id);
      if (access === undefined || !access.active || access.privacyEpoch !== caller.privacyEpoch) {
        await socket.leave(name);
        this.logEvent('realtime.subscription_refused', { reasonCode: 'FORBIDDEN' });
        return { ok: false, code: 'FORBIDDEN' };
      }
      this.remember(cacheKey(caller, request.data.scope), 'ok');
      // `universe` and `inbox` are both named by the caller's own universe, so one access check covers either.
      const revision =
        request.data.scope.kind === 'inbox' ? await this.readInboxRevision(caller.accountId) : access.revision;
      return { ok: true, revision };
    } catch (error) {
      await socket.leave(name);
      this.logEvent('realtime.subscription_refused', { reasonCode: 'UNAVAILABLE', error });
      return { ok: false, code: 'UNAVAILABLE' };
    }
  }

  /**
   * One heartbeat from an open, visible app: the person is around. The answer is `{ ok: true }`
   * whether or not the person shares availability, and never says which, so nothing can be learned
   * about the setting from it. A beat is stored only for a person who chose to show availability, and
   * only after the session and the caller's own scope are checked again. Beats closer together than
   * `HEARTBEAT_FLOOR_MS` on one socket are acknowledged without a write. A heartbeat is not consumption
   * evidence and grants nothing.
   */
  @SubscribeMessage(socketEvents.presenceHeartbeat)
  async heartbeat(@ConnectedSocket() socket: Socket): Promise<PresenceHeartbeatAck> {
    const caller = callerOf(socket);
    if (caller === undefined) return { ok: false, code: 'UNAUTHENTICATED' };
    const data = socket.data as { lastBeatAt?: number };
    const now = Date.now();
    if (data.lastBeatAt !== undefined && now - data.lastBeatAt < HEARTBEAT_FLOOR_MS) return { ok: true };
    try {
      if ((await this.authorise(caller, { kind: 'universe', id: caller.universeId })) !== 'ok')
        return { ok: false, code: 'UNAUTHENTICATED' };
      await this.recordHeartbeat(caller.accountId);
      data.lastBeatAt = now;
      return { ok: true };
    } catch (error) {
      this.logEvent('realtime.heartbeat_failed', { reasonCode: 'UNAVAILABLE', error });
      return { ok: false, code: 'UNAVAILABLE' };
    }
  }

  /**
   * A member of a room is typing in a discussion (D-067, D-165). The server uses it for one thing: holding back an AI
   * turn for a few seconds. It records the discussion and a time, never the person or the text, relays it to no one
   * and shows it to no one. The answer is `{ ok: true }` whatever happened (a bad body, a non-member, a stale
   * session), so it cannot be used to learn anything, and hints closer than `TYPING_FLOOR_MS` on one socket are
   * dropped. A hint is not consumption evidence and grants nothing.
   */
  @SubscribeMessage(socketEvents.roomTyping)
  async typing(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<{ ok: true }> {
    const caller = callerOf(socket);
    const hint = RoomTypingSchema.safeParse(body);
    if (caller === undefined || !hint.success) return { ok: true };
    const data = socket.data as { lastTypingAt?: number };
    const now = Date.now();
    if (data.lastTypingAt !== undefined && now - data.lastTypingAt < TYPING_FLOOR_MS) return { ok: true };
    data.lastTypingAt = now;
    try {
      if (await this.callers.sessionValid(caller)) await this.holdCast({ accountId: caller.accountId, ...hint.data });
    } catch (error) {
      this.logEvent('realtime.typing_failed', { reasonCode: 'UNAVAILABLE', error });
    }
    return { ok: true };
  }

  @SubscribeMessage(socketEvents.unsubscribeScope)
  async unsubscribe(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<{ ok: boolean }> {
    const request = SubscribeScopeRequestSchema.safeParse(body);
    if (!request.success) return { ok: false };
    await socket.leave(room(request.data.scope));
    return { ok: true };
  }

  /** Relay sink: one committed change → a hint to each still-authorised socket of that scope. */
  onNotice(notice: ScopeNotice): void {
    this.relayNotice(notice).catch((error: unknown) =>
      this.logEvent('realtime.relay_failed', { reasonCode: 'RELAY_FAILED', error }),
    );
  }

  /**
   * Relay sink: notices may have been lost. At startup (`listening`) every client is asked to
   * refetch. After a reconnect, lost notices may include revocations, so cached authorisations
   * are forgotten and every socket in this process is made to authenticate again: it leaves its
   * rooms at once (no further hint can reach it) and its connection is closed, so the client
   * reconnects, which re-validates its session, and then resubscribes and refetches.
   */
  onResync(reason: 'listening' | 'reconnected'): void {
    if (reason === 'listening') {
      const hint: ScopeResyncHint = { reason };
      this.server.emit(socketEvents.scopeResync, hint);
      return;
    }
    this.authorisations.clear();
    let count = 0;
    for (const socket of this.server.sockets.sockets.values()) {
      for (const name of [...socket.rooms]) if (name !== socket.id) void socket.leave(name);
      socket.conn.close();
      count += 1;
    }
    this.logEvent('realtime.sockets_reauthenticated', { reasonCode: 'relay_reconnected', count });
  }

  /** Relay sink: an account's access was revoked somewhere; drop its sockets in this process. */
  onAccessRevoked(accountId: string): void {
    this.disconnectAccount(accountId);
  }

  /**
   * Disconnects every socket of `accountId` in this API process and forgets its cached
   * authorisations. Other processes do the same when they receive the same revocation notice.
   * Returns how many sockets were disconnected.
   */
  disconnectAccount(accountId: string): number {
    for (const key of [...this.authorisations.keys()])
      if (key.startsWith(`${accountId}:`)) this.authorisations.delete(key);
    let disconnected = 0;
    for (const socket of this.server.sockets.sockets.values()) {
      if (callerOf(socket)?.accountId !== accountId) continue;
      socket.disconnect(true);
      disconnected += 1;
    }
    if (disconnected > 0) this.logEvent('realtime.access_revoked', { count: disconnected });
    return disconnected;
  }

  private async relayNotice(notice: ScopeNotice): Promise<void> {
    const name = room(notice.scope);
    const hint: ScopeChangedHint = { scope: notice.scope, revision: notice.revision, eventId: notice.eventId };
    for (const socket of await this.server.in(name).fetchSockets()) {
      const caller = callerOf(socket);
      const authorisation = caller === undefined ? 'session_invalid' : await this.authorise(caller, notice.scope);
      switch (authorisation) {
        case 'ok':
          socket.emit(socketEvents.scopeChanged, hint);
          break;
        case 'scope_revoked': {
          socket.leave(name);
          const revoked: ScopeRevokedHint = { scope: notice.scope };
          socket.emit(socketEvents.scopeRevoked, revoked);
          this.logEvent('realtime.subscription_refused', { reasonCode: 'REVOKED' });
          break;
        }
        case 'session_invalid':
          socket.disconnect(true);
          this.logEvent('realtime.subscription_refused', { reasonCode: 'SESSION_INVALID' });
          break;
      }
    }
  }

  /** Session validity first, then scope access (a universe's owner, a room's member); cached per session, scope and epoch. */
  private async authorise(caller: Caller, scope: ScopeRef): Promise<Authorisation> {
    // A room's membership is one indexed row and changes when a moderator removes someone, so it is read every time:
    // a removed member gets no further hint. A universe's access is cached, as before.
    const cacheable = scope.kind !== 'room';
    const key = cacheKey(caller, scope);
    const cached = cacheable ? this.authorisations.get(key) : undefined;
    if (cached !== undefined && Date.now() - cached.at < this.config.socketAuthorisationCacheMs) return cached.result;
    let result: Authorisation = 'session_invalid';
    if (await this.callers.sessionValid(caller)) {
      result = (await this.mayHear(caller, scope)) ? 'ok' : 'scope_revoked';
    }
    if (cacheable) this.remember(key, result);
    return result;
  }

  private async mayHear(caller: Caller, scope: ScopeRef): Promise<boolean> {
    if (scope.kind === 'room') return this.readRoomMembership(caller.accountId, scope.id);
    const access = await this.readAccess(caller.accountId, scope.id);
    return access !== undefined && access.active && access.privacyEpoch === caller.privacyEpoch;
  }

  private remember(key: string, result: Authorisation): void {
    if (this.authorisations.size > 10_000) this.authorisations.clear();
    this.authorisations.set(key, { result, at: Date.now() });
  }
}
