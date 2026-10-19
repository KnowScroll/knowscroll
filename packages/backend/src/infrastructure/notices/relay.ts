import pg from 'pg';
import type { DatabaseSettings } from '../config/index.js';
import type { LogEvent } from '../observability/index.js';
import { ACCESS_REVOKED_CHANNEL, AccessRevokedNoticeSchema } from './access-revocation.js';
import { SCOPE_NOTICE_CHANNEL, ScopeNoticeSchema, type ScopeNotice } from './scope-notices.js';

/** Where the relay delivers: currently-connected subscribers in this API process. */
export interface ScopeNoticeSink {
  /** One committed scope change. */
  onNotice(notice: ScopeNotice): void;
  /**
   * The relay (re)established LISTEN after a gap in which notices (hints *and* revocations) may
   * have been lost: subscribers must refetch, and cached authorisations must not be trusted. Also
   * called after the first LISTEN at startup. Always called before any notice received on the new
   * connection is delivered.
   */
  onResync(reason: 'listening' | 'reconnected'): void;
  /** An account's access changed (sign-out, session revocation, epoch change): drop its sockets. */
  onAccessRevoked(accountId: string): void;
}

/** Whether the relay currently holds a working LISTEN connection (reported by `/health`). */
export type RelayState = 'listening' | 'reconnecting';

export interface ScopeNoticeRelayOptions {
  readonly database: DatabaseSettings;
  readonly sink: ScopeNoticeSink;
  readonly logEvent: LogEvent;
  /** First reconnect delay; doubles up to `maxReconnectDelayMs`. */
  readonly reconnectDelayMs?: number;
  readonly maxReconnectDelayMs?: number;
  /** How often the LISTEN connection is probed, so a silently dropped connection is replaced. */
  readonly heartbeatMs?: number;
  /** A probe that has not answered within this time counts as a lost connection. */
  readonly heartbeatTimeoutMs?: number;
}

/**
 * The API's LISTEN relay (blueprint §4): one dedicated connection per API process, outside the
 * pool, listening on the scope-change and access-revocation channels. On any loss (error, end,
 * failed or overdue heartbeat) it keeps retrying with capped exponential backoff for as long as
 * it takes (a database restart or outage of any length), re-issues LISTEN, and then tells the
 * sink to resynchronise, because notices sent while it was away are gone for good.
 */
export class ScopeNoticeRelay {
  private client: pg.Client | undefined;
  private stopped = true;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private attempt = 0;
  private hasListened = false;
  private firstListen: { promise: Promise<void>; resolve: () => void } | undefined;

  constructor(private readonly options: ScopeNoticeRelayOptions) {}

  /** `listening` while a LISTEN connection is up, otherwise `reconnecting`. */
  get state(): RelayState {
    return this.client === undefined ? 'reconnecting' : 'listening';
  }

  /** Starts connecting; resolves once the first LISTEN succeeded (retrying until then). */
  async start(): Promise<void> {
    this.stopped = false;
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    this.firstListen = { promise, resolve };
    this.connectNow();
    await promise;
  }

  /** Stops reconnecting and closes the connection. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.firstListen?.resolve();
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.stopHeartbeat();
    const client = this.client;
    this.client = undefined;
    if (client !== undefined) await client.end().catch(() => undefined);
  }

  /** The backend process ID of the current LISTEN connection (tests terminate it on purpose). */
  async listenerPid(): Promise<number | undefined> {
    const result = await this.client?.query<{ pid: number }>('select pg_backend_pid() as pid');
    return result?.rows[0]?.pid;
  }

