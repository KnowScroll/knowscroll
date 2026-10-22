import { describe, expect, it } from 'vitest';
import {
  INTERACTION_SCHEMA_VERSION,
  InteractionEventSchema,
  OBSERVATION_LIMITS,
  ObservationBatchRequestSchema,
  SCROLL_INTERACTION_KINDS,
  ObservationBatchResponseSchema,
  RecordingObservationBatchRequestSchema,
  RecordingObservationBatchResponseSchema,
  submitObservationsContract,
  submitRecordingObservationsContract,
  apiContract,
} from './index.js';

const base = {
  schemaVersion: INTERACTION_SCHEMA_VERSION,
  eventId: '0199f0a0-0000-7000-8000-000000000001',
  sessionId: '0199f0a0-0000-7000-8000-000000000002',
  deviceSequence: 1,
  exposureId: '0199f0a0-0000-7000-8000-000000000003',
  assetId: '0199f0a0-0000-7000-8000-000000000004',
  assetRevision: 1,
  occurredAt: '2026-10-20T10:00:00.000Z',
};

const coverage = (payload: unknown) => ({ ...base, kind: 'scroll.block_coverage', payload });

describe('interaction.v1 (observations the recorder sends)', () => {
  it('accepts the three scroll kinds with bounded payloads', () => {
    expect(
      InteractionEventSchema.safeParse(
        coverage({ blocks: [{ blockId: 'intro-look-up', intervalsMs: [[0, 4_000]], peakFraction: 1 }] }),
      ).success,
    ).toBe(true);
    expect(
      InteractionEventSchema.safeParse({
        ...base,
        kind: 'scroll.active_dwell',
        payload: { activeIntervalsMs: [[0, 1]] },
      }).success,
    ).toBe(true);
    for (const kind of SCROLL_INTERACTION_KINDS)
      expect(
        InteractionEventSchema.safeParse({
          ...base,
          kind: 'scroll.block_interaction',
          payload: { blockId: 'rule-steps', kind, atMs: 10 },
        }).success,
      ).toBe(true);
  });

  it('refuses out-of-bound claims: fractions outside [0, 1], empty or reversed intervals, offsets beyond a day', () => {
    const block = { blockId: 'intro-look-up', intervalsMs: [[0, 4_000]], peakFraction: 1 };
    for (const bad of [
      { ...block, peakFraction: 1.01 },
      { ...block, peakFraction: -0.1 },
      { ...block, intervalsMs: [[5, 5]] },
      { ...block, intervalsMs: [[9, 3]] },
      { ...block, intervalsMs: [[0, OBSERVATION_LIMITS.maxClaimMs + 1]] },
      { ...block, intervalsMs: [[-1, 3]] },
      {
        ...block,
        intervalsMs: Array.from({ length: OBSERVATION_LIMITS.maxIntervalsPerBlock + 1 }, (_, i) => [
          i * 10,
          i * 10 + 5,
        ]),
      },
    ])
      expect(InteractionEventSchema.safeParse(coverage({ blocks: [bad] })).success).toBe(false);
    expect(
      InteractionEventSchema.safeParse(
        coverage({ blocks: Array.from({ length: OBSERVATION_LIMITS.maxBlocksPerCoverage + 1 }, () => block) }),
      ).success,
    ).toBe(false);
  });

  it('refuses unknown kinds, unknown interaction kinds and any extra field (no free text, no values)', () => {
    expect(InteractionEventSchema.safeParse({ ...base, kind: 'scroll.pointer_frame', payload: {} }).success).toBe(
      false,
    );
    expect(
      InteractionEventSchema.safeParse({
        ...base,
        kind: 'scroll.block_interaction',
        payload: { blockId: 'rule-steps', kind: 'slider', atMs: 1 },
      }).success,
    ).toBe(false);
    expect(
      InteractionEventSchema.safeParse({
        ...base,
        kind: 'scroll.block_interaction',
        payload: { blockId: 'sim-1', kind: 'param-changed', atMs: 1, value: 4096 },
      }).success,
    ).toBe(false);
    expect(InteractionEventSchema.safeParse({ ...coverage({ blocks: [] }), owner: 'someone-else' }).success).toBe(
      false,
    );
  });

  it('bounds a batch by event count and refuses an empty one', () => {
    const event = coverage({ blocks: [] });
    expect(ObservationBatchRequestSchema.safeParse({ instrumentationVersion: 1, events: [event] }).success).toBe(true);
    expect(ObservationBatchRequestSchema.safeParse({ instrumentationVersion: 1, events: [] }).success).toBe(false);
    expect(
      ObservationBatchRequestSchema.safeParse({
        instrumentationVersion: 1,
        events: Array.from({ length: OBSERVATION_LIMITS.maxEventsPerBatch + 1 }, () => event),
      }).success,
    ).toBe(false);
  });

  it("keeps one stored payload under the database's 8 KiB check at the largest the schema allows", () => {
    const blocks = Array.from({ length: OBSERVATION_LIMITS.maxBlocksPerCoverage }, () => ({
      blockId: 'a'.repeat(40),
      intervalsMs: Array.from({ length: OBSERVATION_LIMITS.maxIntervalsPerBlock }, (): [number, number] => [
        OBSERVATION_LIMITS.maxClaimMs,
        OBSERVATION_LIMITS.maxClaimMs,
      ]),
      peakFraction: 0.12345678901234568,
    }));
    expect(new TextEncoder().encode(JSON.stringify({ blocks })).length).toBeLessThan(8_192);
  });
});

