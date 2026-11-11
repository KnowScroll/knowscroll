import { describe, expect, it } from 'vitest';
import type { PersonalScopeTx } from '../../identity/public.js';
import type { CoverageHead, ReadingFacts } from '../../content/public.js';
import type { CoverageEvidence } from '../domain/coverage.js';
import type { CoverageExposure, ObservedCoveragePorts } from './coverage-ports.js';
import { makePrepareObservedCoverage } from './prepare-coverage.js';

const hash = (value: unknown) => `${JSON.stringify(value).length.toString(16).padStart(64, '0')}`;
const sameHash = 'a'.repeat(64);
const scope = {
  authority: { universeId: '30000000-0000-4000-8000-000000000001', privacyEpoch: 1 },
} as unknown as PersonalScopeTx;
const durationMs = 30_000;
const reelFacts: ReadingFacts = {
  v: 2,
  reelDurationMs: durationMs,
  measuresVersion: 'reel-duration.v1',
  totalWeight: 0,
  estimatedReadingMs: durationMs,
  blocks: [],
  nested: [],
};
const identity = {
  documentSha256: sameHash,
  provenanceSha256: sameHash,
  explanationUnitId: 'fixture-unit',
  framing: 'factual',
  framingSha256: sameHash,
  readingFactsVersion: 2,
  readingFactsSha256: sameHash,
  catalogueVersion: 'content-concepts.v1',
  catalogueSha256: sameHash,
} as const;
const reelBinding = {
  topicId: 'earth.seasons',
  facetId: 'earth.seasons.axial-tilt',
  meaningSha256: sameHash,
  requiredBlockIds: ['s1', 's3', 's6'],
  requiredSpans: [
    [0, 4000],
    [10_000, 14_000],
    [24_000, 30_000],
  ] as [number, number][],
};
const assetId = '20000000-0000-4000-8000-000000000002';
const headOf = (
  version: CoverageHead['mapping']['version'],
  bindings: CoverageHead['mapping']['bindings'],
): CoverageHead => ({
  authority: { assetId, assetRevision: 1, headRevision: 1, mappingSha256: sameHash },
  status: 'active',
  mapping: { version, ...identity, bindings },
  commandSha256: sameHash,
  semanticReviewReference: 'fixture',
});
const exposure = (kind: 'reel' | 'scroll'): CoverageExposure => ({
  exposureId: '40000000-0000-4000-8000-000000000001',
  assetId,
  assetRevision: 1,
  activatedAt: '2026-10-20T00:00:00.000Z',
  kind,
  explanationUnitId: 'fixture-unit',
  recordingGeneration: 1,
  qualificationId: '10000000-0000-4000-8000-000000000002',
});
const reelEvidence = (over: Partial<CoverageEvidence> = {}): CoverageEvidence => ({
  id: '10000000-0000-4000-8000-000000000002',
  revision: 1,
  inputWatermark: 2,
  policyVersion: 'reel-qualification.recording.v1',
  assetId,
  assetRevision: 1,
  qualification: 'qualified',
  q: 1,
  coverage: 1,
  estimatedReadingMs: durationMs,
  summary: {
    v: 2,
    uniqueMediaMs: durationMs,
    durationMs,
    instrumentationVersion: 1,
    sequenceGaps: 0,
    reports: 3,
    watched: [[0, durationMs]],
  },
  ...over,
});

function prepare(options: {
  evidence?: CoverageEvidence | undefined;
  head?: CoverageHead | undefined;
  facts?: ReadingFacts | undefined;
}) {
  const ports: ObservedCoveragePorts = {
    readEvidence: () => Promise.resolve(options.evidence),
    readMapping: () => Promise.resolve(options.head ? { kind: 'mapped', head: options.head } : { kind: 'unmapped' }),
    readFacts: () => Promise.resolve(options.facts),
    hash: (value) => (JSON.stringify(value) === JSON.stringify(reelFacts) ? sameHash : hash(value)),
    bytes: (value) => JSON.stringify(value).length,
  };
  return makePrepareObservedCoverage(ports);
}

describe('preparing the observed coverage of a Reel (#674, slice 5.1)', () => {
  const head = headOf('reel-static-coverage.v1', [reelBinding]);

  it('certifies the facets whose required segments the qualified watching covered', async () => {
    const certificate = await prepare({ evidence: reelEvidence(), head, facts: reelFacts })(scope, exposure('reel'));
    expect(certificate).toMatchObject({
      availability: 'available',
      reason: 'observed',
      assetId,
      explanationUnitId: 'fixture-unit',
      bindings: [reelBinding],
      evidence: { policyVersion: 'reel-qualification.recording.v1', revision: 1 },
    });
  });

  it('certifies no facet for watching that stopped before a required segment', async () => {
    const partial = reelEvidence({
      summary: { ...(reelEvidence().summary as object), watched: [[0, 26_000]] },
    });
    const certificate = await prepare({ evidence: partial, head, facts: reelFacts })(scope, exposure('reel'));
    expect(certificate).toMatchObject({ availability: 'available', bindings: [] });
  });

  it('is unavailable when no qualified evidence exists, nothing is mapped, or the summary has no positions', async () => {
    expect(await prepare({ head, facts: reelFacts })(scope, exposure('reel'))).toMatchObject({
      availability: 'unavailable',
      reason: 'qualification_missing',
    });
    expect(await prepare({ evidence: reelEvidence(), facts: reelFacts })(scope, exposure('reel'))).toMatchObject({
      availability: 'unavailable',
      reason: 'mapping_unmapped',
    });
    const oldSummary = reelEvidence({
      summary: { v: 1, uniqueMediaMs: durationMs, durationMs, instrumentationVersion: 1, sequenceGaps: 0, reports: 3 },
    });
    expect(await prepare({ evidence: oldSummary, head, facts: reelFacts })(scope, exposure('reel'))).toMatchObject({
      availability: 'unavailable',
      reason: 'segments_unavailable',
    });
    expect(
      await prepare({ evidence: reelEvidence({ qualification: 'unknown' }), head, facts: reelFacts })(
        scope,
        exposure('reel'),
      ),
    ).toMatchObject({ availability: 'unavailable', reason: 'unqualified' });
  });

  it('never judges a Reel against a Scroll’s mapping, or a Scroll against a Reel’s', async () => {
    const scrollHead = headOf('scroll-static-coverage.v1', [{ ...reelBinding, requiredSpans: undefined }]);
    expect(
      await prepare({ evidence: reelEvidence(), head: scrollHead, facts: reelFacts })(scope, exposure('reel')),
    ).toMatchObject({
      availability: 'unavailable',
      reason: 'identity_mismatch',
    });
    expect(
      await prepare({ evidence: reelEvidence(), head, facts: reelFacts })(scope, exposure('scroll')),
    ).toMatchObject({
      availability: 'unavailable',
      reason: 'identity_mismatch',
    });
  });
});