  private connectNow(): void {
    this.connect().catch(() => {
      // connect() handles its own failures and sink faults; only a logger fault reaches here.
      // Retry unless a connection was already kept.
      if (this.client === undefined) this.retryLater();
    });
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const { database, logEvent } = this.options;
    const client = new pg.Client({
      connectionString: database.url,
      application_name: `${database.applicationName}-relay`,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
    // Notices that arrive before this connection is adopted (and before the sink was told to
    // resynchronise) are held, so the sink never relays one on cached authorisations.
    const held: pg.Notification[] = [];
    let adopted = false;
    client.on('notification', (message) => {
      if (adopted) this.deliver(message);
      else held.push(message);
    });
    client.on('error', (error) => this.lost(client, 'connection_error', error));
    client.on('end', () => this.lost(client, 'connection_ended'));
    try {
      await client.connect();
      await client.query(`listen ${SCOPE_NOTICE_CHANNEL}`);
      await client.query(`listen ${ACCESS_REVOKED_CHANNEL}`);
    } catch (error) {
      logEvent('relay.disconnected', { reasonCode: 'connect_failed', error });
      client.removeAllListeners();
      client.on('error', () => undefined);
      await client.end().catch(() => undefined);
      this.retryLater();
      return;
    }
    if (this.stopped) {
      await client.end().catch(() => undefined);
      return;
    }
    this.client = client;
    this.attempt = 0;
    this.startHeartbeat(client);
    const reason = this.hasListened ? 'reconnected' : 'listening';
    this.hasListened = true;
    logEvent('relay.listening', { reasonCode: reason });
    this.firstListen?.resolve();
    this.toSink((sink) => sink.onResync(reason));
    adopted = true;
    for (const message of held.splice(0)) this.deliver(message);
  }

  /** Hands one call to the sink. A sink fault is logged and never disturbs the connection. */
  private toSink(call: (sink: ScopeNoticeSink) => void): void {
    try {
      call(this.options.sink);
    } catch (error) {
      this.options.logEvent('relay.sink_failed', { reasonCode: 'sink_threw', error });
    }
  }

  /** The current connection is gone: forget it and schedule a new attempt. Ignores stale clients. */
  private lost(client: pg.Client, reasonCode: string, error?: unknown): void {
    if (this.stopped || this.client !== client) return;
    this.client = undefined;
    this.stopHeartbeat();
    this.options.logEvent('relay.disconnected', { reasonCode, ...(error === undefined ? {} : { error }) });
    client.removeAllListeners('notification');
    client.removeAllListeners('end');
    void client.end().catch(() => undefined);
    this.retryLater();
  }

  /** Schedules the next connection attempt (capped exponential backoff), for as long as needed. */
  private retryLater(): void {
    if (this.stopped || this.reconnectTimer !== undefined) return;
    const base = this.options.reconnectDelayMs ?? 250;
    const max = this.options.maxReconnectDelayMs ?? 5_000;
    const delay = Math.min(max, base * 2 ** Math.min(this.attempt, 16));
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connectNow();
    }, delay);
  }

  private startHeartbeat(client: pg.Client): void {
    this.stopHeartbeat();
    const timeoutMs = this.options.heartbeatTimeoutMs ?? 5_000;
    this.heartbeatTimer = setInterval(() => {
      let timer: NodeJS.Timeout | undefined;
      const overdue = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('relay heartbeat overdue')), timeoutMs);
      });
      Promise.race([client.query('select 1'), overdue])
        .catch((error: unknown) => this.lost(client, 'heartbeat_failed', error))
        .finally(() => clearTimeout(timer));
    }, this.options.heartbeatMs ?? 15_000);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private deliver(message: pg.Notification): void {
    if (message.payload === undefined) return;
    let payload: unknown;
    try {
      payload = JSON.parse(message.payload);
    } catch {
      this.options.logEvent('relay.notice_rejected', { reasonCode: 'invalid_payload' });
      return;
    }
    if (message.channel === SCOPE_NOTICE_CHANNEL) {
      const parsed = ScopeNoticeSchema.safeParse(payload);
      if (parsed.success) this.toSink((sink) => sink.onNotice(parsed.data));
      else this.options.logEvent('relay.notice_rejected', { reasonCode: 'invalid_payload' });
    } else if (message.channel === ACCESS_REVOKED_CHANNEL) {
      const parsed = AccessRevokedNoticeSchema.safeParse(payload);
      if (parsed.success) this.toSink((sink) => sink.onAccessRevoked(parsed.data.accountId));
      else this.options.logEvent('relay.notice_rejected', { reasonCode: 'invalid_payload' });
    }
  }
}
