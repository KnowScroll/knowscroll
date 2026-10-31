import { describe, expect, it } from 'vitest';
import { problemDetails } from '@knowscroll/contracts';
import { createAccountScope, memoryStore } from './account-scope';
import {
  orbitWords,
  placeLandmarks,
  readCollection,
  type CollectionLandmark,
  type PlanetTopic,
} from './universe-collection';

/** Authored protocol fixtures only. */
const id = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const account = { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'collection@fixture.test' };
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

const landmark = (over: Partial<CollectionLandmark> = {}): CollectionLandmark => ({
  key: 'the-leaning-axis',
  name: 'The Leaning Axis',
  tier: 'gold',
  assetId: id(10),
  revision: 1,
  earnedAt: '2026-11-02T10:00:00.000Z',
  topicId: 'earth.seasons',
  ...over,
});

const answers: Record<string, unknown> = {
  '/v1/play/landmarks/read': { landmarks: [landmark()] },
  '/v1/play/orbit/read': { orbit: { days: 1, goal: 3, weekStart: '2026-11-02', closed: false } },
  '/v1/experience/resume/read': {
    resume: { assetId: id(11), title: 'Why the hemispheres take turns', part: 2, total: 3 },
  },
  '/v1/universe/places/concepts/read': {
    version: 'universe-place-concepts.v1',
    universeId: account.universeId,
    privacyEpoch: 1,
    personalWatermark: 3,
    geography: { revision: 4, structureRevision: 4, activityRevision: 0 },
    planets: [{ id: id(20), topicId: 'earth.seasons' }],
  },
};

function scopeAnswering(over: Record<string, () => Response> = {}) {
  const asked: { path: string; body: unknown }[] = [];
  const scope = createAccountScope({
    account,
    baseUrl: 'https://collection.fixture.test',
    store: memoryStore(),
    authorization: () => undefined,
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : undefined;
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (request?.url ?? '');
      const path = new URL(url).pathname;
      const text = request ? await request.clone().text() : typeof init?.body === 'string' ? init.body : '';
      asked.push({ path, body: text ? JSON.parse(text) : undefined });
      return over[path]?.() ?? json(answers[path]);
    },
  });
  return { scope, asked };
}

describe('reading the collection', () => {
  it('reads the landmarks, the Orbit, the next Part and the planets of the person, with the device time zone', async () => {
    const { scope, asked } = scopeAnswering();
    const read = await readCollection(scope);
    expect(read).toEqual({
      status: 'ready',
      collection: {
        landmarks: [landmark()],
        orbit: { days: 1, goal: 3, weekStart: '2026-11-02', closed: false },
        resume: { assetId: id(11), title: 'Why the hemispheres take turns', part: 2, total: 3 },
        planets: [{ id: id(20), topicId: 'earth.seasons' }],
      },
    });
    expect(asked.map((request) => request.path).sort()).toEqual(Object.keys(answers).sort());
    expect(asked.find((request) => request.path === '/v1/play/orbit/read')?.body).toEqual({
      timeZone: expect.any(String) as string,
    });
  });

  it('leaves a part out when it cannot be read and shows the rest', async () => {
    const { scope } = scopeAnswering({ '/v1/experience/resume/read': () => json(problemDetails('NOT_FOUND'), 404) });
    const read = await readCollection(scope);
    expect(read).toMatchObject({ status: 'ready', collection: { resume: null, landmarks: [landmark()] } });
  });

  it('keeps what the screen showed for a part that cannot be read now, and takes the rest fresh', async () => {
    const shown = await readCollection(scopeAnswering().scope);
    if (shown.status !== 'ready') throw new Error('fixture must read');
    const { scope } = scopeAnswering({
      '/v1/play/landmarks/read': () => json(problemDetails('NOT_FOUND'), 404),
      '/v1/play/orbit/read': () => json({ orbit: { days: 2, goal: 3, weekStart: '2026-11-02', closed: false } }),
      '/v1/experience/resume/read': () => json(problemDetails('NOT_FOUND'), 404),
    });
    const read = await readCollection(scope, undefined, shown.collection);
    expect(read).toMatchObject({
      status: 'ready',
      collection: {
        landmarks: [landmark()],
        orbit: { days: 2 },
        resume: { part: 2 },
        planets: [{ id: id(20), topicId: 'earth.seasons' }],
      },
    });
  });

  it('is unavailable only when nothing could be read, and refuses planets of another universe or epoch', async () => {
    const down = (): Response => json(problemDetails('NOT_FOUND'), 404);
    const none = scopeAnswering(Object.fromEntries(Object.keys(answers).map((path) => [path, down])));
    expect(await readCollection(none.scope)).toEqual({ status: 'unavailable' });
    const foreign = scopeAnswering({
      '/v1/universe/places/concepts/read': () =>
        json({ ...(answers['/v1/universe/places/concepts/read'] as object), universeId: id(3) }),
    });
    expect(await readCollection(foreign.scope)).toMatchObject({ status: 'ready', collection: { planets: [] } });
  });

  it('is unavailable after the scope has ended', async () => {
    const { scope } = scopeAnswering();
    scope.end();
    expect(await readCollection(scope)).toEqual({ status: 'unavailable' });
  });
});

describe('setting landmarks on planets', () => {
  const planets: PlanetTopic[] = [{ id: id(20), topicId: 'earth.seasons' }];

  it('puts a landmark on the planet of its topic once that planet is on the map', () => {
    const placed = placeLandmarks([landmark()], planets, () => true);
    expect([...placed.byPlanet.entries()]).toEqual([[id(20), [landmark()]]]);
    expect(placed.waiting).toEqual([]);
  });

  it('keeps it in the tray until its planet has formed, then attaches it with nothing else changed', () => {
    const before = placeLandmarks([landmark()], [], () => true);
    expect(before.waiting).toEqual([landmark()]);
    expect(before.byPlanet.size).toBe(0);
    const after = placeLandmarks([landmark()], planets, () => true);
    expect(after.waiting).toEqual([]);
    expect(after.byPlanet.get(id(20))).toEqual([landmark()]);
  });

  it('waits when the planet is not on the map yet, or when it has no topic', () => {
    expect(placeLandmarks([landmark()], planets, () => false).waiting).toHaveLength(1);
    const { topicId: _topic, ...noTopic } = landmark();
    expect(placeLandmarks([noTopic], planets, () => true).waiting).toHaveLength(1);
  });

  it('decides by topic alone, not by whether the call was right', () => {
    const plain = landmark({ tier: 'plain', key: 'the-turning-halves', name: 'The Turning Halves' });
    const placed = placeLandmarks([landmark(), plain], planets, () => true);
    expect(placed.byPlanet.get(id(20))).toHaveLength(2);
  });
});

describe('the Orbit in words', () => {
  it('says how many days of three, and nothing about a streak or a loss', () => {
    expect(orbitWords({ days: 1, goal: 3, weekStart: '2026-11-02', closed: false })).toBe(
      'Orbit · 1 of 3 days this week',
    );
    expect(orbitWords({ days: 0, goal: 3, weekStart: '2026-11-02', closed: false })).toBe(
      'Orbit · 0 of 3 days this week',
    );
    expect(orbitWords({ days: 5, goal: 3, weekStart: '2026-11-02', closed: true })).toBe(
      'Orbit · 3 of 3 days this week · closed',
    );
  });
});
