import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRESENCE_HEARTBEAT_MS, socketEvents } from '@knowscroll/contracts';
import { connectScopeSocket } from './account-scope-socket';
import { visitServer } from './test-support/visit-fixture';

/** A labelled stand-in for the Socket.IO client: it records what the app says and lets a test connect it. */
const fake = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const sent: { event: string; args: unknown[] }[] = [];
  const socket = {
    connected: false,
    on(event: string, handler: (...args: unknown[]) => void) {
      handlers.set(event, handler);
      return socket;
    },
    emit(event: string, ...args: unknown[]) {
      sent.push({ event, args });
      return socket;
    },
    removeAllListeners() {
      handlers.clear();
    },
    close() {
      socket.connected = false;
    },
  };
  return { handlers, sent, socket };
});
vi.mock('socket.io-client', () => ({ io: () => fake.socket }));

const heartbeats = () => fake.sent.filter((entry) => entry.event === socketEvents.presenceHeartbeat);
const context = (visible?: () => boolean) => ({
  baseUrl: 'https://socket.fixture.test',
  bearerToken: () => undefined,
  onRevoked: () => undefined,
  onMismatch: () => undefined,
  ...(visible === undefined ? {} : { visible }),
});
function connect(visible?: () => boolean) {
  const server = visitServer();
  const connection = connectScopeSocket(server.scope, context(visible));
  fake.socket.connected = true;
  fake.handlers.get('connect')?.();
  return { server, connection };
}
beforeEach(() => {
  vi.useFakeTimers();
  fake.sent.length = 0;
  fake.handlers.clear();
  fake.socket.connected = false;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the scope socket’s heartbeat', () => {
  it('says the person is around when it connects and then every interval', () => {
    const { connection } = connect();
    expect(heartbeats()).toHaveLength(1);
    vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS * 3);
    expect(heartbeats()).toHaveLength(4);
    connection.close();
  });

  it('sends nothing while the app is not visible', () => {
    let visible = false;
    const { connection } = connect(() => visible);
    vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS * 2);
    expect(heartbeats()).toHaveLength(0);
    visible = true;
    vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS);
    expect(heartbeats()).toHaveLength(1);
    connection.close();
  });

  it('stops when the connection drops and when the scope’s socket is closed', () => {
    const { connection } = connect();
    fake.socket.connected = false;
    fake.handlers.get('disconnect')?.('transport close');
    vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS * 5);
    expect(heartbeats()).toHaveLength(1);
    fake.socket.connected = true;
    fake.handlers.get('connect')?.();
    expect(heartbeats()).toHaveLength(2);
    connection.close();
    vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS * 5);
    expect(heartbeats()).toHaveLength(2);
  });

  it('stops once the account scope has ended', () => {
    const { server, connection } = connect();
    server.scope.end();
    vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS * 3);
    expect(heartbeats()).toHaveLength(1);
    connection.close();
  });
});
