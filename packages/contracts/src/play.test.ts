import { describe, expect, it } from 'vitest';
import {
  CallLockRequestSchema,
  CallLockResponseSchema,
  ReadLandmarksResponseSchema,
  ReadScrollResultsRequestSchema,
  ScrollResultsSchema,
  apiContract,
  playContract,
} from './index.js';

// Synthetic wire fixtures only.
const id = (n: number) => `019b7dc2-83fe-7000-8000-${String(n).padStart(12, '0')}`;
const lock = { commandId: id(1), assetId: id(2), revision: 3, stopId: 'call-june', option: 1, recordingGeneration: 1 };
const results = {
  assetId: id(2),
  revision: 3,
  calls: [{ stopId: 'call-june', option: 1, correct: true }],
  sparks: 1,
  combo: 1,
};

describe('locking a call', () => {
  it('names the revision, the stop and one of at most three options, and nothing about correctness', () => {
    expect(CallLockRequestSchema.parse(lock)).toEqual(lock);
    for (const extra of [{ correct: true }, { answer: 1 }, { sparks: 3 }])
      expect(CallLockRequestSchema.safeParse({ ...lock, ...extra }).success).toBe(false);
  });

  it('refuses an option past the third and a stop that is not a local id', () => {
    for (const option of [3, -1, 1.5]) expect(CallLockRequestSchema.safeParse({ ...lock, option }).success).toBe(false);
    expect(CallLockRequestSchema.safeParse({ ...lock, stopId: 'Not A Stop' }).success).toBe(false);
    expect(CallLockRequestSchema.safeParse({ ...lock, revision: 0 }).success).toBe(false);
  });

  it('needs the recording generation the client last read', () => {
    const { recordingGeneration: _omitted, ...without } = lock;
    expect(CallLockRequestSchema.safeParse(without).success).toBe(false);
  });

  it('answers either what is on record or that nothing was stored', () => {
    expect(
      CallLockResponseSchema.safeParse({
        recorded: true,
        commandId: id(1),
        assetId: id(2),
        revision: 3,
        stopId: 'call-june',
        option: 1,
        correct: true,
        newlyLocked: true,
        results,
        replayed: false,
      }).success,
    ).toBe(true);
    expect(
      CallLockResponseSchema.safeParse({ recorded: false, reason: 'recording_paused', currentGeneration: 2 }).success,
    ).toBe(true);
    // A paused answer says nothing about the call.
    expect(
      CallLockResponseSchema.safeParse({
        recorded: false,
        reason: 'recording_paused',
        currentGeneration: 2,
        correct: true,
      }).success,
    ).toBe(false);
  });
});

describe('results', () => {
  it("are one Scroll revision's calls, sparks and combo, never a total across Scrolls", () => {
    expect(ReadScrollResultsRequestSchema.parse({ assetId: id(2), revision: 3 })).toEqual({
      assetId: id(2),
      revision: 3,
    });
    expect(ScrollResultsSchema.parse(results)).toEqual(results);
    for (const extra of [{ totalSparks: 40 }, { level: 3 }, { rank: 1 }])
      expect(ScrollResultsSchema.safeParse({ ...results, ...extra }).success).toBe(false);
  });

  it('are served by three routes, all under /v1/play', () => {
    expect(Object.keys(apiContract.play).sort()).toEqual(['lockCall', 'readLandmarks', 'readResults']);
    expect(playContract.lockCall['~orpc'].route.path).toBe('/v1/play/calls/lock');
    expect(playContract.readResults['~orpc'].route.path).toBe('/v1/play/results/read');
    expect(playContract.readLandmarks['~orpc'].route.path).toBe('/v1/play/landmarks/read');
  });

  it('carry the landmark the Final call awarded, with its finish, and allow five sparks (the combo bonus)', () => {
    const awarded = { key: 'the-leaning-axis', name: 'The Leaning Axis', tier: 'gold' };
    expect(ScrollResultsSchema.parse({ ...results, sparks: 5, landmark: awarded }).landmark).toEqual(awarded);
    expect(ScrollResultsSchema.safeParse({ ...results, sparks: 6 }).success).toBe(false);
    for (const tier of ['silver', 'GOLD', ''])
      expect(ScrollResultsSchema.safeParse({ ...results, landmark: { ...awarded, tier } }).success).toBe(false);
    expect(ScrollResultsSchema.safeParse({ ...results, landmark: { ...awarded, points: 9 } }).success).toBe(false);
  });
});

describe('the list of landmarks', () => {
  it('is their own, newest first, with the finish and the day, and no score', () => {
    const entry = {
      assetId: id(2),
      revision: 3,
      key: 'the-leaning-axis',
      name: 'The Leaning Axis',
      tier: 'plain',
      earnedAt: '2026-10-31T10:00:00.000Z',
    };
    expect(ReadLandmarksResponseSchema.parse({ landmarks: [entry] })).toEqual({ landmarks: [entry] });
    expect(ReadLandmarksResponseSchema.safeParse({ landmarks: [{ ...entry, sparks: 3 }] }).success).toBe(false);
    expect(ReadLandmarksResponseSchema.safeParse({ landmarks: [], total: 1 }).success).toBe(false);
  });
});
