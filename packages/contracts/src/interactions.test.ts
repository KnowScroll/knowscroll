import { describe, expect, it } from 'vitest';
import {
  INTERACTION_SCHEMA_VERSION,
  InteractionEventSchema,
  OBSERVATION_LIMITS,
  ObservationBatchRequestSchema,
  SCROLL_INTERACTION_KINDS,
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
