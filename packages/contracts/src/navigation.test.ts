import { describe, expect, it } from 'vitest';
import {
  ActivateExposureRequestSchema,
  ActivateExposureResponseSchema,
  ApplyActionRequestSchema,
  ApplyActionResponseSchema,
  EncounterOfferSchema,
  ExposureContextRequestSchema,
  ExposureContextResponseSchema,
  ListSavedResponseSchema,
  NavigateExperienceRequestSchema,
  NavigationOutcomeSchema,
  OpenExposureRequestSchema,
  OpenExposureResponseSchema,
} from './index.js';

// Wire-only fixtures: neither admitted content nor product activity.
const id = '0199f0a0-0000-7000-8000-000000000001';
const otherId = '0199f0a0-0000-7000-8000-000000000002';
const capabilities = { documentSchemas: ['scroll-document.v1'], blocks: { fallback: [1] } };
const directOpen = { commandId: id, target: { kind: 'scroll', assetId: id }, origin: { kind: 'direct' }, capabilities };
const directOpened = {
  commandId: id,
  exposureId: id,
  assetId: id,
  assetRevision: 1,
  kind: 'scroll',
  revision: 0,
  replayed: false,
};
const directActivate = { commandId: id, exposureId: id };
const activated = { ...directActivate, activatedAt: '2026-10-20T10:00:00.000Z', revision: 0, replayed: false };
const discover = { commandId: id, target: { kind: 'discover' }, capabilities };
const offerTarget = { kind: 'offer', sessionId: id, offerId: id, expectedIntentRevision: 0 };
const metadata = { kind: 'scroll', title: 'Wire fixture', summary: 'Fixture metadata only.', language: 'en' };
const offer = {
  offerId: id,
  decisionId: id,
  assetId: id,
  assetRevision: 1,
  explanationUnitId: 'fixture-explanation',
  metadata,
  relation: { kind: 'discovery' },
  variants: [{ kind: 'reel', status: 'unavailable' }],
};
const outcome = { commandId: id, sessionId: id, intentRevision: 1, revision: 0, decisionId: id, replayed: false };
const navigate = {
  commandId: id,
  sessionId: id,
  expectedIntentRevision: 0,
  from: { offerId: id, exposureId: id },
  intent: { mode: 'related' },
};

