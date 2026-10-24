import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { LibrarySeries } from '../domain/library/continuity.js';
import {
  LIBRARY_CONTINUITY_AUTHORITY,
  planRelated,
  planSeries,
  type AdmittedScrolls,
  type ContinuityBatch,
  type StoredContinuity,
} from './plan-library-continuity.js';

const series: LibrarySeries = { id: 'test.series', parts: ['seasons', 'seasons-hemispheres', 'seasons-limits'] };
const ref = (n: number, assetRevision = 1) => ({
  assetId: `00000000-0000-4000-8000-00000000000${String(n)}`,
  assetRevision,
});
const admitted: AdmittedScrolls = new Map([
  ['seasons', ref(1)],
  ['seasons-hemispheres', ref(2)],
  ['seasons-limits', ref(3)],
  ['tides', ref(4)],
]);
/** Equal content, equal id; any stable function will do for the planner. */
const deriveLinkId = (content: string) => createHash('sha256').update(content).digest('hex');
const nothingStored: StoredContinuity = { series: new Map(), activeLinks: [] };

/** What the store would hold after the plan's admission. */
function afterAdmitting(admission: ContinuityBatch['admission']): StoredContinuity {
  return {
    series: new Map(
      admission.series.map((manifest) => [
        manifest.seriesId,
        { seriesRevision: manifest.seriesRevision, units: manifest.units },
      ]),
    ),
    activeLinks: admission.links,
  };
}

describe('planSeries', () => {
  it('admits a manifest and a previous and next link between each pair of neighbours', () => {
    const plan = planSeries(series, admitted, nothingStored, deriveLinkId);
    expect(plan.unpublished).toEqual([]);
    expect(plan.admission.series).toEqual([
      {
        seriesId: 'test.series',
        seriesRevision: 1,
        units: [
          { ...ref(1), part: 1 },
          { ...ref(2), part: 2 },
          { ...ref(3), part: 3 },
        ],
      },
    ]);
    expect(
      plan.admission.links.map((link) => [
        link.source.assetId.slice(-1),
        link.direction,
        link.target.assetId.slice(-1),
      ]),
    ).toEqual([
      ['1', 'next', '2'],
      ['2', 'previous', '1'],
      ['2', 'next', '3'],
      ['3', 'previous', '2'],
    ]);
    const next = plan.admission.links[0]!;
    expect(next).toMatchObject({
      revision: 1,
      authorityReference: LIBRARY_CONTINUITY_AUTHORITY,
      relation: { kind: 'series_step', seriesId: 'test.series', seriesRevision: 1, part: 2 },
    });
  });

  it('admits nothing the second time', () => {
    const first = planSeries(series, admitted, nothingStored, deriveLinkId);
    const second = planSeries(series, admitted, afterAdmitting(first.admission), deriveLinkId);
    expect(second.admission).toEqual({ series: [], links: [] });
    expect(second.unchangedLinks).toBe(4);
  });

  it('skips the whole series, and says which part, while a part is unpublished', () => {
    const missingLast = new Map(admitted);
    missingLast.delete('seasons-limits');
    expect(planSeries(series, missingLast, nothingStored, deriveLinkId)).toMatchObject({
      unpublished: ['seasons-limits'],
      admission: { series: [], links: [] },
    });
  });

  it('follows a republished Scroll with a new series revision and replacement links, not a rewrite', () => {
    const first = planSeries(series, admitted, nothingStored, deriveLinkId);
    const stored = afterAdmitting(first.admission);
    const corrected = new Map(admitted).set('seasons-hemispheres', ref(2, 2));
    const second = planSeries(series, corrected, stored, deriveLinkId);
    expect(second.admission.series[0]).toMatchObject({ seriesRevision: 2 });
    expect(second.admission.links).toHaveLength(4);
    // The first part's next link keeps its slot (same source revision) and so gets the next link revision.
    const replacement = second.admission.links.find((link) => link.source.assetId === ref(1).assetId)!;
    const retired = first.admission.links.find((link) => link.source.assetId === ref(1).assetId)!;
    expect(replacement.revision).toBe(retired.revision + 1);
    expect(replacement.linkId).not.toBe(retired.linkId);
  });
});

describe('planRelated', () => {
  it('admits one related move per published pair and skips one with an unpublished end', () => {
    const plan = planRelated(
      [
        { from: 'seasons', to: 'tides', label: 'A neighbour' },
        { from: 'tides', to: 'greenhouse', label: 'Not published' },
      ],
      admitted,
      nothingStored,
      deriveLinkId,
    );
    expect(plan.admission.links).toHaveLength(1);
    expect(plan.admission.links[0]).toMatchObject({
      direction: 'related',
      relation: { kind: 'related_move', label: 'A neighbour' },
      source: ref(1),
      target: ref(4),
    });
    expect(plan.skipped).toEqual([{ from: 'tides', to: 'greenhouse', unpublished: ['greenhouse'] }]);
  });

  it('replaces a move whose declaration changed and leaves an unchanged one alone', () => {
    const declared = [{ from: 'seasons', to: 'tides', label: 'A neighbour' }] as const;
    const first = planRelated(declared, admitted, nothingStored, deriveLinkId);
    const stored = afterAdmitting(first.admission);
    expect(planRelated(declared, admitted, stored, deriveLinkId).admission.links).toEqual([]);
    const relabelled = planRelated([{ ...declared[0], label: 'Another word' }], admitted, stored, deriveLinkId);
    expect(relabelled.admission.links[0]).toMatchObject({ revision: 2, relation: { label: 'Another word' } });
  });
});
