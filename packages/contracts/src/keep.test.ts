import { describe, expect, it } from 'vitest';
import {
  KeepAssetRefSchema,
  KeepEntryRefSchema,
  KeepPositionSchema,
  ReadKeepEntrySchema,
  KeepEntrySnapshotSchema,
  SetKeepPlaceSchema,
  KeepPlaceAcceptanceSchema,
  KeepPlaceProblemSchema,
  KeepProblemIssueSchema,
  keepContract,
  problemCatalogue,
  problemTypeUri,
} from './index.js';

// Synthetic private protocol fixtures, not server/runtime evidence.
const id = '019b7dc2-83fe-7000-8000-000000000001';
const other = '019b7dc2-83fe-7000-8000-000000000002';
const target = { assetId: id, assetRevision: 2 };
const entry = { ...target, savedEntryId: other };
const scope = { accountId: id, privacyEpoch: 3 };
const version = 'keep-place.v1';
const reel = { kind: 'reel', positionMs: 1234.25 };
const scroll = { kind: 'scroll', blockId: 'intro-1', offsetWithinBlock: 12.75 };
const command = { version, commandId: id, entry, expectedPlaceRevision: 0, position: reel };
const acceptance = {
  version,
  scope,
  commandId: id,
  entry,
  recordedAt: '2026-10-21T10:00:00Z',
  replayed: false,
  outcome: 'accepted',
  operation: 'keep.place.set',
  basePlaceRevision: 0,
  acceptedPlaceRevision: 1,
};
const snapshot = {
  version,
  scope,
  target,
  status: 'available',
  entry,
  place: { status: 'set', placeRevision: 1, position: scroll },
};
function problem(code: keyof typeof problemCatalogue) {
  return { code, type: problemTypeUri(code), ...problemCatalogue[code] };
}

