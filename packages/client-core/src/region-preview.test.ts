import { describe, expect, it, vi } from 'vitest';
import { problemDetails, type RegionEncounterPreviewRequest } from '@knowscroll/contracts';
import { createAccountScope, memoryStore } from './account-scope';
import { createRegionPreviewSession } from './region-preview';
// Authored transport fixtures only: no formed world, approved coverage or real content.
const id = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const account = { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'region@fixture.test' };
const capabilities = { documentSchemas: ['scroll-document.v1'], blocks: { paragraph: [1] } };
const target = { kind: 'region' as const, regionId: id(3), expectedObjectRevision: 1, expectedGeographyRevision: 3 };
const floor = { personalWatermark: 40, geographyRevision: 3 };
function reply(input: RegionEncounterPreviewRequest) {
  return {
    ...input,
    scope: { universeId: account.universeId, privacyEpoch: 1, personalWatermark: 40 },
    geographyRevision: 3,
    recordedAt: '2026-10-22T00:00:00.000Z',
    status: 'available' as const,
    encounter: {
      assetId: id(4),
      assetRevision: 2,
      metadata: { kind: 'scroll' as const, title: 'CI region card', summary: 'Authored fixture only', language: 'en' },
    },
  };
}
function fixture(handler: (input: RegionEncounterPreviewRequest) => unknown = reply) {
  const calls: { path: string; input: RegionEncounterPreviewRequest; signal: AbortSignal }[] = [];
  const store = memoryStore();
  const scope = createAccountScope({
    account,
    store,
    authorization: () => undefined,
    baseUrl: 'https://region.fixture.test',
    fetch: async (request) => {
      const input = (await request.json()) as RegionEncounterPreviewRequest;
      calls.push({ path: new URL(request.url).pathname, input, signal: request.signal });
      const result = await handler(input);
      return result instanceof Response
        ? result
        : new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
    },
  });
  let read = 100;
  return {
    scope,
    calls,
    store,
    session: createRegionPreviewSession({ scope, capabilities, newReadId: () => id(read++) }),
  };
}
describe('scoped pure region preview', () => {
  it('accepts only an exact current card and writes no cache body, storage, command or evidence', async () => {
    const h = fixture();
    await h.session.read(target, floor);
    expect(h.session.getState().status).toBe('available');
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.path).toBe('/v1/experience/region/preview');
    expect(Object.keys(h.calls[0]!.input).sort()).toEqual(['capabilities', 'readId', 'target', 'version']);
    expect(Object.isFrozen(h.session.getState().preview?.encounter.metadata)).toBe(true);
    expect(h.store.keys()).toEqual([]);
    expect(h.scope.queryClient.getQueryCache().getAll()).toEqual([]);
    h.session.cancel();
    expect(h.session.getState()).toEqual({ status: 'idle' });
    h.scope.end();
  });
  it.each(['read', 'region', 'object', 'capabilities', 'universe', 'epoch', 'watermark', 'geography', 'unknown'])(
    'refuses valid-looking wrong %s replies',
    async (field) => {
      const h = fixture((input) => {
        const value = reply(input);
        if (field === 'read') value.readId = id(99);
        if (field === 'region') value.target = { ...value.target, regionId: id(99) };
        if (field === 'object') value.target = { ...value.target, expectedObjectRevision: 2 };
        if (field === 'capabilities')
          value.capabilities = { ...value.capabilities, documentSchemas: ['reel-document.v1'] };
        if (field === 'universe') value.scope.universeId = id(99);
        if (field === 'epoch') value.scope.privacyEpoch = 2;
        if (field === 'watermark') value.scope.personalWatermark = 39;
        if (field === 'geography') value.geographyRevision = 2;
        return field === 'unknown' ? { ...value, camera: { x: 5 } } : value;
      });
      await h.session.read(target, floor);
      expect(h.session.getState()).toEqual({ status: 'unavailable', reason: 'invalid' });
      h.scope.end();
    },
  );
  it('bounds abort-ignoring transports to one running read and one latest selection, and drops old replies', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = fixture(async (input) => {
      if (input.target.regionId === target.regionId) await gate;
      return reply(input);
    });
    const first = h.session.read(target, floor);
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    for (let n = 10; n < 40; n++) void h.session.read({ ...target, regionId: id(n) }, floor);
    expect(h.calls[0]!.signal.aborted).toBe(true);
    expect(h.calls).toHaveLength(1);
    release();
    await first;
    await vi.waitFor(() => expect(h.session.getState().status).toBe('available'));
    expect(h.calls).toHaveLength(2);
    expect(h.session.getState().preview?.target.regionId).toBe(id(39));
    h.scope.end();
  });
  it('purges synchronously before end callbacks can restart work and never shares data between identical-ID scope objects', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = fixture(async (input) => {
      await gate;
      return reply(input);
    });
    const pending = h.session.read(target, floor);
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    h.session.subscribe(() => {
      if (h.session.getState().status === 'ended') void h.session.read(target, floor);
    });
    h.scope.end();
    expect(h.session.getState()).toEqual({ status: 'ended' });
    expect(h.calls[0]!.signal.aborted).toBe(true);
    release();
    await pending;
    expect(h.session.getState()).toEqual({ status: 'ended' });
    const next = fixture();
    expect(next.scope.id).toBe(h.scope.id);
    expect(next.session.getState()).toEqual({ status: 'idle' });
    expect(h.calls).toHaveLength(1);
    next.scope.end();
  });
  it('preserves higher observed watermarks across cancel and reports unsupported backend honestly', async () => {
    let newer = true;
    const h = fixture((input) => ({
      ...reply(input),
      scope: { ...reply(input).scope, personalWatermark: newer ? 50 : 40 },
    }));
    await h.session.read(target, floor);
    h.session.cancel();
    newer = false;
    await h.session.read(target, floor);
    expect(h.session.getState().reason).toBe('invalid');
    h.scope.end();
    const absent = fixture(
      () =>
        new Response(JSON.stringify(problemDetails('NOT_FOUND')), {
          status: 404,
          headers: { 'content-type': 'application/problem+json' },
        }),
    );
    await absent.session.read(target, floor);
    expect(absent.session.getState()).toEqual({ status: 'unavailable', reason: 'temporarily_unavailable' });
    expect(absent.calls).toHaveLength(1);
    absent.scope.end();
  });
});
