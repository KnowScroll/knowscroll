import pg from 'pg';
import type { DatabaseSettings } from '../config/index.js';
import type { LogEvent } from '../observability/index.js';
import { SCOPE_NOTICE_CHANNEL, ScopeNoticeSchema, type ScopeNotice } from './scope-notices.js';

/** Where the relay delivers: currently-connected subscribers in this API process. */
export interface ScopeNoticeSink {
  /** One committed scope change. */
  onNotice(notice: ScopeNotice): void;
  /**
   * The relay (re)established LISTEN after a gap in which hints may have been lost: every
   * subscriber must refetch its scopes. Also called after the first LISTEN at startup.
   */
  onResync(reason: 'listening' | 'reconnected'): void;
}

export interface ScopeNoticeRelayOptions {
  readonly database: DatabaseSettings;
  readonly sink: ScopeNoticeSink;
  readonly logEvent: LogEvent;
  /** First reconnect delay; doubles up to `maxReconnectDelayMs`. */
  readonly reconnectDelayMs?: number;
  readonly maxReconnectDelayMs?: number;
  /** How often the LISTEN connection is probed, so a silently dropped connection is replaced. */
  readonly heartbeatMs?: number;
}

/**
 * The API's LISTEN relay (blueprint §4): one dedicated connection per API process, outside the
 * pool. On any connection loss it reconnects with backoff, re-issues LISTEN, and then tells the
 * sink to resynchronise, because notices sent while it was away are gone for good.
 */
export class ScopeNoticeRelay {
  private client: pg.Client | undefined;
  private stopped = true;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private attempt = 0;
  private hasListened = false;

  constructor(private readonly options: ScopeNoticeRelayOptions) {}

  /** Connects and LISTENs; resolves once the first LISTEN succeeded. Retries until then. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  /** Stops reconnecting and closes the connection. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    const client = this.client;
    this.client = undefined;
    if (client !== undefined) await client.end().catch(() => undefined);
  }

  /** The backend process ID of the current LISTEN connection (tests terminate it on purpose). */
  async listenerPid(): Promise<number | undefined> {
    const result = await this.client?.query<{ pid: number }>('select pg_backend_pid() as pid');
    return result?.rows[0]?.pid;
  }

  private async connect(): Promise<void> {
    const { database, logEvent } = this.options;
    const client = new pg.Client({
      connectionString: database.url,
      application_name: `${database.applicationName}-relay`,
      keepAlive: true,
    });
    client.on('notification', (message) => this.deliver(message));
    client.on('error', (error) => {
      logEvent('relay.disconnected', { error });
      this.scheduleReconnect(client);
    });
    client.on('end', () => this.scheduleReconnect(client));
    try {
      await client.connect();
      await client.query(`listen ${SCOPE_NOTICE_CHANNEL}`);
    } catch (error) {
      logEvent('relay.disconnected', { error });
      await client.end().catch(() => undefined);
      if (!this.hasListened) {
        // First start: keep trying, but surface each failure.
        await new Promise((resolve) => setTimeout(resolve, this.nextDelay()));
        if (!this.stopped) await this.connect();
        return;
      }
      this.scheduleReconnect(client);
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
    this.options.sink.onResync(reason);
  }

  private startHeartbeat(client: pg.Client): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      client.query('select 1').catch((error: unknown) => {
        this.options.logEvent('relay.disconnected', { reasonCode: 'heartbeat_failed', error });
        this.scheduleReconnect(client);
      });
    }, this.options.heartbeatMs ?? 15_000);
    this.heartbeatTimer.unref();
  }

  private scheduleReconnect(client: pg.Client): void {
    if (this.stopped || this.client !== client) return;
    this.client = undefined;
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    client.removeAllListeners('notification');
    void client.end().catch(() => undefined);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.stopped) void this.connect();
    }, this.nextDelay());
  }

  private nextDelay(): number {
    const base = this.options.reconnectDelayMs ?? 250;
    const max = this.options.maxReconnectDelayMs ?? 5_000;
    const delay = Math.min(max, base * 2 ** this.attempt);
    this.attempt += 1;
    return delay;
  }

  private deliver(message: pg.Notification): void {
    if (message.channel !== SCOPE_NOTICE_CHANNEL || message.payload === undefined) return;
    let parsed;
    try {
      parsed = ScopeNoticeSchema.safeParse(JSON.parse(message.payload));
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined || !parsed.success) {
      this.options.logEvent('relay.notice_rejected', { reasonCode: 'invalid_payload' });
      return;
    }
    this.options.sink.onNotice(parsed.data);
  }
}