describe('keep-place.v1 declaration-only private wire', () => {
  it('round-trips JSON, canonical anchors and fractional logical pixels/milliseconds without coercion', () => {
    for (const position of [reel, scroll]) {
      expect(KeepPositionSchema.parse(JSON.parse(JSON.stringify(position)))).toEqual(position);
      expect(SetKeepPlaceSchema.parse({ ...command, position })).toEqual({ ...command, position });
    }
    expect(ReadKeepEntrySchema.parse({ version, target })).toEqual({ version, target });
    expect(KeepEntrySnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(KeepPlaceAcceptanceSchema.parse(acceptance)).toEqual(acceptance);
    // The safe numeric limit is a transport bound, not a 60s media or server layout policy.
    expect(KeepPositionSchema.parse({ ...reel, positionMs: Number.MAX_SAFE_INTEGER })).toBeDefined();
    expect(KeepPositionSchema.parse({ ...scroll, offsetWithinBlock: 60000.5 })).toBeDefined();
    for (const blockId of ['', 'a', 'Intro', 'intro.child', 'a'.repeat(41)]) {
      expect(KeepPositionSchema.safeParse({ ...scroll, blockId }).success).toBe(false);
    }
  });

  it('rejects nonfinite, negative, coercible and over-bound positions and revisions', () => {
    for (const value of [NaN, Infinity, -Infinity, -0.1, '12', null, Number.MAX_SAFE_INTEGER + 1]) {
      expect(KeepPositionSchema.safeParse({ ...reel, positionMs: value }).success).toBe(false);
      expect(KeepPositionSchema.safeParse({ ...scroll, offsetWithinBlock: value }).success).toBe(false);
    }
    for (const assetRevision of [0, -1, 1.5, '2', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(KeepAssetRefSchema.safeParse({ ...target, assetRevision }).success).toBe(false);
    }
    for (const expectedPlaceRevision of [-1, 0.5, '0', Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(SetKeepPlaceSchema.safeParse({ ...command, expectedPlaceRevision }).success).toBe(false);
    }
    expect(SetKeepPlaceSchema.safeParse({ ...command, expectedPlaceRevision: Number.MAX_SAFE_INTEGER }).success).toBe(
      true,
    );
    expect(KeepEntryRefSchema.safeParse({ ...entry, savedEntryId: 'not-a-membership' }).success).toBe(false);
  });

  it('binds snapshots to the exact immutable Saved reference and closes unavailable branches', () => {
    for (const mismatch of [
      { ...entry, assetId: other },
      { ...entry, assetRevision: 3 },
    ]) {
      for (const status of ['available', 'saved_unavailable']) {
        const value =
          status === 'available'
            ? { ...snapshot, entry: mismatch }
            : { version, scope, target, status, entry: mismatch };
        expect(KeepEntrySnapshotSchema.safeParse(value).success).toBe(false);
      }
    }
    const unavailable = { version, scope, target, status: 'saved_unavailable', entry };
    expect(KeepEntrySnapshotSchema.parse(unavailable)).toEqual(unavailable);
    const absent = { version, scope, target, status: 'not_saved' };
    expect(KeepEntrySnapshotSchema.parse(absent)).toEqual(absent);
    for (const extra of [
      { position: reel },
      { place: snapshot.place },
      { title: 'private' },
      { currentAssetRevision: 4 },
      { savedAt: '2026-10-21T10:00:00Z' },
      { source: 'secret' },
    ]) {
      expect(KeepEntrySnapshotSchema.safeParse({ ...unavailable, ...extra }).success).toBe(false);
      expect(KeepEntrySnapshotSchema.safeParse({ ...absent, ...extra }).success).toBe(false);
    }
    expect(KeepEntrySnapshotSchema.safeParse({ ...absent, entry }).success).toBe(false);
    expect(
      KeepEntrySnapshotSchema.safeParse({ ...snapshot, place: { status: 'none', placeRevision: 0 } }).success,
    ).toBe(true);
    for (const place of [
      { status: 'none', placeRevision: 1 },
      { status: 'none', placeRevision: 0, position: reel },
      { status: 'set', placeRevision: 0, position: reel },
      { status: 'set', placeRevision: 1 },
    ]) {
      expect(KeepEntrySnapshotSchema.safeParse({ ...snapshot, place }).success).toBe(false);
    }
  });

  it('requires exactly one safe CAS increment in immutable acceptance without embedding current state', () => {
    expect(
      KeepPlaceAcceptanceSchema.safeParse({
        ...acceptance,
        basePlaceRevision: Number.MAX_SAFE_INTEGER - 1,
        acceptedPlaceRevision: Number.MAX_SAFE_INTEGER,
        replayed: true,
      }).success,
    ).toBe(true);
    for (const [basePlaceRevision, acceptedPlaceRevision] of [
      [0, 0],
      [1, 1],
      [1, 3],
      [2, 1],
      [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
      [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1],
    ]) {
      expect(
        KeepPlaceAcceptanceSchema.safeParse({ ...acceptance, basePlaceRevision, acceptedPlaceRevision }).success,
      ).toBe(false);
    }
    for (const extra of [
      { position: reel },
      { currentPlaceRevision: 2 },
      { place: snapshot.place },
      { exposureId: id },
      { observedAt: 1 },
      { grant: 'secret' },
    ]) {
      expect(KeepPlaceAcceptanceSchema.safeParse({ ...acceptance, ...extra }).success).toBe(false);
    }
  });

  it('rejects malformed new branches and unknown/private fields at every input and snapshot nesting level', () => {
    for (const extra of [
      { exposureId: id },
      { playhead: 1 },
      { muted: true },
      { source: 'secret' },
      { url: 'https://secret.invalid' },
      { metadata: {} },
      { clear: true },
      { accountId: id },
    ]) {
      expect(SetKeepPlaceSchema.safeParse({ ...command, ...extra }).success).toBe(false);
      expect(ReadKeepEntrySchema.safeParse({ version, target, ...extra }).success).toBe(false);
    }
    const inputs = [
      { ...command, version: 'keep-place.v2' },
      { ...command, entry: { ...entry, privateId: id } },
      { ...command, position: { ...reel, offsetWithinBlock: 1 } },
      { ...command, position: { ...scroll, positionMs: 1 } },
      { ...command, position: { kind: 'unknown', positionMs: 1 } },
      { ...command, position: [] },
      { ...command, entry: { ...target } },
    ];
    for (const value of inputs) expect(SetKeepPlaceSchema.safeParse(value).success).toBe(false);
    for (const value of [
      { ...snapshot, scope: { ...scope, universeId: id } },
      { ...snapshot, target: { ...target, currentAssetRevision: 3 } },
      { ...snapshot, entry: { ...entry, savedAt: 'private' } },
      { ...snapshot, place: { ...snapshot.place, personalWatermark: 1 } },
      { ...snapshot, place: { ...snapshot.place, position: { ...scroll, viewport: 99 } } },
      { ...snapshot, status: 'corrected' },
      { ...snapshot, status: 'not_saved' },
    ])
      expect(KeepEntrySnapshotSchema.safeParse(value).success).toBe(false);
  });

  it('has a finite correlated RFC9457 problem union and reveals a revision only for authorised CAS staleness', () => {
    const definitions = keepContract.setPlace['~orpc'].errorMap;
    expect(Object.keys(definitions)).toHaveLength(16);
    for (const code of Object.keys(definitions) as (keyof typeof definitions)[]) {
      const document = {
        ...problem(code),
        ...(code === 'KEEP_PLACE_REVISION_STALE' ? { currentPlaceRevision: 0 } : {}),
      };
      expect(KeepPlaceProblemSchema.parse(document)).toEqual(document);
      for (const extra of [
        { detail: 'secret' },
        { instance: '/private/id' },
        { position: reel },
        { entry },
        { accountId: id },
        { message: 'private' },
      ]) {
        expect(KeepPlaceProblemSchema.safeParse({ ...document, ...extra }).success).toBe(false);
      }
      expect(KeepPlaceProblemSchema.safeParse({ ...document, status: 418 }).success).toBe(false);
      expect(KeepPlaceProblemSchema.safeParse({ ...document, title: 'private' }).success).toBe(false);
      expect(KeepPlaceProblemSchema.safeParse({ ...document, type: 'https://private.invalid' }).success).toBe(false);
      if (code !== 'KEEP_PLACE_REVISION_STALE') {
        expect(KeepPlaceProblemSchema.safeParse({ ...document, currentPlaceRevision: 0 }).success).toBe(false);
      }
    }
    expect(KeepPlaceProblemSchema.safeParse(problem('KEEP_PLACE_REVISION_STALE')).success).toBe(false);
    expect(KeepPlaceProblemSchema.safeParse(problem('NOT_FOUND')).success).toBe(false);
    expect(
      KeepPlaceProblemSchema.safeParse({ ...problem('KEEP_PLACE_REVISION_STALE'), currentPlaceRevision: -1 }).success,
    ).toBe(false);
  });

  it('allows only bounded static field-token issue paths, never rejected keys, values or numeric segments', () => {
    for (const path of [[], ['position', 'blockId'], ['unknown']]) {
      expect(KeepProblemIssueSchema.parse({ path, code: 'unrecognized_keys' })).toEqual({
        path,
        code: 'unrecognized_keys',
      });
    }
    for (const path of [
      ['secret-canary-key'],
      ['email'],
      [0],
      ['position', 0],
      ['0'],
      ['positionMs', 'rejected-value-canary'],
      Array(9).fill('position'),
    ]) {
      expect(KeepProblemIssueSchema.safeParse({ path, code: 'custom' }).success).toBe(false);
    }
    for (const extra of [{ value: 'secret' }, { keys: ['secret'] }, { message: 'secret' }]) {
      expect(KeepProblemIssueSchema.safeParse({ path: [], code: 'custom', ...extra }).success).toBe(false);
    }
    expect(KeepProblemIssueSchema.safeParse({ path: [], code: 'secret' }).success).toBe(false);
    const issue = { path: ['position'], code: 'custom' };
    expect(
      KeepPlaceProblemSchema.safeParse({ ...problem('INVALID_REQUEST'), issues: Array(32).fill(issue) }).success,
    ).toBe(true);
    expect(
      KeepPlaceProblemSchema.safeParse({ ...problem('INVALID_REQUEST'), issues: Array(33).fill(issue) }).success,
    ).toBe(false);
  });
});
