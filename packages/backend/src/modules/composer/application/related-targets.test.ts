import { describe, expect, it } from 'vitest';
import type { ContinuityLink, EncounterRef, EncounterSnapshot, ReadContinuations } from '../../content/public.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import { readRelatedAssetIds } from './related-targets.js';

/** Labelled CI inputs: a fake continuity store and encounter snapshots, no database. */
const scope = {} as PersonalScopeTx;

function encounter(
  assetId: string,
  options: { readonly seriesId?: string; readonly twin?: string; readonly unit?: string } = {},
): EncounterSnapshot {
  return {
    assetId,
    assetRevision: 1,
    kind: options.twin ? 'reel' : 'scroll',
    explanationUnitId: options.unit ?? `unit-${assetId}`,
    metadata: { kind: options.twin ? 'reel' : 'scroll', title: assetId, summary: '', language: 'en' },
    topics: [],
    facets: [],
    siblings: options.twin ? [{ assetId: options.twin, assetRevision: 1, kind: 'scroll' }] : [],
    ...(options.seriesId ? { series: { seriesId: options.seriesId, seriesRevision: 1, part: 1 } } : {}),
    catalogWatermark: 'w',
    attributionVersion: 'taxonomy',
  };
}

function link(source: string, target: string, direction: ContinuityLink['direction']): ContinuityLink {
  return {
    linkId: `${source}->${target}`,
    revision: 1,
    source: { assetId: source, assetRevision: 1 },
    target: { assetId: target, assetRevision: 1 },
    direction,
    relation: direction === 'related' ? { kind: 'related_move', label: 'CI' } : { kind: 'series_step', part: 2 },
    strength: 1,
    authorityReference: 'ci',
  } as ContinuityLink;
}

const storeOf =
  (links: readonly ContinuityLink[]): ReadContinuations =>
  (_scope, source: EncounterRef) =>
    Promise.resolve(links.filter((candidate) => candidate.source.assetId === source.assetId));

describe('the assets the Related tab of the thread reaches (labelled CI inputs)', () => {
  const links = [
    link('part-3', 'limits', 'related'),
    link('part-1', 'part-2', 'next'),
    link('other-part', 'elsewhere-target', 'related'),
    link('scroll-twin', 'twin-target', 'related'),
  ];

  it('collects the related target of any part of the source series, not only the part the person is on', async () => {
    const source = encounter('part-1', { seriesId: 'thread' });
    const candidates = [encounter('part-2', { seriesId: 'thread' }), encounter('part-3', { seriesId: 'thread' })];
    expect(await readRelatedAssetIds(storeOf(links), scope, source, candidates)).toEqual(['limits']);
  });

  it('leaves out series steps, the related moves of another series and of unrelated candidates', async () => {
    const source = encounter('part-1', { seriesId: 'thread' });
    const candidates = [
      encounter('part-3', { seriesId: 'thread' }),
      encounter('other-part', { seriesId: 'another' }),
      encounter('stranger'),
    ];
    expect(await readRelatedAssetIds(storeOf(links), scope, source, candidates)).toEqual(['limits']);
  });

  it('counts the continuity of the source itself and of its format twin, so a Reel counts what its Scroll has', async () => {
    const reel = encounter('reel', { twin: 'scroll-twin' });
    expect(await readRelatedAssetIds(storeOf(links), scope, reel, [])).toEqual(['twin-target']);
    const own = encounter('part-3');
    expect(await readRelatedAssetIds(storeOf(links), scope, own, [])).toEqual(['limits']);
  });

  it('lets a Reel take the series of its Scroll twin among the candidates, and so the related move of Part 3', async () => {
    const reel = encounter('reel-part-1', { twin: 'part-1', unit: 'unit-part-1' });
    const candidates = [
      encounter('part-1', { seriesId: 'thread', unit: 'unit-part-1' }),
      encounter('part-3', { seriesId: 'thread' }),
    ];
    expect(await readRelatedAssetIds(storeOf(links), scope, reel, candidates)).toEqual(['limits']);
    // Without the twin among the candidates the series is unknown and Part 3 is not read.
    expect(await readRelatedAssetIds(storeOf(links), scope, reel, candidates.slice(1))).toEqual([]);
  });

  it('names nothing for a source with no related move, without reading more than it must', async () => {
    let reads = 0;
    const counting: ReadContinuations = (...args) => {
      reads += 1;
      return storeOf(links)(...args);
    };
    expect(await readRelatedAssetIds(counting, scope, encounter('lonely'), [encounter('stranger')])).toEqual([]);
    expect(reads).toBe(1);
  });

  it('reads a bounded number of parts', async () => {
    let reads = 0;
    const counting: ReadContinuations = (...args) => {
      reads += 1;
      return storeOf([])(...args);
    };
    const parts = Array.from({ length: 30 }, (_, index) => encounter(`p-${String(index)}`, { seriesId: 'thread' }));
    await readRelatedAssetIds(counting, scope, encounter('part-1', { seriesId: 'thread' }), parts);
    expect(reads).toBeLessThanOrEqual(8);
  });
});
