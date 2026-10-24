import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVisitSession } from './visit-session';
import { visitServer } from './test-support/visit-fixture';

const servers: ReturnType<typeof visitServer>[] = [];
function setup(options: { pollMs?: number; staleMs?: number } = {}) {
  const server = visitServer();
  servers.push(server);
  const session = createVisitSession({
    scope: server.scope,
    target: { kind: 'handle', handle: 'fixture.ravi' },
    now: () => Date.now(),
    ...options,
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
const visits = (server: ReturnType<typeof visitServer>) => server.countOf('/v1/social/visits/read');

describe('friend visit session (labelled in-memory server)', () => {
  it('shows the shared list under the owner, with public identities only', async () => {
    const { session } = setup();
    expect(session.getState()).toEqual({ status: 'loading' });
    await session.read();
    const state = session.getState();
    if (state.status !== 'ready') throw new Error('not ready');
    expect(state.owner.displayName).toBe('Ravi fixture');
    expect(state.systems.map((system) => system.label)).toEqual(['Machine learning']);
    expect(state.systems[0]?.planets.map((planet) => planet.label)).toEqual(['Inference and serving', 'Hardware']);
    expect(state.stale).toBe(false);
  });

  it('says "not shared" for a first refusal without claiming anything was ever shown', async () => {
    const { server, session } = setup();
    server.setAllowed(false);
    await session.read();
    expect(session.getState()).toEqual({ status: 'unavailable', wasShown: false, ownerName: undefined });
  });

  it('rereads while the screen is open, so a revocation shows soon, and keeps nothing of the list', async () => {
    const { server, session } = setup({ pollMs: 15_000 });
    session.setForeground(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(session.getState().status).toBe('ready');
    const reads = visits(server);
    server.setAllowed(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(visits(server)).toBe(reads + 1);
    expect(session.getState()).toEqual({ status: 'unavailable', wasShown: true, ownerName: 'Ravi fixture' });
    expect(JSON.stringify(session.getState())).not.toContain('Machine learning');
    // Allowed again later: the list comes back, because the server says so, not because it was cached.
    server.setAllowed(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(session.getState().status).toBe('ready');
  });

  it('stops rereading when the screen goes to the background and when it ends', async () => {
    const { server, session } = setup({ pollMs: 10_000 });
    session.setForeground(true);
    await vi.advanceTimersByTimeAsync(0);
    session.setForeground(false);
    const reads = visits(server);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(visits(server)).toBe(reads);
    session.setForeground(true);
    await vi.advanceTimersByTimeAsync(0);
    session.dispose();
    const afterDispose = visits(server);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(visits(server)).toBe(afterDispose);
    expect(session.getState()).toEqual({ status: 'ended' });
  });

  it('keeps the last list for a short while without an answer, then drops it, so offline cannot hide a revocation', async () => {
    const { server, session } = setup({ pollMs: 10_000, staleMs: 60_000 });
    await session.read();
    server.failNext('/v1/social/visits/read', 'network');
    await vi.advanceTimersByTimeAsync(30_000);
    await session.read();
    expect(session.getState()).toMatchObject({ status: 'ready', stale: true });
    await vi.advanceTimersByTimeAsync(40_000);
    server.failNext('/v1/social/visits/read', 'network');
    await session.read();
    expect(session.getState()).toEqual({ status: 'offline' });
  });

  it('does not start a second read while one is in flight', async () => {
    const { server, session } = setup();
    await Promise.all([session.read(), session.read(), session.read()]);
    expect(visits(server)).toBe(1);
  });

  it('shows a new list when the owner’s published list changes', async () => {
    const { server, session } = setup();
    await session.read();
    server.setWorld([]);
    await session.read();
    expect(session.getState()).toMatchObject({ status: 'ready', systems: [] });
  });
});
