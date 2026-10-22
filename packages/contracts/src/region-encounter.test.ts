import { describe, expect, it } from 'vitest';
import {
  ActivateExposureRequestSchema,
  OpenExposureRequestSchema,
  RegionEncounterOpenRequestSchema,
  RegionEncounterOpenResponseSchema,
  RegionEncounterProblemIssueSchema,
  RegionEncounterProblemSchema,
  apiContract,
  problemDetails,
} from './index.js';

// Authored wire fixtures only: no established region, admitted asset or product activity.
const id = (n: number) => `0199f0a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const version = 'region-encounter-open.v1';
const target = { kind: 'region', regionId: id(1), expectedObjectRevision: 2, expectedGeographyRevision: 3 };
const capabilities = { documentSchemas: ['reel-document.v1', 'scroll-document.v1'], blocks: { fallback: [1] } };
const request = { version, commandId: id(2), target, capabilities };
const common = {
  commandId: id(2),
  sessionId: id(3),
  intentRevision: 0,
  revision: 7,
  decisionId: id(4),
  replayed: false,
};
function offer(n: number, kind: 'reel' | 'scroll' = 'scroll') {
  return {
    offerId: id(n),
    decisionId: common.decisionId,
    assetId: id(n + 100),
    assetRevision: 1,
    explanationUnitId: `fixture-unit-${n}`,
    metadata: { kind, title: 'Wire fixture', summary: 'Authored syntax only.', language: 'en' },
    relation: { kind: 'discovery' },
    variants: [{ status: 'unavailable', kind: kind === 'scroll' ? 'reel' : 'scroll' }],
  };
}
const ready = { ...common, status: 'ready', offer: offer(5), bufferedOffers: [offer(6, 'reel'), offer(7)] };
function response(outcome: unknown = ready) {
  return { version, universeId: id(8), privacyEpoch: 1, target, outcome };
}

describe('U04 declaration-only region encounter preparation', () => {
  it('declares a separate fixed POST, leaving direct open and activation compatibility intact', () => {
    expect(apiContract.experience.openRegionEncounter['~orpc'].route).toMatchObject({
      method: 'POST',
      path: '/v1/experience/region/open',
      successStatus: 200,
    });
    const legacy = {
      commandId: id(2),
      target: { kind: 'scroll', assetId: id(5) },
      origin: { kind: 'direct' },
      capabilities,
    };
    expect(OpenExposureRequestSchema.parse({ ...legacy, futureLegacyField: true })).toEqual(legacy);
    expect(OpenExposureRequestSchema.safeParse(request).success).toBe(false);
    const activation = { commandId: id(2), exposureId: id(5) };
    expect(ActivateExposureRequestSchema.parse({ ...activation, futureLegacyField: true })).toEqual(activation);
    expect(ActivateExposureRequestSchema.safeParse(request).success).toBe(false);
  });

  it('round-trips exact initial and current-session commands without transforms or defaults', () => {
    for (const value of [request, { ...request, session: { sessionId: id(3), expectedIntentRevision: 4 } }]) {
      expect(RegionEncounterOpenRequestSchema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
    }
    expect(RegionEncounterOpenResponseSchema.parse(JSON.parse(JSON.stringify(response())))).toEqual(response());
    expect(RegionEncounterOpenResponseSchema.parse(response({ ...ready, replayed: true }))).toEqual(
      response({ ...ready, replayed: true }),
    );
  });

  it('rejects caller authority, scene/meaning/asset overrides and private return metadata at every new boundary', () => {
    for (const field of [
      'accountId',
      'universeId',
      'privacyEpoch',
      'sceneId',
      'chunkId',
      'seed',
      'meaningId',
      'topicId',
      'facetId',
      'label',
      'assetId',
      'camera',
      'playheadMs',
    ]) {
      expect(RegionEncounterOpenRequestSchema.safeParse({ ...request, [field]: id(9) }).success).toBe(false);
      expect(
        RegionEncounterOpenRequestSchema.safeParse({ ...request, target: { ...target, [field]: id(9) } }).success,
      ).toBe(false);
    }
    for (const invalid of [
      { ...request, version: 'region-encounter-open.v2' },
      { ...request, target: { ...target, kind: 'scene' } },
      { ...request, target: { ...target, kind: 'planet' } },
      { ...request, session: { sessionId: id(3) } },
      { ...request, session: { sessionId: id(3), expectedIntentRevision: 0, exposureId: id(5) } },
      { ...request, origin: { kind: 'direct' } },
    ])
      expect(RegionEncounterOpenRequestSchema.safeParse(invalid).success).toBe(false);
  });

  it('bounds independent revisions and refuses impossible selection stamps', () => {
    for (const value of [-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
      for (const key of ['expectedObjectRevision', 'expectedGeographyRevision'])
        expect(
          RegionEncounterOpenRequestSchema.safeParse({ ...request, target: { ...target, [key]: value } }).success,
        ).toBe(false);
    }
    expect(
      RegionEncounterOpenRequestSchema.safeParse({ ...request, target: { ...target, expectedObjectRevision: 4 } })
        .success,
    ).toBe(false);
    expect(
      RegionEncounterOpenRequestSchema.safeParse({
        ...request,
        session: { sessionId: id(3), expectedIntentRevision: Number.MAX_SAFE_INTEGER + 1 },
      }).success,
    ).toBe(false);
    // Root, Geography and session-intent revisions are independent domains.
    expect(
      RegionEncounterOpenResponseSchema.safeParse(response({ ...ready, revision: 0, intentRevision: 9 })).success,
    ).toBe(true);
    for (const key of ['revision', 'intentRevision'])
      expect(
        RegionEncounterOpenResponseSchema.safeParse(response({ ...ready, [key]: Number.MAX_SAFE_INTEGER + 1 })).success,
      ).toBe(false);
    expect(RegionEncounterOpenResponseSchema.safeParse({ ...response(), privacyEpoch: 0 }).success).toBe(false);
  });

  it('retains ready offer bounds, exact decision and discovery relations without inventing activation', () => {
    for (const outcome of [
      { ...ready, offer: { ...offer(5), relation: { kind: 'return' } } },
      { ...ready, bufferedOffers: [{ ...offer(6), relation: { kind: 'format_variant' } }] },
      { ...ready, offer: { ...offer(5), decisionId: id(99) } },
      { ...ready, bufferedOffers: [offer(5)] },
      { ...ready, bufferedOffers: [{ ...offer(6), explanationUnitId: offer(5).explanationUnitId }] },
      { ...ready, bufferedOffers: [offer(6), offer(7), offer(8)] },
      { ...ready, offer: { ...offer(5), assetRevision: Number.MAX_SAFE_INTEGER + 1 } },
      {
        ...ready,
        offer: {
          ...offer(5),
          variants: [{ status: 'ready', kind: 'reel', assetId: id(99), assetRevision: Number.MAX_SAFE_INTEGER + 1 }],
        },
      },
      { ...ready, exposureId: id(10) },
      { ...ready, offer: { ...offer(5), scores: { interest: 1 } } },
    ])
      expect(RegionEncounterOpenResponseSchema.safeParse(response(outcome)).success).toBe(false);
    for (const extra of ['position', 'sources', 'supportRefs', 'formation', 'acknowledged', 'camera'])
      expect(RegionEncounterOpenResponseSchema.safeParse({ ...response(), [extra]: true }).success).toBe(false);
  });

  it('keeps exhaustion and real pending shapes distinct from a ready card and immutable replay', () => {
    for (const outcome of [
      { ...common, status: 'exhausted', reason: 'no_eligible_content' },
      { ...common, status: 'pending', reason: 'buffer_preparing' },
      { ...common, status: 'pending', reason: 'requested_supply_pending', requestId: id(20), replayed: true },
    ])
      expect(RegionEncounterOpenResponseSchema.parse(response(outcome))).toEqual(response(outcome));
    for (const outcome of [
      { ...common, status: 'pending', reason: 'requested_supply_pending' },
      { ...common, status: 'pending', reason: 'buffer_preparing', requestId: id(20) },
      { ...common, status: 'pending', reason: 'buffer_preparing', offer: offer(5) },
      { ...common, status: 'exhausted', reason: 'no_eligible_content', eta: 10 },
      { ...common, status: 'exhausted', reason: 'series_boundary' },
      { ...common, status: 'unknown' },
    ])
      expect(RegionEncounterOpenResponseSchema.safeParse(response(outcome)).success).toBe(false);
  });

  it('accepts only fixed catalogue problems and bounded code-owned issue tokens', () => {
    const errors = apiContract.experience.openRegionEncounter['~orpc'].errorMap;
    for (const code of Object.keys(errors) as (keyof typeof errors)[]) {
      const value = problemDetails(code);
      expect(RegionEncounterProblemSchema.parse(value)).toEqual(value);
      for (const patch of [
        { status: 200 },
        { title: 'PRIVATE' },
        { type: 'https://private.test/' },
        { detail: 'PRIVATE' },
        { instance: id(1) },
        { regionId: id(1) },
      ])
        expect(RegionEncounterProblemSchema.safeParse({ ...value, ...patch }).success).toBe(false);
    }
    const base = problemDetails('INVALID_REQUEST');
    const issue = { path: ['capabilities', 'blocks', 'unknown'], code: 'unrecognized_keys' };
    expect(RegionEncounterProblemSchema.parse({ ...base, issues: [issue] })).toEqual({ ...base, issues: [issue] });
    for (const bad of [
      { ...issue, path: ['PRIVATE-MAP-KEY'] },
      { ...issue, path: ['capabilities', 'blocks', 123456] },
      { ...issue, path: Array(9).fill('target') },
      { ...issue, code: 'PRIVATE-ERROR' },
      { ...issue, message: 'PRIVATE' },
      { ...issue, value: 'PRIVATE' },
    ])
      expect(RegionEncounterProblemIssueSchema.safeParse(bad).success).toBe(false);
    expect(RegionEncounterProblemSchema.safeParse({ ...base, issues: Array(33).fill(issue) }).success).toBe(false);
    expect(RegionEncounterProblemSchema.safeParse(problemDetails('KEEP_ENTRY_UNAVAILABLE')).success).toBe(false);
  });
});

// Preview is a separate read; these are wire fixtures, never preview-created offers/evidence.
describe('U04 exact read preview and displayed immutable Open expectation', () => {
  it('round-trips a correlated minimized card or honest unavailable without command effects', async () => {
    const { RegionEncounterPreviewRequestSchema, RegionEncounterPreviewResponseSchema } = await import('./index.js');
    const read = { version: 'region-encounter-preview.v1', readId: id(30), target, capabilities };
    const available = {
      ...read,
      scope: { universeId: id(8), privacyEpoch: 1, personalWatermark: 4 },
      recordedAt: '2026-10-22T00:00:00Z',
      geographyRevision: 3,
      status: 'available',
      encounter: { assetId: id(105), assetRevision: 1, metadata: offer(5).metadata },
    };
    expect(apiContract.experience.previewRegionEncounter['~orpc'].route).toMatchObject({
      method: 'POST',
      path: '/v1/experience/region/preview',
      successStatus: 200,
    });
    expect(RegionEncounterPreviewRequestSchema.parse(read)).toEqual(read);
    expect(RegionEncounterPreviewResponseSchema.parse(available)).toEqual(available);
    const { encounter: _encounter, ...base } = available;
    for (const reason of [
      'stale_target',
      'unsupported_region',
      'selection_unavailable',
      'no_eligible_content',
      'temporarily_unavailable',
    ]) {
      const value = { ...base, status: 'unavailable', reason };
      expect(RegionEncounterPreviewResponseSchema.parse(value)).toEqual(value);
    }
    for (const key of [
      'commandId',
      'session',
      'offerId',
      'exposureId',
      'evidence',
      'jobId',
      'camera',
      'playheadMs',
      'accountId',
    ]) {
      expect(RegionEncounterPreviewRequestSchema.safeParse({ ...read, [key]: id(99) }).success).toBe(false);
      expect(RegionEncounterPreviewResponseSchema.safeParse({ ...available, [key]: id(99) }).success).toBe(false);
    }
    expect(RegionEncounterPreviewResponseSchema.safeParse({ ...available, geographyRevision: 4 }).success).toBe(false);
    expect(
      RegionEncounterPreviewResponseSchema.safeParse({
        ...available,
        encounter: { ...available.encounter, sources: [] },
      }).success,
    ).toBe(false);
    expect(RegionEncounterPreviewRequestSchema.safeParse(request).success).toBe(false);
    expect(RegionEncounterOpenRequestSchema.safeParse(read).success).toBe(false);
  });

  it('preserves legacy Open but never admits a replacement B as displayed A in a bound ready response', () => {
    const expectedEncounter = { assetId: id(105), assetRevision: 1 };
    expect(RegionEncounterOpenRequestSchema.parse(request)).toEqual(request);
    const exact = { ...request, expectedEncounter };
    expect(RegionEncounterOpenRequestSchema.parse(exact)).toEqual(exact);
    const bound = { ...response(), expectedEncounter, capabilities };
    expect(RegionEncounterOpenResponseSchema.parse(bound)).toEqual(bound);
    for (const invalid of [
      { ...bound, outcome: { ...ready, offer: { ...offer(5), assetId: id(999) } } },
      { ...bound, outcome: { ...ready, offer: { ...offer(5), assetRevision: 2 } } },
      { ...bound, capabilities: undefined },
      { ...bound, expectedEncounter: { ...expectedEncounter, assetRevision: Number.MAX_SAFE_INTEGER + 1 } },
      { ...bound, expectedEncounter: { ...expectedEncounter, camera: {} } },
    ])
      expect(RegionEncounterOpenResponseSchema.safeParse(invalid).success).toBe(false);
    expect(
      RegionEncounterOpenRequestSchema.safeParse({
        ...exact,
        expectedEncounter: { ...expectedEncounter, universeId: id(8) },
      }).success,
    ).toBe(false);
    // Pending/exhausted retain exact request expectation, with no replacement offer or exposure.
    for (const outcome of [
      { ...common, status: 'pending', reason: 'buffer_preparing' },
      { ...common, status: 'exhausted', reason: 'no_eligible_content' },
    ])
      expect(RegionEncounterOpenResponseSchema.parse({ ...bound, outcome })).toEqual({ ...bound, outcome });
  });
});