describe('observation-batch.v2 recording declaration (synthetic fixtures only)', () => {
  const event = coverage({ blocks: [] });
  const request = {
    version: 'observation-batch.v2',
    recordingGeneration: 3,
    instrumentationVersion: 1,
    events: [event],
  };
  const snapshot = {
    version: 'observation-batch.v2',
    recordingGeneration: 3,
    currentGeneration: 3,
    scope: { accountId: base.assetId, privacyEpoch: 2 },
    revision: 6,
  };
  const result = { eventId: base.eventId, status: 'accepted' };
  const processed = { ...snapshot, result: 'processed', accepted: 1, duplicates: 0, rejected: 0, results: [result] };

  it('has a separate strict generation-bearing route and keeps the legacy declaration/schema intact', () => {
    expect(RecordingObservationBatchRequestSchema.parse(request)).toEqual(request);
    expect(apiContract.observations.submit).toBe(submitObservationsContract);
    expect(apiContract.observations.submitRecording).toBe(submitRecordingObservationsContract);
    expect(submitRecordingObservationsContract['~orpc'].route).toMatchObject({
      method: 'POST',
      path: '/v1/observations/recording-batch',
      successStatus: 200,
    });
    expect(submitObservationsContract['~orpc'].route).toMatchObject({ method: 'POST', path: '/v1/observations/batch' });
    const legacy = { instrumentationVersion: 1, events: [event] };
    expect(ObservationBatchRequestSchema.parse(legacy)).toEqual(legacy);
    expect(RecordingObservationBatchRequestSchema.safeParse(legacy).success).toBe(false);
    expect(
      ObservationBatchResponseSchema.parse({ accepted: 1, duplicates: 0, rejected: 0, results: [result], revision: 6 }),
    ).toEqual({ accepted: 1, duplicates: 0, rejected: 0, results: [result], revision: 6 });
  });

  it('never downgrades missing/malformed new discriminators or optional generation into legacy input', () => {
    for (const value of [
      request,
      { ...request, version: undefined },
      { ...request, recordingGeneration: undefined },
      { ...request, version: 'observation-batch.v1' },
      { ...request, recordingGeneration: '3' },
      { ...request, recordingGeneration: null },
    ])
      expect(ObservationBatchRequestSchema.safeParse(value).success).toBe(false);
    for (const extra of [
      { version: undefined },
      { version: 'observation-batch.v1' },
      { recordingGeneration: undefined },
      { recordingGeneration: '3' },
      { recordingGeneration: 0 },
      { recordingGeneration: 2_147_483_648 },
      { on: true },
      { privacyEpoch: 2 },
      { accountId: base.assetId },
      { universeId: base.assetId },
    ])
      expect(RecordingObservationBatchRequestSchema.safeParse({ ...request, ...extra }).success).toBe(false);
  });

  it('retains event/instrumentation bounds and enforces the complete encoded batch byte ceiling', () => {
    for (const extra of [
      { events: [] },
      { events: Array(OBSERVATION_LIMITS.maxEventsPerBatch + 1).fill(event) },
      { instrumentationVersion: 0 },
      { instrumentationVersion: 1001 },
      { events: [{ ...event, payload: { blocks: [], raw: 'private' } }] },
    ])
      expect(RecordingObservationBatchRequestSchema.safeParse({ ...request, ...extra }).success).toBe(false);
    const large = coverage({
      blocks: Array.from({ length: OBSERVATION_LIMITS.maxBlocksPerCoverage }, () => ({
        blockId: 'a'.repeat(40),
        intervalsMs: Array.from({ length: OBSERVATION_LIMITS.maxIntervalsPerBlock }, () => [0, 86_400_000]),
        peakFraction: 1,
      })),
    });
    const oversized = { ...request, events: Array(OBSERVATION_LIMITS.maxEventsPerBatch).fill(large) };
    expect(InteractionEventSchema.safeParse(large).success).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(oversized)).length).toBeGreaterThan(
      OBSERVATION_LIMITS.maxBatchBytes,
    );
    expect(RecordingObservationBatchRequestSchema.safeParse(oversized).success).toBe(false);
  });

  it('closes exact processed counts over every ordered final result without claiming qualification', () => {
    expect(RecordingObservationBatchResponseSchema.parse(processed)).toEqual(processed);
    const mixed = {
      ...processed,
      accepted: 1,
      duplicates: 1,
      rejected: 1,
      results: [
        result,
        { ...result, status: 'duplicate' },
        { eventId: base.sessionId, status: 'rejected', reason: 'lineage_mismatch' },
      ],
    };
    expect(RecordingObservationBatchResponseSchema.parse(mixed)).toEqual(mixed);
    for (const extra of [
      { accepted: 2 },
      { duplicates: 1 },
      { rejected: 1 },
      { accepted: -1 },
      { accepted: 0.5 },
      { results: [] },
      { currentGeneration: 4 },
      { qualified: true },
      { accepted: 51, results: Array(51).fill(result) },
      { results: [{ ...result, status: 'pending' }] },
    ])
      expect(RecordingObservationBatchResponseSchema.safeParse({ ...processed, ...extra }).success).toBe(false);
  });

  it('has final all-batch not_recorded reasons, without partial acceptance or relabelled generations', () => {
    const paused = { ...snapshot, result: 'not_recorded', reason: 'recording_paused' };
    const stale = { ...paused, reason: 'recording_generation_stale', currentGeneration: 4 };
    expect(RecordingObservationBatchResponseSchema.parse(paused)).toEqual(paused);
    expect(RecordingObservationBatchResponseSchema.parse(stale)).toEqual(stale);
    expect(RecordingObservationBatchResponseSchema.parse({ ...stale, currentGeneration: 2 })).toBeDefined();
    for (const extra of [
      { reason: 'recording_generation_stale' },
      { reason: 'try_again' },
      { accepted: 0 },
      { results: [] },
      { events: [event] },
      { retryGeneration: 4 },
      { currentGeneration: 0 },
      { recordingGeneration: 0 },
    ])
      expect(RecordingObservationBatchResponseSchema.safeParse({ ...paused, ...extra }).success).toBe(false);
  });

  it('rejects private identity, event bodies and stale/unknown scope shapes in both outcome branches', () => {
    const paused = { ...snapshot, result: 'not_recorded', reason: 'recording_paused' };
    for (const response of [processed, paused])
      for (const extra of [
        { scope: { ...snapshot.scope, universeId: base.exposureId } },
        { scope: { ...snapshot.scope, privacyEpoch: 0 } },
        { scope: { ...snapshot.scope, accountId: 'private' } },
        { revision: -1 },
        { version: 'observation-batch.v3' },
        { raw: 'private' },
        { currentPolicy: { on: true } },
        { diagnostics: { provider: 'private' } },
      ])
        expect(RecordingObservationBatchResponseSchema.safeParse({ ...response, ...extra }).success).toBe(false);
  });
});
