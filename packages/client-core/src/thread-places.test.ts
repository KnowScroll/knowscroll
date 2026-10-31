import { describe, expect, it } from 'vitest';
import type { ContentThreadRef, ThreadPlace } from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import { createThreadPlaces } from './thread-places';

const id = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const thread: ContentThreadRef = { threadId: id(1), membershipId: id(2), membershipRevision: 1 };
const me = { kind: 'person' as const, personId: id(10), handle: 'ci.asha', displayName: 'Asha fixture' };
const offline = () => new TypeError('network');

/** A server of one thread's places, as far as the client needs: it keeps the caller's own place and switch. */
function fakeServer(options: { hidden?: boolean } = {}) {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const own: { place?: { part: number; state: 'on' | 'finished' }; hidden: boolean } = {
    hidden: options.hidden ?? false,
  };
  const failures: { setPlace: unknown[]; places: unknown[]; setPlaceHidden: unknown[] } = {
    setPlace: [],
    places: [],
    setPlaceHidden: [],
  };
  const take = (name: keyof typeof failures) => {
    const failure = failures[name].shift();
    if (failure !== undefined) throw failure as Error;
  };
  const threads = {
    places: (input: Record<string, unknown>) => {
      calls.push({ name: 'places', input });
      take('places');
      const places: ThreadPlace[] =
        own.place === undefined || own.hidden
          ? []
          : [{ person: me, you: true, part: own.place.part, state: own.place.state, day: '2026-10-24' }];
      return Promise.resolve({ status: 'ready', thread, hidden: own.hidden, places });
    },
    setPlace: (input: Record<string, unknown>) => {
      calls.push({ name: 'setPlace', input });
      take('setPlace');
      if (!own.hidden) own.place = { part: input['part'] as number, state: input['state'] as 'on' | 'finished' };
      return Promise.resolve({ result: own.hidden ? 'hidden' : 'stored' });
    },
    setPlaceHidden: (input: Record<string, unknown>) => {
      calls.push({ name: 'setPlaceHidden', input });
      take('setPlaceHidden');
      own.hidden = input['hidden'] as boolean;
      if (own.hidden) delete own.place;
      return Promise.resolve({ hidden: own.hidden, changed: true });
    },
  };
  const scope = { active: true, api: { threads } } as unknown as AccountScope;
  return { scope, calls, own, failures, sent: () => calls.filter((call) => call.name === 'setPlace') };
}

let counter = 1000;
const newId = () => id(counter++);

describe('a thread’s places on the client', () => {
  it('reads who shares where, and which switch this person has', async () => {
    const server = fakeServer();
    server.own.place = { part: 2, state: 'on' };
    const controller = createThreadPlaces({ scope: server.scope, thread, newId });
    expect(controller.getState().phase).toBe('loading');
    await controller.load();
    expect(controller.getState()).toMatchObject({ phase: 'ready', hidden: false, places: [{ part: 2, you: true }] });
  });

  it('tells the thread where this person is when they open a part, once, and only further on', async () => {
    const server = fakeServer();
    const controller = createThreadPlaces({ scope: server.scope, thread, newId });
    await controller.report(1, 'on');
    await controller.report(1, 'on');
    expect(server.sent().map((call) => call.input)).toEqual([expect.objectContaining({ part: 1, state: 'on' })]);
    await controller.report(1, 'finished');
    await controller.report(1, 'on');
    await controller.report(2, 'on');
    expect(server.sent().map((call) => [call.input['part'], call.input['state']])).toEqual([
      [1, 'on'],
      [1, 'finished'],
      [2, 'on'],
    ]);
    // After each report the places are read again, so the person's own face appears at once.
    expect(controller.getState().places).toMatchObject([{ part: 2, state: 'on', you: true }]);
  });

  it('sends only a part and a state: no time, position, branch or selection', async () => {
    const server = fakeServer();
    const controller = createThreadPlaces({ scope: server.scope, thread, newId });
    await controller.report(2, 'finished');
    const [call] = server.sent();
    expect(Object.keys(call!.input).toSorted()).toEqual(['commandId', 'part', 'state', 'thread', 'version']);
  });

  it('sends nothing while this person hides, and sends where they last were when they show it again', async () => {
    const server = fakeServer({ hidden: true });
    const controller = createThreadPlaces({ scope: server.scope, thread, newId });
    await controller.report(1, 'on');
    await controller.report(2, 'on');
    expect(server.sent()).toEqual([]);
    expect(await controller.setHidden(false)).toBe(true);
    expect(server.sent().map((call) => call.input['part'])).toEqual([2]);
    expect(controller.getState()).toMatchObject({ hidden: false, places: [{ part: 2, you: true }] });
  });

  it('hiding removes the place and a later show sends it again, even the same part', async () => {
    const server = fakeServer();
    const controller = createThreadPlaces({ scope: server.scope, thread, newId });
    await controller.report(2, 'on');
    expect(await controller.setHidden(true)).toBe(true);
    expect(controller.getState()).toMatchObject({ hidden: true, places: [] });
    expect(await controller.setHidden(false)).toBe(true);
    expect(server.sent().map((call) => call.input['part'])).toEqual([2, 2]);
  });

  it('retries a lost hide with the same command, and a new one for the other state', async () => {
    const server = fakeServer();
    const controller = createThreadPlaces({ scope: server.scope, thread, newId });
    await controller.load();
    server.failures.setPlaceHidden.push(offline());
    expect(await controller.setHidden(true)).toBe(false);
    expect(await controller.setHidden(true)).toBe(true);
    const hides = server.calls.filter((call) => call.name === 'setPlaceHidden');
    expect(hides[0]!.input['commandId']).toBe(hides[1]!.input['commandId']);
    expect(await controller.setHidden(false)).toBe(true);
    expect(server.calls.filter((call) => call.name === 'setPlaceHidden')[2]!.input['commandId']).not.toBe(
      hides[0]!.input['commandId'],
    );
  });

  it('never throws at the player: a lost report is sent again by the next load', async () => {
    const server = fakeServer();
    const controller = createThreadPlaces({ scope: server.scope, thread, newId });
    await controller.load();
    server.failures.setPlace.push(offline());
    await expect(controller.report(1, 'on')).resolves.toBeUndefined();
    expect(server.own.place).toBeUndefined();
    await controller.load();
    expect(server.own.place).toEqual({ part: 1, state: 'on' });
  });

  it('keeps going without places when the read fails, and keeps what it had when a later read fails', async () => {
    const server = fakeServer();
    server.failures.places.push(offline());
    const controller = createThreadPlaces({ scope: server.scope, thread, newId });
    await controller.load();
    expect(controller.getState().phase).toBe('failed');
    await controller.load();
    expect(controller.getState().phase).toBe('ready');
    server.failures.places.push(offline());
    await controller.load();
    expect(controller.getState().phase).toBe('ready');
  });

  it('shows nothing for a thread the server says is not available', async () => {
    const server = fakeServer();
    const threads = server.scope.api.threads as unknown as { places: () => Promise<unknown> };
    threads.places = () => Promise.resolve({ status: 'unavailable' });
    const controller = createThreadPlaces({ scope: server.scope, thread, newId });
    await controller.load();
    expect(controller.getState()).toMatchObject({ phase: 'unavailable', places: [] });
    await controller.report(1, 'on');
    expect(server.sent()).toEqual([]);
  });
});
