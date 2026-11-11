import type { CoverageAuthority, CoverageHead } from '../../content/public.js';
import type { ObservedCoverage } from '../../evidence/public.js';

/** Labelled test fixtures for the coverage rules: digests are repeated characters, never product data. */
export const hash = (character: string) => character.repeat(64);
export const assetId = '20000000-0000-4000-8000-000000000001';
export const identity = {
  documentSha256: hash('1'),
  provenanceSha256: hash('2'),
  explanationUnitId: 'fixture-unit',
  framing: 'factual',
  framingSha256: hash('3'),
  readingFactsVersion: 2,
  readingFactsSha256: hash('4'),
  catalogueVersion: 'content-concepts.v1',
  catalogueSha256: hash('5'),
} as const;
export const binding = {
  topicId: 'fixture.topic',
  facetId: 'fixture.topic.facet',
  meaningSha256: hash('a'),
  requiredBlockIds: ['block-1', 'block-2'],
};
export const secondBinding = { ...binding, facetId: 'fixture.topic.other', meaningSha256: hash('b') };
export const authority = (headRevision: number, mappingSha256: string): CoverageAuthority => ({
  assetId,
  assetRevision: 1,
  headRevision,
  mappingSha256,
});

/** An available certificate issued against head 1 of the fixture asset revision, unless told otherwise. */
export function certificate(
  patch: {
    mapping?: Partial<NonNullable<ObservedCoverage['mapping']>>;
    authority?: Partial<CoverageAuthority>;
    factsSha256?: string;
    bindings?: ObservedCoverage['bindings'];
  } = {},
): ObservedCoverage {
  return {
    version: 'observed-static-coverage.v1',
    universeId: '30000000-0000-4000-8000-000000000001',
    privacyEpoch: 1,
    exposureId: '40000000-0000-4000-8000-000000000001',
    assetId,
    assetRevision: 1,
    activatedAt: '2026-10-20T00:00:00.000Z',
    explanationUnitId: identity.explanationUnitId,
    availability: 'available',
    reason: 'observed',
    evidence: {
      id: '50000000-0000-4000-8000-000000000001',
      revision: 1,
      inputWatermark: 1,
      policyVersion: 'scroll-qualification.v0',
      summarySha256: hash('6'),
    },
    factsSha256: patch.factsSha256 ?? identity.readingFactsSha256,
    mapping: { authority: { ...authority(1, hash('7')), ...patch.authority }, ...identity, ...patch.mapping },
    bindings: patch.bindings ?? [binding],
  };
}

/** An active head 1 of the fixture asset revision that matches `certificate()`, unless told otherwise. */
export function head(
  patch: {
    status?: CoverageHead['status'];
    headRevision?: number;
    mappingSha256?: string;
    mapping?: Partial<CoverageHead['mapping']>;
  } = {},
): CoverageHead {
  return {
    authority: authority(patch.headRevision ?? 1, patch.mappingSha256 ?? hash('7')),
    status: patch.status ?? 'active',
    mapping: { version: 'scroll-static-coverage.v1', ...identity, bindings: [binding], ...patch.mapping },
    commandSha256: hash('8'),
    semanticReviewReference: 'fixture-review',
  };
}

/** The head a catalogue edit followed by `content readmit-coverage` appends: same reading, new digest and number. */
export const digestOnlyHead = (headRevision = 2) =>
  head({ headRevision, mappingSha256: hash('9'), mapping: { catalogueSha256: hash('c') } });