describe('Explore prerequisite wire contracts', () => {
  it('preserves the documented direct open/activate and save/unsave wire, including other unknown-field stripping', () => {
    expect(OpenExposureRequestSchema.parse({ ...directOpen, futureLegacyField: 'ignored' })).toEqual(directOpen);
    expect(OpenExposureResponseSchema.parse({ ...directOpened, futureLegacyField: true })).toEqual(directOpened);
    expect(ActivateExposureRequestSchema.parse({ ...directActivate, futureLegacyField: true })).toEqual(directActivate);
    expect(ActivateExposureResponseSchema.parse({ ...activated, futureLegacyField: true })).toEqual(activated);
    for (const kind of ['save', 'unsave']) {
      const action = { commandId: id, kind, target: { assetId: id, assetRevision: 1 } };
      expect(ApplyActionRequestSchema.parse({ ...action, futureLegacyField: true })).toEqual(action);
      const savedResult = {
        commandId: id,
        assetId: id,
        assetRevision: 1,
        actionId: id,
        kind,
        saved: kind === 'save',
        changed: true,
        revision: 0,
        replayed: false,
      };
      expect(ApplyActionResponseSchema.parse(savedResult)).toEqual(savedResult);
    }
  });

  it('opens initial discovery or resumes with both session ID and expected intent revision', () => {
    expect(OpenExposureRequestSchema.parse(discover)).toEqual(discover);
    const session = { sessionId: id, expectedIntentRevision: 0 };
    expect(OpenExposureRequestSchema.parse({ ...discover, session })).toEqual({ ...discover, session });
    for (const invalid of [
      { ...discover, session: { sessionId: id } },
      { ...discover, session: { expectedIntentRevision: 0 } },
      { ...discover, session: { ...session, expectedIntentRevision: -1 } },
      { ...discover, ownerId: id },
      { ...discover, session: { ...session, playheadMs: 12000 } },
    ])
      expect(OpenExposureRequestSchema.safeParse(invalid).success).toBe(false);
  });

  it('opens Saved as an exact-revision revisit before a current encounter exists, with the same optional session pair', () => {
    const revisit = { commandId: id, target: { kind: 'return', assetId: id, assetRevision: 2 }, capabilities };
    const session = { sessionId: id, expectedIntentRevision: 0 };
    expect(OpenExposureRequestSchema.parse(revisit)).toEqual(revisit);
    expect(OpenExposureRequestSchema.parse({ ...revisit, session })).toEqual({ ...revisit, session });
    for (const invalid of [
      { ...revisit, target: { kind: 'return', assetId: id } },
      { ...revisit, target: { ...revisit.target, assetRevision: 0 } },
      { ...revisit, target: { ...revisit.target, assetRevision: 1.5 } },
      { ...revisit, session: { sessionId: id } },
      { ...revisit, session: { expectedIntentRevision: 0 } },
      { ...revisit, session: { ...session, expectedIntentRevision: -1 } },
      { ...revisit, target: { ...revisit.target, blockId: 'fixture-block', offset: 42 } },
      { ...revisit, playheadMs: 31000 },
      { ...revisit, origin: { kind: 'direct' } },
      { ...revisit, from: { offerId: id, exposureId: id } },
    ])
      expect(OpenExposureRequestSchema.safeParse(invalid).success).toBe(false);
  });

  it('requires a session, activated member offer/exposure and latest expected intent for each semantic move', () => {
    for (const intent of [
      { mode: 'vertical', direction: 'next' },
      { mode: 'vertical', direction: 'previous' },
      { mode: 'series', direction: 'next' },
      { mode: 'series', direction: 'previous' },
      { mode: 'related' },
      { mode: 'variant', to: 'scroll' },
      { mode: 'variant', to: 'reel' },
      { mode: 'return', target: { assetId: id, assetRevision: 2 } },
    ])
      expect(NavigateExperienceRequestSchema.safeParse({ ...navigate, intent }).success).toBe(true);
    for (const invalid of [
      { ...navigate, commandId: undefined },
      { ...navigate, sessionId: undefined },
      { ...navigate, expectedIntentRevision: undefined },
      { ...navigate, expectedIntentRevision: -1 },
      { ...navigate, from: { offerId: id } },
      { ...navigate, from: { exposureId: id } },
      { ...navigate, intent: { mode: 'back' } },
      { ...navigate, intent: { mode: 'related', part: 2 } },
      { ...navigate, intent: { mode: 'variant', to: 'scroll', generate: true } },
      { ...navigate, intent: { mode: 'return', target: { assetId: id, assetRevision: 1, playheadMs: 31000 } } },
      { ...navigate, from: { offerId: id, exposureId: id, blockOffset: 40 } },
      { ...navigate, peerPlayback: { accountId: otherId, position: 12 } },
    ])
      expect(NavigateExperienceRequestSchema.safeParse(invalid).success).toBe(false);
  });

  it('binds a displayed continuation only on series/related intents, preserving generic moves and parked member lineage', () => {
    const expectedContinuation = { linkId: otherId, assetId: otherId, assetRevision: 2 };
    // The wire allows a parked member; the consumer checks same-session activation/epoch and latest intent.
    const parked = { ...navigate, expectedIntentRevision: 7, from: { offerId: otherId, exposureId: otherId } };
    for (const intent of [
      { mode: 'series', direction: 'next', expectedContinuation },
      { mode: 'series', direction: 'previous', expectedContinuation },
      { mode: 'related', expectedContinuation },
    ])
      expect(NavigateExperienceRequestSchema.parse({ ...parked, intent })).toEqual({ ...parked, intent });
    for (const intent of [
      { mode: 'vertical', direction: 'next', expectedContinuation },
      { mode: 'variant', to: 'scroll', expectedContinuation },
      { mode: 'return', target: { assetId: id, assetRevision: 1 }, expectedContinuation },
      { mode: 'related', expectedContinuation: { linkId: otherId, assetId: otherId } },
      { mode: 'related', expectedContinuation: { ...expectedContinuation, assetRevision: 0 } },
      { mode: 'related', expectedContinuation: { ...expectedContinuation, ownerId: id } },
    ])
      expect(NavigateExperienceRequestSchema.safeParse({ ...navigate, intent }).success).toBe(false);
  });

  it('reads mutable action/continuation context with optional latest Composer intent, never offering phantom targets', () => {
    const unavailable = { status: 'unavailable', reason: 'series_boundary' };
    const context = {
      exposureId: id,
      assetId: id,
      assetRevision: 1,
      revision: 3,
      actions: { saved: true, liked: false, hidden: false },
      variants: offer.variants,
      continuations: {
        seriesPrevious: unavailable,
        seriesNext: { status: 'pending', requestId: otherId },
        related: {
          status: 'ready',
          linkId: otherId,
          target: { assetId: otherId, assetRevision: 2 },
          metadata,
          relation: { kind: 'related_move', label: 'Another angle' },
        },
      },
    };
    expect(ExposureContextRequestSchema.parse({ exposureId: id })).toEqual({ exposureId: id });
    expect(ExposureContextResponseSchema.parse(context)).toEqual(context);
    const composer = { ...context, session: { sessionId: id, intentRevision: 7 } };
    expect(ExposureContextResponseSchema.parse(composer)).toEqual(composer);
    const series = { seriesId: 'fixture-series', seriesRevision: 1, part: 2 };
    const readySeries = {
      ...context.continuations.related,
      relation: { kind: 'series_step', ...series, part: 3 },
    };
    const inSeries = {
      ...composer,
      series: { ...series, total: 3 },
      continuations: { ...context.continuations, seriesNext: readySeries },
    };
    expect(ExposureContextResponseSchema.parse(inSeries)).toEqual(inSeries);
    for (const invalid of [
      { ...context, session: { sessionId: id } },
      { ...context, session: { sessionId: id, intentRevision: -1 } },
      { ...context, session: { sessionId: id, intentRevision: 7, playheadMs: 12 } },
      { ...context, actions: { ...context.actions, score: 0.8 } },
      { ...context, actions: { saved: true, liked: false } },
      { ...context, series: { ...series, totalParts: 9 } },
      { ...context, variants: [offer.variants[0], offer.variants[0]] },
      { ...context, continuations: { ...context.continuations, seriesNext: { status: 'pending' } } },
      {
        ...context,
        continuations: {
          ...context.continuations,
          seriesNext: { status: 'pending', requestId: id, target: { assetId: id } },
        },
      },
      { ...context, continuations: { ...context.continuations, seriesPrevious: { ...unavailable, offerId: id } } },
      { ...context, continuations: { ...context.continuations, seriesNext: context.continuations.related } },
      { ...context, continuations: { ...context.continuations, related: readySeries } },
      {
        ...context,
        continuations: { ...context.continuations, related: { ...context.continuations.related, exposureId: id } },
      },
      { ...context, provenance: {} },
      { ...context, blockOffset: 12 },
    ])
      expect(ExposureContextResponseSchema.safeParse(invalid).success).toBe(false);
    expect(ExposureContextRequestSchema.safeParse({ exposureId: id, ownerId: id }).success).toBe(false);
  });

  it('keeps ready, durable pending and natural exhaustion distinct without phantom exposure or offer fields', () => {
    const ready = { ...outcome, status: 'ready', offer, bufferedOffers: [] };
    const pending = { ...outcome, status: 'pending', reason: 'requested_supply_pending', requestId: id };
    const exhausted = { ...outcome, status: 'exhausted', reason: 'series_boundary' };
    for (const valid of [ready, pending, exhausted, { ...outcome, status: 'pending', reason: 'buffer_preparing' }]) {
      expect(NavigationOutcomeSchema.parse(valid)).toEqual(valid);
      expect(OpenExposureResponseSchema.parse(valid)).toEqual(valid);
      expect(JSON.parse(JSON.stringify(valid))).toEqual(valid);
    }
    for (const invalid of [
      { ...ready, exposureId: id },
      { ...pending, offer },
      { ...exhausted, offer },
      { ...pending, requestId: undefined },
      { ...pending, reason: 'buffer_preparing' },
      { ...pending, percentage: 95 },
      { ...exhausted, nextPart: 4 },
      { ...directOpened, status: 'pending' },
    ])
      expect(OpenExposureResponseSchema.safeParse(invalid).success).toBe(false);
  });

  it('bounds and deduplicates offers by explanation across format variants, with no source/score/provenance leak', () => {
    expect(EncounterOfferSchema.safeParse(offer).success).toBe(true);
    for (const relation of [
      { kind: 'series_step', seriesId: 'fixture-series', seriesRevision: 1, part: 2 },
      { kind: 'related_move', label: 'Another angle' },
      { kind: 'format_variant' },
      { kind: 'return' },
    ])
      expect(EncounterOfferSchema.safeParse({ ...offer, relation }).success).toBe(true);
    for (const invalid of [
      { ...offer, metadata: { ...metadata, sources: ['private'] } },
      { ...offer, score: 0.8 },
      { ...offer, provenance: { runId: id } },
      { ...offer, relation: { kind: 'related_move', label: 'Another angle', part: 2 } },
      { ...offer, variants: [{ kind: 'reel', status: 'ready' }] },
      { ...offer, variants: [{ kind: 'reel', status: 'pending' }] },
      {
        ...offer,
        variants: [
          { kind: 'reel', status: 'pending', requestId: id },
          { kind: 'reel', status: 'unavailable' },
        ],
      },
    ])
      expect(EncounterOfferSchema.safeParse(invalid).success).toBe(false);
    const ready = { ...outcome, status: 'ready', offer, bufferedOffers: [] };
    expect(NavigationOutcomeSchema.safeParse({ ...ready, bufferedOffers: [offer] }).success).toBe(false);
    expect(
      NavigationOutcomeSchema.safeParse({
        ...ready,
        bufferedOffers: [{ ...offer, offerId: otherId, metadata: { ...metadata, kind: 'reel' } }],
      }).success,
    ).toBe(false);
    const distinct = { ...offer, offerId: otherId, explanationUnitId: 'fixture-other' };
    expect(NavigationOutcomeSchema.safeParse({ ...ready, bufferedOffers: [distinct] }).success).toBe(true);
    expect(
      NavigationOutcomeSchema.safeParse({ ...ready, bufferedOffers: [distinct, distinct, distinct] }).success,
    ).toBe(false);
  });

  it('reserves the new activation discriminator so malformed or mixed offers cannot downgrade into direct activation', () => {
    const activate = { commandId: id, target: offerTarget };
    expect(ActivateExposureRequestSchema.parse(activate)).toEqual(activate);
    for (const invalid of [
      { ...directActivate, target: offerTarget },
      { ...directActivate, target: { kind: 'offer' } },
      { ...directActivate, target: { ...offerTarget, expectedIntentRevision: -1 } },
      { ...activate, target: { ...offerTarget, playheadMs: 31000 } },
      { ...activate, target: { ...offerTarget, offerId: undefined } },
      { ...activated, sessionId: id },
    ]) {
      const schema = 'activatedAt' in invalid ? ActivateExposureResponseSchema : ActivateExposureRequestSchema;
      expect(schema.safeParse(invalid).success).toBe(false);
    }
    const response = {
      ...activated,
      sessionId: id,
      offerId: id,
      intentRevision: 1,
      assetId: id,
      assetRevision: 1,
      kind: 'scroll',
    };
    expect(ActivateExposureResponseSchema.parse(response)).toEqual(response);
  });

  it('adds Like/Unlike/Hide without changing the old saved response semantics', () => {
    for (const kind of ['like', 'unlike', 'hide']) {
      expect(
        ApplyActionRequestSchema.safeParse({ commandId: id, kind, target: { assetId: id, assetRevision: 1 } }).success,
      ).toBe(true);
      const result = {
        commandId: id,
        actionId: id,
        kind,
        assetId: id,
        assetRevision: 1,
        liked: kind === 'like',
        hidden: kind === 'hide',
        changed: true,
        revision: 1,
        replayed: false,
      };
      expect(ApplyActionResponseSchema.parse(result)).toEqual(result);
      expect(ApplyActionResponseSchema.safeParse({ ...result, saved: true }).success).toBe(false);
    }
  });

  it('accepts explicit action exposure linkage without guessing an encounter for legacy asset preferences', () => {
    for (const kind of ['save', 'unsave', 'like', 'unlike', 'hide']) {
      const action = { commandId: id, kind, target: { assetId: id, assetRevision: 1 } };
      expect(ApplyActionRequestSchema.parse(action)).toEqual(action);
      expect(ApplyActionRequestSchema.parse({ ...action, exposureId: otherId, futureLegacyField: true })).toEqual({
        ...action,
        exposureId: otherId,
      });
      for (const exposureId of [null, '', 'not-an-exposure', {}])
        expect(ApplyActionRequestSchema.safeParse({ ...action, exposureId }).success).toBe(false);
    }
  });

  it('allows only consumer Saved metadata while the interim ID-only list remains compatible', () => {
    const item = { assetId: id, assetRevision: 1, savedAt: '2026-10-20T10:00:00.000Z' };
    const legacy = { revision: 0, items: [item] };
    expect(ListSavedResponseSchema.parse(legacy)).toEqual(legacy);
    const current = { revision: 0, items: [{ ...item, metadata, availability: 'corrected', currentAssetRevision: 2 }] };
    expect(ListSavedResponseSchema.parse(current)).toEqual(current);
    // Replacement revision is different, not necessarily greater: the saved reference never changes.
    const replacement = {
      revision: 0,
      items: [{ ...item, assetRevision: 3, availability: 'corrected', currentAssetRevision: 2 }],
    };
    expect(ListSavedResponseSchema.parse(replacement)).toEqual(replacement);
    for (const availability of [undefined, 'available', 'withdrawn'])
      expect(
        ListSavedResponseSchema.safeParse({ revision: 0, items: [{ ...item, availability, currentAssetRevision: 2 }] })
          .success,
      ).toBe(false);
    expect(
      ListSavedResponseSchema.safeParse({
        revision: 0,
        items: [{ ...item, availability: 'corrected', currentAssetRevision: 1 }],
      }).success,
    ).toBe(false);
    for (const extra of [{ sources: [] }, { provenance: {} }, { peerPlayheadMs: 10 }, { modelReasoning: 'private' }])
      expect(
        ListSavedResponseSchema.safeParse({ revision: 0, items: [{ ...item, metadata: { ...metadata, ...extra } }] })
          .success,
      ).toBe(false);
  });
});
