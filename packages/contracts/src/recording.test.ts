import { describe, expect, it } from 'vitest';
import {
  RecordingGenerationSchema,
  RecordingPolicySchema,
  SetRecordingPolicySchema,
  RecordingPolicyReceiptSchema,
  RecordingPolicyAcceptanceSchema,
  RecordingPolicyReadSchema,
  ReadRecordingPolicySchema,
  RecordingProblemSchema,
  RecordingProblemIssueSchema,
  apiContract,
  privacyContract,
  type ProblemCode,
  problemDetails,
  recordingContract,
} from './index.js';

const id = '0199f0a0-0000-7000-8000-000000000001';
const other = '0199f0a0-0000-7000-8000-000000000002';
const version = 'recording-policy.v1' as const;
const command = { version, commandId: id, expectedPrivacyEpoch: 1, expectedRecordingGeneration: 1, on: false };
const receipt = {
  commandId: id,
  requestedPrivacyEpoch: 1,
  fromGeneration: 1,
  toGeneration: 2,
  on: false,
  changed: true,
  recordedAt: '2026-10-22T10:00:00.000Z',
};
const acceptance = { version, operation: 'privacy.recording-set', outcome: 'accepted', receipt, replayed: false };
const snapshot = {
  version,
  readId: other,
  scope: { accountId: other, privacyEpoch: 1 },
  revision: 5,
  policy: { on: false, generation: 2 },
};
const current = { ...snapshot, target: { kind: 'current' } };
const target = { kind: 'command' as const, commandId: id };
const recorded = { ...snapshot, target, status: 'recorded', receipt };
const absent = { ...snapshot, target, status: 'not_recorded' };

