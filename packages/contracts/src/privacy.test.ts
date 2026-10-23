import { describe, expect, it } from 'vitest';
import {
  ClearExplorationSchema,
  ClearExplorationReceiptSchema,
  ClearExplorationAcceptanceSchema,
  ClearExplorationStatusTargetSchema,
  ReadClearExplorationStatusSchema,
  ClearExplorationStatusSchema,
  ClearExplorationPhaseSchema,
  ClearExplorationFailureCodeSchema,
  PrivacyProblemIssueSchema,
  PrivacyProblemSchema,
  privacyContract,
  ProblemDetailsSchema,
  problemCatalogue,
  problemTypeUri,
} from './index.js';

// Synthetic wire fixtures only; no operation, deletion, authorization or preserved data is created.
const id = '019b7dc2-83fe-7000-8000-000000000001';
const other = '019b7dc2-83fe-7000-8000-000000000002';
const version = 'clear-exploration.v1';
const command = {
  version,
  commandId: id,
  expectedPrivacyEpoch: 3,
  confirmation: 'clear-exploration-preserve-keep-and-social',
};
const receipt = { commandId: id, fromEpoch: 3, toEpoch: 4, recordedAt: '2026-10-21T10:00:00Z' };
const acceptance = {
  version,
  ...receipt,
  outcome: 'accepted',
  operation: 'privacy.clear-exploration',
  replayed: false,
};
const scope = { accountId: id, privacyEpoch: 6 };
const target = { kind: 'command', commandId: id };
const base = { version, scope, target };
const pending = { ...base, status: 'pending', receipt, phase: 'removing_live_data' };
const failure = {
  ...base,
  status: 'failed',
  receipt,
  phase: 'waiting_for_accounting',
  code: 'temporarily_unavailable',
};
const completed = { ...base, status: 'completed_live', receipt };
const absent = { ...base, status: 'not_recorded' };
function problem(code: keyof typeof problemCatalogue) {
  return { code, type: problemTypeUri(code), ...problemCatalogue[code] };
}

