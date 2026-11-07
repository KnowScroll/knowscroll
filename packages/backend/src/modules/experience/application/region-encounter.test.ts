import { describe, expect, it, vi } from 'vitest';
import type { PersonalAuthority } from '../../identity/public.js';
import type { NavigationPorts, NavigateEncounter } from './navigation-ports.js';
import { makeRegionEncounters } from './region-encounter.js';
const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const authority: PersonalAuthority = {
  universeId: id(1),
  privacyEpoch: 1,
  actor: { kind: 'account', accountId: id(2) },
};
const target = { kind: 'region' as const, regionId: id(3), expectedObjectRevision: 1, expectedGeographyRevision: 1 };
const capabilities = {
  documentSchemas: ['scroll-document.v1'],
  blocks: { fallback: [1], paragraph: [1], subheading: [1] },
};
const command = { version: 'region-encounter-open.v1' as const, commandId: id(4), target, capabilities };
describe('Region facade closed request boundary (synthetic ports only)', () => {
  it('rejects invalid geometry/authority/extra payloads before opening a scope or navigation', async () => {
    const withPersonalScope = vi.fn(),
      navigate = vi.fn<NavigateEncounter>();
    const f = makeRegionEncounters({ withPersonalScope } as unknown as NavigationPorts, navigate);
    for (const input of [
      { ...command, position: { x: 1 } },
      { ...command, target: { ...target, camera: 3 } },
      { ...command, privacyEpoch: 2 },
      { ...command, target: { ...target, expectedObjectRevision: 0 } },
    ])
      expect(await f.open(authority, input)).toEqual({ kind: 'refused', code: 'INVALID_REQUEST' });
    expect(
      await f.preview(authority, {
        version: 'region-encounter-preview.v1',
        readId: id(5),
        target,
        capabilities,
        commandId: id(4),
      }),
    ).toEqual({ kind: 'refused', code: 'INVALID_REQUEST' });
    expect(withPersonalScope).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
  it('copies claimed authority and preserves exact supplied session constraints', async () => {
    const navigate = vi.fn<NavigateEncounter>(() =>
      Promise.resolve({ kind: 'refused', code: 'INTENT_REVISION_STALE' }),
    );
    const f = makeRegionEncounters({} as NavigationPorts, navigate),
      input = { ...command, session: { sessionId: id(6), expectedIntentRevision: 2 } };
    expect(await f.open(authority, input)).toEqual({ kind: 'refused', code: 'INTENT_REVISION_STALE' });
    expect(navigate).toHaveBeenCalledExactlyOnceWith(authority, input);
    expect(navigate.mock.calls[0]![0]).not.toBe(authority);
    expect(Object.isFrozen(navigate.mock.calls[0]![0])).toBe(true);
  });
});

describe('a region shows one explanation, the leaning format first (#709, D-404)', () => {
  const coverage = { assetId: id(20), assetRevision: 1, headRevision: 1, mappingSha256: 'a'.repeat(64) };
  const encounter = (n: number, kind: 'reel' | 'scroll') => ({
    assetId: id(n),
    assetRevision: 1,
    kind,
    metadata: { kind, title: `${kind} fixture`, summary: '', language: 'en' },
  });
  const scroll = encounter(20, 'scroll'),
    reel = encounter(21, 'reel');
  const constraint = {
    version: 'geography-region-constraint.v1',
    target,
    planetId: id(30),
    planetObjectRevision: 1,
    systemId: id(31),
    topicId: 'earth.seasons',
    facetId: 'earth.seasons.axial-tilt',
    truthStatus: 'factual',
    catalogueVersion: 'content-concepts.v1',
  };
  function ports(over: { prepared?: unknown; hidden?: string[] } = {}) {
    const lock = vi.fn(() => Promise.resolve(true));
    const p = {
      withPersonalScope: (_a: unknown, work: (scope: unknown) => Promise<unknown>) =>
        work({ authority, revisionAtEntry: 3 }).then((value) => ({ kind: 'entered', value })),
      readRegionConstraint: () => Promise.resolve({ kind: 'read', constraint }),
      now: () => new Date('2026-11-07T12:00:00.000Z'),
      readRegionCandidates: () =>
        Promise.resolve({
          kind: 'read',
          candidates: [
            { encounter: scroll, coverage },
            { encounter: reel, coverage },
          ],
          hasMore: false,
        }),
      readHidden: (_s: unknown, ids: readonly string[]) => Promise.resolve(ids.filter((x) => over.hidden?.includes(x))),
      readNotInterested: () => Promise.resolve([]),
      readPrepared: vi.fn(() => Promise.resolve(over.prepared)),
      lockRegionCandidates: lock,
      readExactEncounter: (_s: unknown, ref: { assetId: string }) =>
        Promise.resolve(ref.assetId === reel.assetId ? reel : scroll),
    } as unknown as NavigationPorts;
    return { f: makeRegionEncounters(p, vi.fn<NavigateEncounter>()), lock, p };
  }
  const ask = (f: ReturnType<typeof ports>['f'], alternate?: true) =>
    f.preview(authority, {
      version: 'region-encounter-preview.v1',
      readId: id(5),
      target,
      capabilities: { ...capabilities, documentSchemas: [...capabilities.documentSchemas, 'reel-document.v1'] },
      ...(alternate ? { alternate } : {}),
    });
  const leaning = (reelRate: [number, number], scrollRate: [number, number]) => ({
    topics: [
      {
        topicId: 'earth.seasons',
        activity: 1,
        formats: [
          { kind: 'reel', measured: reelRate[0], qualified: reelRate[1] },
          { kind: 'scroll', measured: scrollRate[0], qualified: scrollRate[1] },
        ],
      },
    ],
  });

  it('shows the Scroll first when nothing says otherwise, with its Reel twin as the alternate, both locked', async () => {
    const { f, lock } = ports();
    const result = await ask(f, true);
    expect(result).toMatchObject({
      kind: 'accepted',
      value: { status: 'available', encounter: { assetId: scroll.assetId }, alternate: { assetId: reel.assetId } },
    });
    expect((lock.mock.calls[0] as unknown as [unknown, { candidates: unknown[] }])[1].candidates).toEqual([
      { ref: { assetId: scroll.assetId, assetRevision: 1 }, coverage },
      { ref: { assetId: reel.assetId, assetRevision: 1 }, coverage },
    ]);
  });

  it('shows the Reel first to a person who finishes more Reels in the topic', async () => {
    const { f } = ports({ prepared: leaning([4, 4], [4, 1]) });
    expect(await ask(f, true)).toMatchObject({
      value: { encounter: { assetId: reel.assetId }, alternate: { assetId: scroll.assetId } },
    });
  });

  it('gives no alternate unless asked, and none for a format the person hid', async () => {
    const plain = await ask(ports({ prepared: leaning([4, 4], [4, 1]) }).f);
    expect(plain).toMatchObject({ value: { encounter: { assetId: reel.assetId } } });
    expect(plain.kind === 'accepted' && 'alternate' in plain.value).toBe(false);
    const hidden = await ask(ports({ hidden: [reel.assetId] }).f, true);
    expect(hidden).toMatchObject({ value: { encounter: { assetId: scroll.assetId } } });
    expect(hidden.kind === 'accepted' && 'alternate' in hidden.value).toBe(false);
  });
});
