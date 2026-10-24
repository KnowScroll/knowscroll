import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAvailabilitySession } from './availability-session';
import { friend, friends, visitServer } from './test-support/visit-fixture';

const servers: ReturnType<typeof visitServer>[] = [];
let counter = 0;
function setup(pollMs = 20_000) {
  const server = visitServer();
  servers.push(server);
  const session = createAvailabilitySession({
    scope: server.scope,
    newId: () => `0199a000-0000-7000-8000-${(++counter + 7000).toString(16).padStart(12, '0')}`,
    pollMs,
    now: () => Date.now(),
  });
  return { server, session };
}
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  for (const server of servers.splice(0)) server.scope.end();
  vi.useRealTimers();
});
const online = { state: 'online' as const, expiryRevision: 1, validForMs: 30_000 };

describe('friends’ availability (labelled in-memory server)', () => {
  it('shows the words the server gave, and nothing for unknown', async () => {
    const { server, session } = setup();
    server.setAvailability(friend.personId, online);
    session.setForeground(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(session.wordOf(friend.personId)).toBe('online');
    expect(session.wordOf(friends[1]!.personId)).toBeUndefined();
  });

  it('lets a word lapse at its lease even when no read comes', async () => {
    const { server, session } = setup(120_000);
    server.setAvailability(friend.personId, online);
    session.setForeground(true);
    await vi.advanceTimersByTimeAsync(0);
    const changes: number[] = [];
    session.subscribe(() => changes.push(session.getState().fresh.size));
    await vi.advanceTimersByTimeAsync(29_000);
    expect(session.wordOf(friend.personId)).toBe('online');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(session.wordOf(friend.personId)).toBeUndefined();
    expect(changes).toContain(0);
  });

  it('counts a lease from when the read started, and a lost connection extends nothing', async () => {
    const { server, session } = setup(10_000);
    server.setAvailability(friend.personId, { ...online, validForMs: 25_000 });
    session.setForeground(true);
    await vi.advanceTimersByTimeAsync(0);
    server.failNext('/v1/social/friends/page', 'network', 'network', 'network');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(session.wordOf(friend.personId)).toBeUndefined();
  });

  it('follows a friend who stops showing availability on the very next read', async () => {
    const { server, session } = setup(10_000);
    server.setAvailability(friend.personId, { ...online, validForMs: 60_000 });
    session.setForeground(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(session.wordOf(friend.personId)).toBe('online');
    server.setAvailability(friend.personId, { state: 'unknown' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(session.wordOf(friend.personId)).toBeUndefined();
  });

  it('reads nothing while the screen is in the background', async () => {
    const { server, session } = setup(5_000);
    session.setForeground(true);
    await vi.advanceTimersByTimeAsync(0);
    session.setForeground(false);
    const reads = server.countOf('/v1/social/friends/page');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.countOf('/v1/social/friends/page')).toBe(reads);
  });
});