describe('clear-exploration.v1 strict declaration-only lifecycle', () => {
  it('round-trips exact explicit intent and immutable acceptance without transformation', () => {
    expect(ClearExplorationSchema.parse(JSON.parse(JSON.stringify(command)))).toEqual(command);
    expect(ClearExplorationReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(ClearExplorationAcceptanceSchema.parse(acceptance)).toEqual(acceptance);
    expect(ClearExplorationAcceptanceSchema.parse({ ...acceptance, replayed: true })).toEqual({
      ...acceptance,
      replayed: true,
    });
    // Receipt history has no current scope/authorization field to mint a client session from.
    expect(ClearExplorationAcceptanceSchema.safeParse({ ...acceptance, scope }).success).toBe(false);
  });

  it('requires current-epoch input representation, explicit confirmation and the exact supported version', () => {
    for (const key of Object.keys(command)) {
      const incomplete: Record<string, unknown> = { ...command };
      delete incomplete[key];
      expect(ClearExplorationSchema.safeParse(incomplete).success).toBe(false);
    }
    for (const expectedPrivacyEpoch of [0, -1, 0.5, '3', null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(ClearExplorationSchema.safeParse({ ...command, expectedPrivacyEpoch }).success).toBe(false);
    // Exhaustion is a backend no-effects refusal, not integer coercion or overflow.
    expect(ClearExplorationSchema.parse({ ...command, expectedPrivacyEpoch: Number.MAX_SAFE_INTEGER })).toBeDefined();
    for (const confirmation of [
      '',
      true,
      'clear-all',
      'clear-exploration',
      'clear-exploration-preserve-keep-and-social ',
    ])
      expect(ClearExplorationSchema.safeParse({ ...command, confirmation }).success).toBe(false);
    for (const version of ['', 'clear-exploration.v2', null])
      expect(ClearExplorationSchema.safeParse({ ...command, version }).success).toBe(false);
    expect(ClearExplorationSchema.safeParse({ ...command, commandId: 'not-a-command' }).success).toBe(false);
  });

  it('allows precisely one safe epoch increment, including the final representable increment', () => {
    for (const [fromEpoch, toEpoch] of [
      [3, 3],
      [3, 5],
      [4, 3],
      [0, 1],
      [3.5, 4.5],
      [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1],
    ]) {
      expect(ClearExplorationReceiptSchema.safeParse({ ...receipt, fromEpoch, toEpoch }).success).toBe(false);
      expect(ClearExplorationAcceptanceSchema.safeParse({ ...acceptance, fromEpoch, toEpoch }).success).toBe(false);
    }
    const last = { fromEpoch: Number.MAX_SAFE_INTEGER - 1, toEpoch: Number.MAX_SAFE_INTEGER };
    expect(ClearExplorationReceiptSchema.parse({ ...receipt, ...last })).toEqual({ ...receipt, ...last });
    expect(ClearExplorationAcceptanceSchema.parse({ ...acceptance, ...last })).toEqual({ ...acceptance, ...last });
    for (const extra of [
      { status: 'completed_live' },
      { completed: true },
      { backupExpiresAt: '2026-10-22' },
      { currentEpoch: 4 },
      { outcome: 'completed' },
      { operation: 'privacy.delete-account' },
    ])
      expect(ClearExplorationAcceptanceSchema.safeParse({ ...acceptance, ...extra }).success).toBe(false);
  });

  it('has only exact command or latest selectors and no private IDs in route paths', () => {
    for (const target of [{ kind: 'latest' }, { kind: 'command', commandId: id }]) {
      expect(ClearExplorationStatusTargetSchema.parse(target)).toEqual(target);
      expect(ReadClearExplorationStatusSchema.parse({ version, target })).toEqual({ version, target });
    }
    for (const target of [
      { kind: 'latest', commandId: id },
      { kind: 'command' },
      { kind: 'command', commandId: 'secret' },
      { kind: 'account', accountId: id },
      { kind: 'latest', cursor: 'private' },
    ])
      expect(ReadClearExplorationStatusSchema.safeParse({ version, target }).success).toBe(false);
    expect(ReadClearExplorationStatusSchema.safeParse({ version, target, commandId: id }).success).toBe(false);
  });

  it('separates absent, pending, failed and verified controllable live completion without fabricated progress', () => {
    for (const value of [absent, pending, failure, completed]) {
      expect(ClearExplorationStatusSchema.parse(value)).toEqual(value);
      expect(ClearExplorationStatusSchema.parse({ ...value, target: { kind: 'latest' } })).toEqual({
        ...value,
        target: { kind: 'latest' },
      });
    }
    for (const phase of ClearExplorationPhaseSchema.options)
      expect(ClearExplorationStatusSchema.parse({ ...pending, phase })).toEqual({ ...pending, phase });
    for (const code of ClearExplorationFailureCodeSchema.options)
      expect(ClearExplorationStatusSchema.parse({ ...failure, code })).toEqual({ ...failure, code });
    for (const extra of [
      { receipt },
      { phase: 'waiting_for_accounting' },
      { code: 'temporarily_unavailable' },
      { replayed: true },
    ])
      expect(ClearExplorationStatusSchema.safeParse({ ...absent, ...extra }).success).toBe(false);
    for (const value of [
      { ...pending, phase: 'scene_owner' },
      { ...pending, phase: 'complete' },
      { ...pending, code: 'temporarily_unavailable' },
      { ...failure, code: 'provider_raw_error' },
      { ...completed, phase: 'verifying_live_removal' },
      { ...completed, code: 'temporarily_unavailable' },
      { ...completed, status: 'completed' },
    ])
      expect(ClearExplorationStatusSchema.safeParse(value).success).toBe(false);
    for (const status of ['pending', 'failed', 'completed_live']) {
      const value: Record<string, unknown> = {
        ...(status === 'pending' ? pending : status === 'failed' ? failure : completed),
      };
      delete value['receipt'];
      expect(ClearExplorationStatusSchema.safeParse(value).success).toBe(false);
    }
  });

  it('binds exact command selection while historical epochs never roll back current scope', () => {
    expect(ClearExplorationStatusSchema.parse(pending)).toMatchObject({
      scope: { privacyEpoch: 6 },
      receipt: { toEpoch: 4 },
    });
    expect(
      ClearExplorationStatusSchema.safeParse({ ...pending, target: { kind: 'command', commandId: other } }).success,
    ).toBe(false);
    expect(ClearExplorationStatusSchema.safeParse({ ...pending, receipt: { ...receipt, toEpoch: 5 } }).success).toBe(
      false,
    );
    expect(ClearExplorationStatusSchema.safeParse({ ...pending, scope: { ...scope, privacyEpoch: 3 } }).success).toBe(
      false,
    );
    expect(ClearExplorationStatusSchema.parse({ ...pending, scope: { ...scope, privacyEpoch: 4 } })).toBeDefined();
    for (const value of [
      { ...pending, scope: { ...scope, ownerId: other } },
      { ...pending, scope: { ...scope, accountId: 'private' } },
      { ...pending, receipt: { ...receipt, requestHash: 'private' } },
    ])
      expect(ClearExplorationStatusSchema.safeParse(value).success).toBe(false);
  });

  it('refuses private payloads, arbitrary owner selectors and retention promises on every state', () => {
    const extras = [
      { universeId: id },
      { accountId: id },
      { tables: ['evidence.observations'] },
      { timeRange: { from: 0 } },
      { provider: 'private' },
      { detail: 'private' },
      { counts: { saved: 2 } },
      { progress: 50 },
      { preservedItems: [id] },
      { backupExpiresAt: '2026-10-22T00:00:00Z' },
      { request: command },
      { queuePayload: { raw: 'private' } },
    ];
    for (const extra of extras) {
      expect(ClearExplorationSchema.safeParse({ ...command, ...extra }).success).toBe(false);
      expect(ReadClearExplorationStatusSchema.safeParse({ version, target, ...extra }).success).toBe(false);
      expect(ClearExplorationAcceptanceSchema.safeParse({ ...acceptance, ...extra }).success).toBe(false);
      for (const status of [absent, pending, failure, completed])
        expect(ClearExplorationStatusSchema.safeParse({ ...status, ...extra }).success).toBe(false);
    }
  });

  it('defines a closed local catalogue family, including busy/counter refusal without broadening global problems', () => {
    const errors = privacyContract.clearExploration['~orpc'].errorMap;
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
      'PAYLOAD_TOO_LARGE',
      'UNSUPPORTED_MEDIA_TYPE',
      'UNPROCESSABLE_REQUEST',
      'SERVICE_UNAVAILABLE',
      'INTERNAL',
    ]);
    expect(privacyContract.readClearExplorationStatus['~orpc'].errorMap).toEqual(errors);
    for (const [code, error] of Object.entries(errors)) {
      const value = problem(code as keyof typeof problemCatalogue);
      expect(PrivacyProblemSchema.parse(value)).toEqual(value);
      expect(error.data.safeParse(value).success).toBe(true);
      expect(PrivacyProblemSchema.safeParse({ ...value, status: 202 }).success).toBe(false);
      expect(PrivacyProblemSchema.safeParse({ ...value, title: 'private' }).success).toBe(false);
      expect(PrivacyProblemSchema.safeParse({ ...value, type: 'https://private' }).success).toBe(false);
      for (const extra of [
        { detail: 'private' },
        { instance: '/private' },
        { accountId: id },
        { receipt },
        { code: 'CLEAR_EVERYTHING' },
      ])
        expect(PrivacyProblemSchema.safeParse({ ...value, ...extra }).success).toBe(false);
    }
    // The established global schema still strips unknowns and accepts its existing optional fields.
    expect(
      ProblemDetailsSchema.parse({
        ...problem('INVALID_REQUEST'),
        detail: 'legacy',
        instance: '/legacy',
        legacyUnknown: true,
      }),
    ).toEqual({ ...problem('INVALID_REQUEST'), detail: 'legacy', instance: '/legacy' });
  });

  it('permits only bounded static issue tokens and never reflects attacker-selected keys/indices/values', () => {
    const issue = { path: ['target', 'commandId'], code: 'invalid_format' };
    expect(PrivacyProblemIssueSchema.parse(issue)).toEqual(issue);
    for (const path of [[], ['unknown'], ['version'], ['expectedPrivacyEpoch']])
      expect(PrivacyProblemIssueSchema.parse({ ...issue, path })).toEqual({ ...issue, path });
    for (const path of [
      ['private-email@example.test'],
      ['__proto__'],
      [0],
      ['0'],
      ['target', 1],
      Array(9).fill('target'),
    ])
      expect(PrivacyProblemIssueSchema.safeParse({ ...issue, path }).success).toBe(false);
    expect(PrivacyProblemIssueSchema.safeParse({ ...issue, received: 'private' }).success).toBe(false);
    expect(PrivacyProblemIssueSchema.safeParse({ ...issue, code: 'model-chosen' }).success).toBe(false);
    expect(PrivacyProblemSchema.parse({ ...problem('INVALID_REQUEST'), issues: Array(32).fill(issue) })).toBeDefined();
    expect(
      PrivacyProblemSchema.safeParse({ ...problem('INVALID_REQUEST'), issues: Array(33).fill(issue) }).success,
    ).toBe(false);
  });

  it('declares only scoped private POST acceptance202 and read-only status200 without a consumer', () => {
    expect(privacyContract.clearExploration['~orpc'].route).toMatchObject({
      method: 'POST',
      path: '/v1/privacy/clear-exploration',
      successStatus: 202,
    });
    expect(privacyContract.readClearExplorationStatus['~orpc'].route).toMatchObject({
      method: 'POST',
      path: '/v1/privacy/clear-exploration/status',
      successStatus: 200,
    });
    expect(Object.keys(privacyContract)).toEqual(['clearExploration', 'readClearExplorationStatus']);
  });
});
