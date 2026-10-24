import { afterEach, describe, expect, it } from 'vitest';
import { createVisibilitySession } from './visibility-session';
import { friend, id, visitServer } from './test-support/visit-fixture';

let counter = 0;
const newId = () => `0199a000-0000-7000-8000-${(++counter + 9000).toString(16).padStart(12, '0')}`;
const servers: ReturnType<typeof visitServer>[] = [];
async function loaded() {
  const server = visitServer();
  servers.push(server);
  const session = createVisibilitySession({ scope: server.scope, newId });
  await session.load();
  return { server, session };
}
afterEach(() => {
  for (const server of servers.splice(0)) server.scope.end();
});
const commandsTo = (server: ReturnType<typeof visitServer>) =>
  server.requests.filter((request) => request.path === '/v1/social/visibility' && 'commandId' in request.body);

describe('sharing settings session (labelled in-memory server)', () => {
  it('reads the settings, the availability choice and the friends to choose from; nothing is shared by default', async () => {
    const { session } = await loaded();
    const state = session.getState();
    expect(state.load).toBe('ready');
    expect(state.confirmed?.audience).toEqual({ mode: 'nobody' });
    expect(state.draft).toEqual({ mode: 'nobody', friendIds: [], systemIds: [] });
    expect(state.presence).toMatchObject({ preference: 'hidden' });
    expect(state.friends.items.map((person) => person.handle)).toEqual(['fixture.meera', 'fixture.ravi']);
    expect(state.save).toEqual({ status: 'idle' });
  });

  it('says it could not load, rather than showing a page that is not there', async () => {
    const server = visitServer();
    servers.push(server);
    server.failNext('/v1/social/visibility', 'network');
    const session = createVisibilitySession({ scope: server.scope, newId });
    await session.load();
    expect(session.getState().load).toBe('unavailable');
    expect(session.getState().draft).toBeUndefined();
  });

  it('sends the whole page as one command and shows saving, then saved, from the server’s answer', async () => {
    const { server, session } = await loaded();
    const seen: string[] = [];
    session.subscribe(() => seen.push(session.getState().save.status));
    await session.setAudience('all_friends');
    await session.toggleSystem(id(100));
    const [first, second] = commandsTo(server);
    expect(first?.body).toMatchObject({
      audience: { mode: 'all_friends' },
      sharedSystemIds: [],
      expectedVisibilityRevision: 1,
    });
    expect(second?.body).toMatchObject({
      audience: { mode: 'all_friends' },
      sharedSystemIds: [id(100)],
      expectedVisibilityRevision: 2,
    });
    expect(seen).toContain('saving');
    expect(session.getState().save).toEqual({ status: 'saved' });
    expect(session.getState().confirmed?.systems.map((s) => s.shared)).toEqual([true, false]);
    expect(session.getState().confirmed?.visibilityRevision).toBe(3);
  });

  it('shares with nobody until a friend is ticked, and keeps "Friends I choose" selected meanwhile', async () => {
    const { server, session } = await loaded();
    await session.setAudience('chosen_friends');
    expect(commandsTo(server)).toHaveLength(0);
    expect(session.getState().draft?.mode).toBe('chosen_friends');
    await session.toggleFriend(friend.personId);
    expect(commandsTo(server)[0]?.body).toMatchObject({
      audience: { mode: 'chosen_friends', personIds: [friend.personId] },
    });
    await session.toggleFriend(friend.personId);
    expect(commandsTo(server)[1]?.body).toMatchObject({ audience: { mode: 'nobody' } });
    expect(session.getState().draft).toMatchObject({ mode: 'chosen_friends', friendIds: [] });
  });

  it('folds quick changes into one following save instead of racing commands', async () => {
    const { server, session } = await loaded();
    const all = [session.toggleSystem(id(100)), session.toggleSystem(id(101)), session.setAudience('all_friends')];
    await Promise.all(all);
    const commands = commandsTo(server);
    expect(commands.length).toBeLessThanOrEqual(2);
    expect(commands.at(-1)?.body).toMatchObject({
      audience: { mode: 'all_friends' },
      sharedSystemIds: [id(100), id(101)],
    });
    expect(session.getState().save).toEqual({ status: 'saved' });
  });

  it('keeps the page as it was left when the answer is lost, and Retry sends it again from the current revision', async () => {
    const { server, session } = await loaded();
    server.failNext('/v1/social/visibility', 'network');
    await session.toggleSystem(id(100));
    expect(session.getState().save).toEqual({ status: 'failed', reason: 'offline' });
    expect(session.getState().draft?.systemIds).toEqual([id(100)]);
    await session.retry();
    expect(session.getState().save).toEqual({ status: 'saved' });
    expect(session.getState().confirmed?.systems[0]?.shared).toBe(true);
  });

  it('shows what another device set, never silently overwriting it', async () => {
    const { server, session } = await loaded();
    server.changeElsewhere();
    await session.toggleSystem(id(101));
    expect(session.getState().save).toEqual({ status: 'failed', reason: 'stale' });
    expect(session.getState().confirmed?.audience).toEqual({ mode: 'all_friends' });
    expect(session.getState().draft).toMatchObject({ mode: 'all_friends', systemIds: [] });
  });

  it('changes availability with its own revision and shows the confirmed choice', async () => {
    const { server, session } = await loaded();
    await session.setPresence('recently_active');
    expect(session.getState().presence).toMatchObject({ preference: 'recently_active', presencePreferenceRevision: 2 });
    server.failNext('/v1/social/presence/preference', 'network');
    await session.setPresence('online');
    expect(session.getState().save).toEqual({ status: 'failed', reason: 'offline' });
    await session.retry();
    expect(session.getState().presence).toMatchObject({ preference: 'online' });
  });

  it('does nothing once the account scope has ended', async () => {
    const { server, session } = await loaded();
    server.scope.end();
    const before = server.requests.length;
    await session.toggleSystem(id(100));
    expect(server.requests.length).toBe(before);
  });
});
