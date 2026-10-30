import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRESENCE_HEARTBEAT_MS, socketEvents } from '@knowscroll/contracts';
import { connectScopeSocket } from './account-scope-socket';
import { id, visitServer } from './test-support/visit-fixture';

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

describe('the scope socket and a room’s hints', () => {
  const roomOne = id(501);
  const roomTwo = id(502);
  const roomSubscriptions = () =>
    fake.sent.filter(
      (entry) =>
        entry.event === socketEvents.subscribeScope &&
        (entry.args[0] as { scope: { kind: string } }).scope.kind === 'room',
    );
  const hint = (roomId: string, revision: number) =>
    fake.handlers.get(socketEvents.scopeChanged)?.({
      scope: { kind: 'room', id: roomId },
      revision,
      eventId: id(900 + revision),
    });

  it('asks for a room only while a screen watches it, and asks again on a new connection', () => {
    const { connection } = connect();
    expect(roomSubscriptions()).toHaveLength(0);
    connection.watchRooms?.([roomOne]);
    expect(roomSubscriptions()).toHaveLength(1);
    connection.watchRooms?.([roomOne]);
    expect(roomSubscriptions()).toHaveLength(1);
    connection.watchRooms?.([]);
    expect(fake.sent.some((entry) => entry.event === socketEvents.unsubscribeScope)).toBe(true);
    connection.watchRooms?.([roomOne]);
    expect(roomSubscriptions()).toHaveLength(2);
    fake.handlers.get('connect')?.();
    expect(roomSubscriptions()).toHaveLength(3);
  });

  it('marks the room’s queries and the open discussions stale on a hint above what it has seen, and nothing else', () => {
    const { server, connection } = connect();
    const invalidate = vi.spyOn(server.scope.queryClient, 'invalidateQueries');
    connection.watchRooms?.([roomOne]);
    invalidate.mockClear();
    hint(roomOne, 1000);
    expect(invalidate.mock.calls.map((call) => call[0]?.queryKey)).toEqual([
      server.scope.queryKey('talk', 'room', roomOne),
      server.scope.queryKey('talk', 'room-discussion'),
    ]);
    // The same revision again, an older one, and a room nobody is watching change nothing.
    invalidate.mockClear();
    hint(roomOne, 1000);
    hint(roomOne, 900);
    hint(roomTwo, 5000);
    expect(invalidate).not.toHaveBeenCalled();
    hint(roomOne, 1001);
    expect(invalidate).toHaveBeenCalledTimes(2);
    connection.close();
  });
});