describe('recording-policy.v1 declaration (synthetic contract fixtures only)', () => {
  it('declares an exact stable command and keeps generation distinct from privacy epoch', () => {
    expect(SetRecordingPolicySchema.parse(command)).toEqual(command);
    expect(SetRecordingPolicySchema.parse({ ...command, expectedPrivacyEpoch: 7 })).toEqual({
      ...command,
      expectedPrivacyEpoch: 7,
    });
    expect(RecordingPolicyAcceptanceSchema.parse(acceptance)).toEqual(acceptance);
    expect(RecordingPolicyAcceptanceSchema.parse({ ...acceptance, replayed: true })).toEqual({
      ...acceptance,
      replayed: true,
    });
    // The operation conforms to infrastructure's module.operation convention.
    expect(acceptance.operation).toMatch(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/);
  });

  it('requires every expected authority field and refuses unknown/mixed commands', () => {
    for (const key of Object.keys(command)) {
      const missing: Record<string, unknown> = { ...command };
      delete missing[key];
      expect(SetRecordingPolicySchema.safeParse(missing).success).toBe(false);
    }
    for (const extra of [
      { accountId: id },
      { universeId: id },
      { generation: 4 },
      { learning: false },
      { export: true },
      { confirmation: 'delete-everything' },
      { recordedAt: receipt.recordedAt },
    ])
      expect(SetRecordingPolicySchema.safeParse({ ...command, ...extra }).success).toBe(false);
    for (const value of ['on', 0, null])
      expect(SetRecordingPolicySchema.safeParse({ ...command, on: value }).success).toBe(false);
    expect(SetRecordingPolicySchema.safeParse({ ...command, version: 'recording-policy.v2' }).success).toBe(false);
  });

  it('bounds generations/epochs/revisions and never coerces or wraps exhausted counters', () => {
    for (const generation of [1, 2, 2_147_483_647])
      expect(RecordingGenerationSchema.parse(generation)).toBe(generation);
    for (const generation of [0, -1, 1.5, 2_147_483_648, Number.MAX_SAFE_INTEGER, '1', NaN, Infinity]) {
      expect(RecordingGenerationSchema.safeParse(generation).success).toBe(false);
      expect(SetRecordingPolicySchema.safeParse({ ...command, expectedRecordingGeneration: generation }).success).toBe(
        false,
      );
      expect(RecordingPolicySchema.safeParse({ on: true, generation }).success).toBe(false);
    }
    expect(SetRecordingPolicySchema.safeParse({ ...command, expectedPrivacyEpoch: 0 }).success).toBe(false);
    expect(SetRecordingPolicySchema.safeParse({ ...command, expectedPrivacyEpoch: 2_147_483_648 }).success).toBe(false);
    expect(RecordingPolicyReadSchema.safeParse({ ...current, revision: -1 }).success).toBe(false);
    expect(RecordingPolicyReadSchema.safeParse({ ...current, revision: 2_147_483_648 }).success).toBe(false);
  });

  it('distinguishes a real single generation increment from a no-op, including exhaustion', () => {
    expect(RecordingPolicyReceiptSchema.parse(receipt)).toEqual(receipt);
    const noop = { ...receipt, toGeneration: 1, on: true, changed: false };
    expect(RecordingPolicyReceiptSchema.parse(noop)).toEqual(noop);
    for (const extra of [
      { on: true },
      { toGeneration: 1 },
      { toGeneration: 3 },
      { fromGeneration: 2, toGeneration: 1 },
      { changed: false },
      { fromGeneration: 2_147_483_647, toGeneration: 1 },
      { fromGeneration: 2_147_483_647, toGeneration: 2_147_483_648 },
    ])
      expect(RecordingPolicyReceiptSchema.safeParse({ ...receipt, ...extra }).success).toBe(false);
    expect(RecordingPolicySchema.safeParse({ on: false, generation: 1 }).success).toBe(false);
    expect(RecordingPolicyReceiptSchema.safeParse({ ...noop, on: false }).success).toBe(false);
    expect(
      RecordingPolicyReceiptSchema.parse({ ...noop, fromGeneration: 2_147_483_647, toGeneration: 2_147_483_647 }),
    ).toBeDefined();
  });

  it('keeps every generation consistent with initial on and only real boolean toggles', () => {
    for (const generation of [1, 2, 3, 4, 2_147_483_646, 2_147_483_647]) {
      const on = generation % 2 === 1;
      expect(RecordingPolicySchema.parse({ generation, on })).toEqual({ generation, on });
      expect(RecordingPolicySchema.safeParse({ generation, on: !on }).success).toBe(false);
      const noop = { ...receipt, fromGeneration: generation, toGeneration: generation, on, changed: false };
      expect(RecordingPolicyReceiptSchema.parse(noop)).toEqual(noop);
      expect(RecordingPolicyReceiptSchema.safeParse({ ...noop, on: !on }).success).toBe(false);
      if (generation < 2_147_483_647) {
        const toggled = { ...noop, toGeneration: generation + 1, on: !on, changed: true };
        expect(RecordingPolicyReceiptSchema.parse(toggled)).toEqual(toggled);
        expect(RecordingPolicyReceiptSchema.safeParse({ ...toggled, on }).success).toBe(false);
      }
    }
    expect(RecordingPolicyReadSchema.safeParse({ ...current, policy: { on: true, generation: 2 } }).success).toBe(
      false,
    );
    expect(
      RecordingPolicyAcceptanceSchema.safeParse({
        ...acceptance,
        receipt: { ...receipt, fromGeneration: 2, toGeneration: 3, on: false },
      }).success,
    ).toBe(false);
  });

  it('does not turn a historical acceptance into a current snapshot or authority', () => {
    for (const extra of [{ policy: snapshot.policy }, { scope: snapshot.scope }, { revision: 8 }, { current: true }])
      expect(RecordingPolicyAcceptanceSchema.safeParse({ ...acceptance, ...extra }).success).toBe(false);
    expect(
      RecordingPolicyAcceptanceSchema.safeParse({ ...acceptance, operation: 'privacy.recording.set' }).success,
    ).toBe(false);
    expect(RecordingPolicyAcceptanceSchema.safeParse({ ...acceptance, outcome: 'recording_on' }).success).toBe(false);
    expect(
      RecordingPolicyAcceptanceSchema.safeParse({ ...acceptance, receipt: { ...receipt, requestHash: 'private' } })
        .success,
    ).toBe(false);
  });

  it('supports pure current and exact command selectors with independent read correlation', () => {
    for (const selected of [{ kind: 'current' }, target]) {
      const read = { version, readId: other, target: selected };
      expect(ReadRecordingPolicySchema.parse(read)).toEqual(read);
    }
    for (const bad of [
      { version, target },
      { version, readId: 'invalid', target },
      { version, readId: other, target: { kind: 'latest' } },
      { version, readId: other, target: { kind: 'current', commandId: id } },
      { version, readId: other, target: { kind: 'command' } },
      { version, readId: other, target, retry: true },
      { version, readId: other, target, accountId: id },
    ])
      expect(ReadRecordingPolicySchema.safeParse(bad).success).toBe(false);
    for (const value of [current, recorded, absent]) expect(RecordingPolicyReadSchema.parse(value)).toEqual(value);
  });

  it('requires receipt presence only on a matching recorded command target', () => {
    const { receipt: _receipt, ...missing } = recorded;
    for (const bad of [
      missing,
      { ...absent, receipt },
      { ...current, receipt },
      { ...current, status: 'not_recorded' },
      { ...recorded, target: { ...target, commandId: other } },
      { ...recorded, target: { kind: 'current' } },
      { ...recorded, status: 'pending' },
      { ...recorded, receipt: { ...receipt, requestedPrivacyEpoch: 2 } },
    ])
      expect(RecordingPolicyReadSchema.safeParse(bad).success).toBe(false);
  });

  it('matches command UUID aliases without changing target, receipt or original command spelling', () => {
    const upper = id.toUpperCase();
    for (const [targetId, receiptId] of [[id, upper], [upper, id]]) {
      const value = {
        ...recorded,
        target: { ...target, commandId: targetId },
        receipt: { ...receipt, commandId: receiptId },
      };
      expect(RecordingPolicyReadSchema.parse(value)).toEqual(value);
      expect(
        RecordingPolicyReadSchema.safeParse({ ...value, target: { ...target, commandId: other.toUpperCase() } })
          .success,
      ).toBe(false);
    }
    expect(SetRecordingPolicySchema.parse({ ...command, commandId: upper }).commandId).toBe(upper);
  });

  it('allows historical receipts across Clear without regressing newer policy or epoch', () => {
    const oldOn = { ...receipt, fromGeneration: 2, toGeneration: 3, on: true };
    const laterPaused = {
      ...snapshot,
      scope: { ...snapshot.scope, privacyEpoch: 2 },
      policy: { on: false, generation: 4 },
    };
    const historical = { ...laterPaused, target, status: 'recorded', receipt: oldOn };
    expect(RecordingPolicyReadSchema.parse(historical)).toEqual(historical);
    expect(RecordingPolicyReadSchema.safeParse({ ...historical, policy: { on: false, generation: 3 } }).success).toBe(
      false,
    );
    expect(RecordingPolicyReadSchema.safeParse({ ...historical, policy: { on: true, generation: 2 } }).success).toBe(
      false,
    );
    expect(RecordingPolicyReadSchema.parse({ ...historical, policy: { on: true, generation: 3 } })).toBeDefined();
  });

  it('refuses private data, selectors and invented progress in all public snapshots', () => {
    for (const value of [current, absent, recorded, acceptance])
      for (const extra of [
        { events: [{ raw: 'private' }] },
        { provider: 'private' },
        { universeId: id },
        { queuePayload: { raw: true } },
        { progress: 100 },
        { backupExpiresAt: receipt.recordedAt },
        { detail: 'private' },
      ]) {
        const schema = value === acceptance ? RecordingPolicyAcceptanceSchema : RecordingPolicyReadSchema;
        expect(schema.safeParse({ ...value, ...extra }).success).toBe(false);
      }
    expect(
      RecordingPolicyReadSchema.safeParse({ ...current, policy: { ...current.policy, evidence: [] } }).success,
    ).toBe(false);
    expect(
      RecordingPolicyReadSchema.safeParse({ ...current, scope: { ...current.scope, universeId: id } }).success,
    ).toBe(false);
  });

  it('closes private problems over exact catalogue titles/status/types and bounded static issue tokens', () => {
    const errors = recordingContract.set['~orpc'].errorMap;
    expect(recordingContract.read['~orpc'].errorMap).toEqual(errors);
    expect(Object.keys(errors)).toEqual([
      'INVALID_REQUEST',
      'UNAUTHENTICATED',
      'FORBIDDEN',
      'ORIGIN_NOT_ALLOWED',
      'UNIVERSE_UNAVAILABLE',
      'PRIVACY_EPOCH_CHANGED',
      'SCOPE_MISMATCH',
      'CONFLICT',
      'COMMAND_KEY_REUSED',
      'RECORDING_POLICY_STALE',
      'RECORDING_GENERATION_REQUIRED',
      'RECORDING_GENERATION_EXHAUSTED',
      'PAYLOAD_TOO_LARGE',
      'UNSUPPORTED_MEDIA_TYPE',
      'UNPROCESSABLE_REQUEST',
      'TOO_MANY_REQUESTS',
      'SERVICE_UNAVAILABLE',
      'INTERNAL',
    ]);
    for (const [code, definition] of Object.entries(errors)) {
      const p = problemDetails(code as ProblemCode);
      expect(RecordingProblemSchema.parse(p)).toEqual(p);
      expect(definition.data.safeParse(p).success).toBe(true);
      for (const extra of [
        { status: 200 },
        { title: 'private' },
        { type: 'https://private' },
        { detail: 'private' },
        { instance: '/private' },
        { generation: 9 },
        { commandId: id },
        { received: 'private' },
      ])
        expect(RecordingProblemSchema.safeParse({ ...p, ...extra }).success).toBe(false);
    }
    const issue = { path: ['events', 'unknown'], code: 'invalid_type' };
    expect(RecordingProblemIssueSchema.parse(issue)).toEqual(issue);
    for (const path of [[0], ['0'], ['private-key'], ['__proto__'], Array(9).fill('events')])
      expect(RecordingProblemIssueSchema.safeParse({ ...issue, path }).success).toBe(false);
    expect(RecordingProblemIssueSchema.safeParse({ ...issue, received: 'private' }).success).toBe(false);
    const p = problemDetails('INVALID_REQUEST');
    expect(RecordingProblemSchema.parse({ ...p, issues: Array(32).fill(issue) })).toBeDefined();
    expect(RecordingProblemSchema.safeParse({ ...p, issues: Array(33).fill(issue) }).success).toBe(false);
  });

  it('declares only private read/set POSTs and leaves Clear bound to its original contract', () => {
    expect(Object.keys(recordingContract)).toEqual(['read', 'set']);
    expect(recordingContract.read['~orpc'].route).toMatchObject({
      method: 'POST',
      path: '/v1/privacy/recording/read',
      successStatus: 200,
    });
    expect(recordingContract.set['~orpc'].route).toMatchObject({
      method: 'POST',
      path: '/v1/privacy/recording/set',
      successStatus: 200,
    });
    expect(apiContract.privacy).toBe(privacyContract);
    expect(apiContract.recording).toBe(recordingContract);
    expect(Object.keys(apiContract.privacy)).toEqual(['clearExploration', 'readClearExplorationStatus']);
  });
});
