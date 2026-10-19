import { Inject } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  type OnGatewayInit,
} from '@nestjs/websockets';
import type { Kysely } from 'kysely';
import type { Server, Socket } from 'socket.io';
import {
  SOCKET_PATH,
  SubscribeScopeRequestSchema,
  socketEvents,
  type ScopeChangedHint,
  type ScopeRef,
  type ScopeResyncHint,
  type SubscribeScopeAck,
} from '@knowscroll/contracts';
import type { ScopeNotice, ScopeNoticeSink } from '@knowscroll/backend/infrastructure/notices';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { CALLERS, DATABASE, LOG_EVENT } from '../tokens.js';
import type { AuthenticatedCallers, Caller } from '../http/callers.js';

function room(scope: ScopeRef): string {
  return `scope:${scope.kind}:${scope.id}`;
}

/**
 * Socket.IO gateway for live hints (blueprint §4, §7): authenticated connections, authorised
 * `subscribe_scope`/`unsubscribe_scope`, and `scope_changed`/`scope_resync` hints from the LISTEN
 * relay. There are no socket commands; durable state is read over HTTP. Room membership is a
 * delivery aid, never authority: access is rechecked against the database on every subscribe.
 */
@WebSocketGateway({ path: SOCKET_PATH, serveClient: false })
export class ScopeGateway implements OnGatewayInit, ScopeNoticeSink {
  @WebSocketServer() private server!: Server;

  constructor(
    @Inject(CALLERS) private readonly callers: AuthenticatedCallers,
    @Inject(DATABASE) private readonly db: Kysely<Database>,
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
    const connected = (socket.data as { caller?: Caller }).caller;
    if (connected === undefined) return { ok: false, code: 'UNAUTHENTICATED' };
    // Current access, not the access at connect time.
    const universe = await this.db
      .selectFrom('identity.universes as universe')
      .innerJoin('identity.accounts as account', 'account.id', 'universe.account_id')
      .select(['universe.revision', 'universe.status', 'universe.privacy_epoch', 'account.status as account_status'])
      .where('universe.id', '=', request.data.scope.id)
      .where('universe.account_id', '=', connected.accountId)
      .executeTakeFirst();
    if (
      universe === undefined ||
      universe.status !== 'active' ||
      universe.account_status !== 'active' ||
      universe.privacy_epoch !== connected.privacyEpoch
    ) {
      this.logEvent('realtime.subscription_refused', { reasonCode: 'FORBIDDEN' });
      return { ok: false, code: 'FORBIDDEN' };
    }
    await socket.join(room(request.data.scope));
    return { ok: true, revision: universe.revision };
  }

  @SubscribeMessage(socketEvents.unsubscribeScope)
  async unsubscribe(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<{ ok: boolean }> {
    const request = SubscribeScopeRequestSchema.safeParse(body);
    if (!request.success) return { ok: false };
    await socket.leave(room(request.data.scope));
    return { ok: true };
  }

  /** Relay sink: one committed change → a hint to that scope's room. */
  onNotice(notice: ScopeNotice): void {
    const hint: ScopeChangedHint = { scope: notice.scope, revision: notice.revision, eventId: notice.eventId };
    this.server.to(room(notice.scope)).emit(socketEvents.scopeChanged, hint);
  }

  /** Relay sink: hints may have been lost; every client refetches its subscribed scopes. */
  onResync(reason: 'listening' | 'reconnected'): void {
    const hint: ScopeResyncHint = { reason };
    this.server.emit(socketEvents.scopeResync, hint);
  }
}
