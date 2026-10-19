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
import { API_CONFIG, CALLERS, LOG_EVENT } from '../tokens.js';
import type { AuthenticatedCallers, Caller } from '../http/callers.js';

function room(scope: ScopeRef): string {
  return `scope:${scope.kind}:${scope.id}`;
}

function callerOf(socket: { readonly data: unknown }): Caller | undefined {
  return (socket.data as { caller?: Caller } | undefined)?.caller;
}

/**
 * Socket.IO gateway for live hints (blueprint §4, §7): authenticated connections, authorised
 * `subscribe_scope`/`unsubscribe_scope`, and `scope_changed`/`scope_resync`/`scope_revoked` hints
 * from the LISTEN relay. There are no socket commands; durable state is read over HTTP.
 *
 * Room membership is a delivery aid, never authority:
 * - every subscribe joins first and then reads current access (so a change committed between the
 *   read and the join cannot be missed), and leaves again when access is refused;
 * - every relayed hint is re-authorised per socket (cached at most `KS_SOCKET_AUTH_CACHE_MS`, ≤ 30 s);
 *   a socket whose access no longer holds is dropped from the room and told `scope_revoked`;
 * - an access-revocation notice (`revokeAccountSockets`, S1.3 sign-out / session revocation /
 *   epoch change) disconnects every socket of that account at once.
 */
@WebSocketGateway({ path: SOCKET_PATH, serveClient: false })
export class ScopeGateway implements OnGatewayInit, ScopeNoticeSink {
  @WebSocketServer() private server!: Server;
  private readonly authorisations = new Map<string, { readonly ok: boolean; readonly at: number }>();

  constructor(
    @Inject(CALLERS) private readonly callers: AuthenticatedCallers,
    @Inject(READ_UNIVERSE_ACCESS) private readonly readAccess: ReadUniverseAccess,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(LOG_EVENT) private readonly logEvent: LogEvent,
  ) {}

  afterInit(server: Server): void {
    server.use((socket, next) => {
      const token: unknown = (socket.handshake.auth as { token?: unknown }).token;
      this.callers.resolve(typeof token === 'string' ? `Bearer ${token}` : undefined).then(
        (caller) => {
          if (caller === undefined) {
            this.logEvent('realtime.connection_refused', { reasonCode: 'UNAUTHENTICATED' });
            next(new Error('UNAUTHENTICATED'));
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
      const access = await this.readAccess(caller.accountId, request.data.scope.id);
      if (access === undefined || !access.active || access.privacyEpoch !== caller.privacyEpoch) {
        await socket.leave(name);
        this.logEvent('realtime.subscription_refused', { reasonCode: 'FORBIDDEN' });
        return { ok: false, code: 'FORBIDDEN' };
      }
      this.remember(caller, request.data.scope.id, true);
      return { ok: true, revision: access.revision };
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
      this.logEvent('realtime.subscription_refused', { reasonCode: 'RELAY_FAILED', error }),
    );
  }

  /** Relay sink: hints may have been lost; every client refetches its subscribed scopes. */
  onResync(reason: 'listening' | 'reconnected'): void {
    const hint: ScopeResyncHint = { reason };
    this.server.emit(socketEvents.scopeResync, hint);
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
      if (caller !== undefined && (await this.stillAuthorised(caller, notice.scope.id))) {
        socket.emit(socketEvents.scopeChanged, hint);
        continue;
      }
      socket.leave(name);
      const revoked: ScopeRevokedHint = { scope: notice.scope };
      socket.emit(socketEvents.scopeRevoked, revoked);
      this.logEvent('realtime.subscription_refused', { reasonCode: 'REVOKED' });
    }
  }

  private async stillAuthorised(caller: Caller, universeId: string): Promise<boolean> {
    const key = `${caller.accountId}:${universeId}:${caller.privacyEpoch}`;
    const cached = this.authorisations.get(key);
    if (cached !== undefined && Date.now() - cached.at < this.config.socketAuthorisationCacheMs) return cached.ok;
    const access = await this.readAccess(caller.accountId, universeId);
    const ok = access !== undefined && access.active && access.privacyEpoch === caller.privacyEpoch;
    this.remember(caller, universeId, ok);
    return ok;
  }

  private remember(caller: Caller, universeId: string, ok: boolean): void {
    if (this.authorisations.size > 10_000) this.authorisations.clear();
    this.authorisations.set(`${caller.accountId}:${universeId}:${caller.privacyEpoch}`, { ok, at: Date.now() });
  }
}
