import { describe, expect, it } from 'vitest';
import {
  RemoveKeepEntrySchema,
  KeepRemovalAcceptanceSchema,
  KeepRemovalProblemSchema,
  KeepRemovalProblemIssueSchema,
  removeKeepEntryContract,
  apiContract,
  problemCatalogue,
  problemTypeUri,
} from './index.js';

// Synthetic wire fixtures only. UUID parsing cannot establish current membership or authority.
const id = '019b7dc2-83fe-7000-8000-000000000001';
const member = '019b7dc2-83fe-7000-8000-000000000002';
const replacement = '019b7dc2-83fe-7000-8000-000000000003';
const entry = { assetId: id, assetRevision: 2, savedEntryId: member };
const command = { version: 'keep-remove.v1', commandId: id, entry };
const acceptance = {
  ...command,
  scope: { accountId: id, privacyEpoch: 3 },
  recordedAt: '2026-10-21T10:00:00Z',
  replayed: false,
  outcome: 'accepted',
  operation: 'keep.entry.remove',
};
const problem = (code: keyof typeof problemCatalogue) => ({
  type: problemTypeUri(code),
  code,
  ...problemCatalogue[code],
});

describe('keep-remove.v1 declaration-only membership command', () => {
  it('requires an exact Saved UUID and immutable asset reference without coercion or defaults', () => {
    expect(RemoveKeepEntrySchema.parse(JSON.parse(JSON.stringify(command)))).toEqual(command);
    // A later membership is a different command body, even for the same asset/revision.
    const next = { ...command, entry: { ...entry, savedEntryId: replacement } };
    expect(RemoveKeepEntrySchema.parse(next)).toEqual(next);
    expect(next).not.toEqual(command);
    for (const missing of [undefined, null, {}, { assetId: id }, { assetId: id, assetRevision: 2 }])
      expect(RemoveKeepEntrySchema.safeParse({ ...command, entry: missing }).success).toBe(false);
    for (const revision of [0, -1, 1.5, '2', Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(
        RemoveKeepEntrySchema.safeParse({ ...command, entry: { ...entry, assetRevision: revision } }).success,
      ).toBe(false);
    for (const savedEntryId of ['', 'not-a-membership', null, 2])
      expect(RemoveKeepEntrySchema.safeParse({ ...command, entry: { ...entry, savedEntryId } }).success).toBe(false);
  });

  it('rejects private state, position changes, identity overrides and legacy asset-only removal', () => {
    for (const extra of [
      { accountId: id },
      { universeId: id },
      { privacyEpoch: 3 },
      { force: true },
      { expectedPlaceRevision: 1 },
      { position: { kind: 'reel', positionMs: 12 } },
      { exposureId: id },
      { currentSavedEntryId: replacement },
      { detail: 'private text' },
    ])
      expect(RemoveKeepEntrySchema.safeParse({ ...command, ...extra }).success).toBe(false);
    expect(
      RemoveKeepEntrySchema.safeParse({ ...command, entry: { ...entry, savedAt: '2026-10-21T10:00:00Z' } }).success,
    ).toBe(false);
    for (const version of ['keep-place.v1', 'keep-remove.v2', null, 1])
      expect(RemoveKeepEntrySchema.safeParse({ ...command, version }).success).toBe(false);
    expect(RemoveKeepEntrySchema.safeParse({ version: 'keep-remove.v1', commandId: id, assetId: id }).success).toBe(
      false,
    );
  });

  it('keeps acknowledgements historical and position-free, including identical-body replay', () => {
    expect(KeepRemovalAcceptanceSchema.parse(acceptance)).toEqual(acceptance);
    expect(KeepRemovalAcceptanceSchema.parse({ ...acceptance, replayed: true })).toEqual({
      ...acceptance,
      replayed: true,
    });
    for (const extra of [
      { currentEntry: { ...entry, savedEntryId: replacement } },
      { currentlyAbsent: true },
      { position: { kind: 'scroll', blockId: 'intro', offsetWithinBlock: 1 } },
      { removedCount: 1 },
      { currentPlaceRevision: 5 },
      { undoToken: 'secret' },
    ])
      expect(KeepRemovalAcceptanceSchema.safeParse({ ...acceptance, ...extra }).success).toBe(false);
    expect(KeepRemovalAcceptanceSchema.safeParse({ ...acceptance, operation: 'action.unsave' }).success).toBe(false);
    expect(
      KeepRemovalAcceptanceSchema.safeParse({ ...acceptance, scope: { accountId: id, privacyEpoch: 0 } }).success,
    ).toBe(false);
    expect(
      KeepRemovalAcceptanceSchema.safeParse({
        ...acceptance,
        scope: { accountId: id, privacyEpoch: 3, currentEntry: replacement },
      }).success,
    ).toBe(false);
  });

  it('uses a closed direct problem family without replacement identity or rejected-value echoes', () => {
    const errors = removeKeepEntryContract['~orpc'].errorMap;
    expect(Object.keys(errors)).toHaveLength(14);
    for (const [code, definition] of Object.entries(errors)) {
      const value = problem(code as keyof typeof problemCatalogue);
      expect(definition.status).toBe(value.status);
      expect(KeepRemovalProblemSchema.parse(value)).toEqual(value);
      for (const extra of [
        { detail: 'private' },
        { instance: '/private' },
        { currentEntry: replacement },
        { currentPlaceRevision: 1 },
      ])
        expect(KeepRemovalProblemSchema.safeParse({ ...value, ...extra }).success).toBe(false);
    }
    for (const code of ['KEEP_PLACE_REVISION_STALE', 'KEEP_PLACE_COUNTER_EXHAUSTED', 'ASSET_NOT_FOUND'] as const)
      expect(KeepRemovalProblemSchema.safeParse(problem(code)).success).toBe(false);
    expect(KeepRemovalProblemIssueSchema.parse({ path: ['entry', 'savedEntryId'], code: 'invalid_format' })).toEqual({
      path: ['entry', 'savedEntryId'],
      code: 'invalid_format',
    });
    for (const path of [['received-secret'], ['entry', 0], ['position'], ['entry', 'currentSavedEntryId']])
      expect(KeepRemovalProblemIssueSchema.safeParse({ path, code: 'invalid_type' }).success).toBe(false);
    expect(
      KeepRemovalProblemSchema.safeParse({
        ...problem('INVALID_REQUEST'),
        issues: Array(33).fill({ path: [], code: 'invalid_type' }),
      }).success,
    ).toBe(false);
    expect(
      KeepRemovalProblemSchema.safeParse({ ...problem('KEEP_ENTRY_UNAVAILABLE'), title: 'replacement membership' })
        .success,
    ).toBe(false);
  });

  it('declares a scoped JSON POST only; this installs no HTTP handler or permission', () => {
    expect(apiContract.keep.remove).toBe(removeKeepEntryContract);
    expect(removeKeepEntryContract['~orpc'].route).toMatchObject({
      method: 'POST',
      path: '/v1/experience/keep/remove',
      successStatus: 200,
    });
    expect(removeKeepEntryContract['~orpc'].inputSchema).toBe(RemoveKeepEntrySchema);
    expect(removeKeepEntryContract['~orpc'].outputSchema).toBe(KeepRemovalAcceptanceSchema);
  });
});
