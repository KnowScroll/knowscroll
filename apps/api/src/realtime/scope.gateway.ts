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
  SOCKET_PATH,
  SubscribeScopeRequestSchema,
  socketEvents,
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
import { READ_INBOX_REVISION, type ReadInboxRevision } from '@knowscroll/backend/modules/social';
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

function cacheKey(caller: Caller, universeId: string): string {
  return `${caller.accountId}:${caller.sessionId}:${universeId}:${caller.privacyEpoch}`;
}

/**
 * Socket.IO gateway for live hints (blueprint §4, §7): authenticated connections, authorised
 * `subscribe_scope`/`unsubscribe_scope` (the caller's `universe` and `inbox` scopes, both named by
 * their own universe), and `scope_changed`/`scope_resync`/`scope_revoked` hints
 * from the LISTEN relay. There are no socket commands; durable state is read over HTTP.
 *
 * Room membership is a delivery aid, never authority:
 * - every subscribe joins first and then checks the caller's session validity and current access
 *   (so a change committed between the read and the join cannot be missed), and leaves again
 *   when either is refused;
 * - every relayed hint is re-authorised per socket — session validity and scope access, cached at
 *   most `KS_SOCKET_AUTH_CACHE_MS` (≤ 30 s) per session, scope and epoch; a socket whose access no
 *   longer holds leaves the room and is told `scope_revoked`; one whose session is no longer valid
 *   is disconnected;
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
      const access = await this.readAccess(caller.accountId, request.data.scope.id);
      if (access === undefined || !access.active || access.privacyEpoch !== caller.privacyEpoch) {
        await socket.leave(name);
        this.logEvent('realtime.subscription_refused', { reasonCode: 'FORBIDDEN' });
        return { ok: false, code: 'FORBIDDEN' };
      }
      this.remember(cacheKey(caller, request.data.scope.id), 'ok');
      // Both scopes are named by the caller's own universe, so one access check covers either.
      const revision =
        request.data.scope.kind === 'inbox' ? await this.readInboxRevision(caller.accountId) : access.revision;
      return { ok: true, revision };
    } catch (error) {
      await socket.leave(name);
      this.logEvent('realtime.subscription_refused', { reasonCode: 'UNAVAILABLE', error });
      return { ok: false, code: 'UNAVAILABLE' };
    }
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
      const authorisation = caller === undefined ? 'session_invalid' : await this.authorise(caller, notice.scope.id);
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

  /** Session validity first, then scope access; cached per session, scope and epoch. */
  private async authorise(caller: Caller, universeId: string): Promise<Authorisation> {
    const key = cacheKey(caller, universeId);
    const cached = this.authorisations.get(key);
    if (cached !== undefined && Date.now() - cached.at < this.config.socketAuthorisationCacheMs) return cached.result;
    let result: Authorisation = 'session_invalid';
    if (await this.callers.sessionValid(caller)) {
      const access = await this.readAccess(caller.accountId, universeId);
      result =
        access !== undefined && access.active && access.privacyEpoch === caller.privacyEpoch ? 'ok' : 'scope_revoked';
    }
    this.remember(key, result);
    return result;
  }

  private remember(key: string, result: Authorisation): void {
    if (this.authorisations.size > 10_000) this.authorisations.clear();
    this.authorisations.set(key, { result, at: Date.now() });
  }
}
