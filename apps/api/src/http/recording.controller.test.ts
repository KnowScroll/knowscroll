import 'reflect-metadata';
import { call } from '@orpc/server';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { RecordingPolicyUseCases } from '@knowscroll/backend/modules/identity';
import type { RecordingPolicyRead, RecordingPolicyAcceptance } from '@knowscroll/contracts';
import { RecordingController } from './recording.controller.js';
import { scopeGuard } from './scope-guard.js';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const accountId = id(1),
  universeId = id(2),
  commandId = id(3),
  readId = id(4);
const scope = { accountId, privacyEpoch: 2 };
const authority = { universeId, privacyEpoch: 2, actor: { kind: 'account', accountId } };
const setBody = {
  version: 'recording-policy.v1' as const,
  commandId,
  expectedPrivacyEpoch: 2,
  expectedRecordingGeneration: 1,
  on: false,
};
const readBody = { version: 'recording-policy.v1' as const, readId, target: { kind: 'current' as const } };
const receipt = {
  commandId,
  requestedPrivacyEpoch: 2,
  fromGeneration: 1,
  toGeneration: 2,
  on: false,
  changed: true,
  recordedAt: '2026-10-22T00:00:00.000Z',
};
const accepted: RecordingPolicyAcceptance = {
  version: 'recording-policy.v1',
  operation: 'privacy.recording-set',
  outcome: 'accepted',
  receipt,
  replayed: false,
};
const snapshot: RecordingPolicyRead = {
  version: 'recording-policy.v1',
  readId,
  scope,
  revision: 7,
  policy: { on: true, generation: 3 },
  target: { kind: 'current' },
};
async function admitted(path: string) {
  const request = { path, headers: { 'x-ks-scope': `${accountId}:2` } } as unknown as Request;
  const next = vi.fn();
  await scopeGuard({
    callers: {
      resolve: () => Promise.resolve({ ...scope, universeId, sessionId: id(5), credential: 'bearer' }),
      sessionValid: () => Promise.resolve(true),
    },
    logEvent: () => undefined,
  })(request, {} as Response, next);
  expect(next).toHaveBeenCalledOnce();
  return request;
}
function fixture() {
  const read = vi.fn<RecordingPolicyUseCases['read']>(() => Promise.resolve({ kind: 'ok', value: snapshot }));
  const set = vi.fn<RecordingPolicyUseCases['set']>(() => Promise.resolve({ kind: 'ok', value: accepted }));
  return { read, set, controller: new RecordingController({ read, set }) };
}

describe('recording controls (authored guard/oRPC fixtures, no runtime policy mutation)', () => {
  it('reads only under admitted authority and correlates current scope/read selector', async () => {
    const f = fixture();
    expect(await call(f.controller.readRoute(await admitted('/v1/privacy/recording/read')), readBody)).toEqual(
      snapshot,
    );
    expect(f.read).toHaveBeenCalledExactlyOnceWith(authority, readBody);
    expect(f.set).not.toHaveBeenCalled();
  });

  it('passes the unchanged original command and preserves a historical replay acknowledgement', async () => {
    const f = fixture();
    const request = await admitted('/v1/privacy/recording/set');
    expect(await call(f.controller.setRoute(request), setBody)).toEqual(accepted);
    f.set.mockResolvedValue({ kind: 'ok', value: { ...accepted, replayed: true } });
    expect(await call(f.controller.setRoute(request), setBody)).toEqual({ ...accepted, replayed: true });
    expect(f.set.mock.calls).toEqual([
      [authority, setBody],
      [authority, setBody],
    ]);
    // A receipt for2/off does not replace the independent current3/on snapshot.
    expect(await call(f.controller.readRoute(await admitted('/v1/privacy/recording/read')), readBody)).toEqual(
      snapshot,
    );
  });

  it('permits original-epoch receipt recovery after Clear without claiming that epoch is current', async () => {
    const f = fixture();
    f.set.mockResolvedValue({
      kind: 'ok',
      value: { ...accepted, receipt: { ...receipt, requestedPrivacyEpoch: 1 }, replayed: true },
    });
    expect(
      (
        await call(f.controller.setRoute(await admitted('/v1/privacy/recording/set')), {
          ...setBody,
          expectedPrivacyEpoch: 1,
        })
      ).receipt.requestedPrivacyEpoch,
    ).toBe(1);
  });

  it('correlates command read recovery without using its old receipt as current policy', async () => {
    const f = fixture();
    const query = { ...readBody, target: { kind: 'command' as const, commandId } };
    const value: RecordingPolicyRead = { ...snapshot, target: query.target, status: 'recorded', receipt };
    f.read.mockResolvedValue({ kind: 'ok', value });
    expect(await call(f.controller.readRoute(await admitted('/v1/privacy/recording/read')), query)).toEqual(value);
  });

  it.each([
    ['invalid_input', 'INVALID_REQUEST', 400],
    ['unavailable', 'UNIVERSE_UNAVAILABLE', 403],
    ['command_key_reused', 'COMMAND_KEY_REUSED', 422],
    ['stale_policy', 'RECORDING_POLICY_STALE', 409],
    ['generation_exhausted', 'RECORDING_GENERATION_EXHAUSTED', 409],
    ['revision_exhausted', 'SERVICE_UNAVAILABLE', 503],
  ] as const)('maps %s on both controls without a receipt', async (reason, code, status) => {
    const f = fixture();
    f.read.mockResolvedValue({ kind: 'refused', code: reason });
    f.set.mockResolvedValue({ kind: 'refused', code: reason });
    await expect(
      call(f.controller.readRoute(await admitted('/v1/privacy/recording/read')), readBody),
    ).rejects.toMatchObject({ code, status });
    await expect(
      call(f.controller.setRoute(await admitted('/v1/privacy/recording/set')), setBody),
    ).rejects.toMatchObject({ code, status });
  });

  it.each([
    ['account_mismatch', 'FORBIDDEN'],
    ['epoch_changed', 'PRIVACY_EPOCH_CHANGED'],
    ['universe_missing', 'UNIVERSE_UNAVAILABLE'],
    ['universe_suspended', 'UNIVERSE_UNAVAILABLE'],
  ] as const)('maps actual scope refusal %s on both controls', async (kind, code) => {
    const f = fixture();
    const refusal = kind === 'epoch_changed' ? { kind, currentEpoch: 3 } : { kind };
    f.read.mockResolvedValue({ kind: 'scope_refused', refusal });
    f.set.mockResolvedValue({ kind: 'scope_refused', refusal });
    await expect(
      call(f.controller.readRoute(await admitted('/v1/privacy/recording/read')), readBody),
    ).rejects.toMatchObject({ code });
    await expect(
      call(f.controller.setRoute(await admitted('/v1/privacy/recording/set')), setBody),
    ).rejects.toMatchObject({ code });
  });

  it.each([
    { ...snapshot, readId: id(10) },
    { ...snapshot, scope: { ...scope, accountId: id(10) } },
    { ...snapshot, scope: { ...scope, privacyEpoch: 3 } },
    { ...snapshot, target: { kind: 'command' as const, commandId }, status: 'not_recorded' as const },
    { ...snapshot, policy: { on: false, generation: 3 } },
  ])('refuses an unrelated/inconsistent read output', async (value) => {
    const f = fixture();
    f.read.mockResolvedValue({ kind: 'ok', value });
    await expect(
      call(f.controller.readRoute(await admitted('/v1/privacy/recording/read')), readBody),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it.each([
    { ...accepted, receipt: { ...receipt, commandId: id(10) } },
    { ...accepted, receipt: { ...receipt, requestedPrivacyEpoch: 1 } },
    { ...accepted, receipt: { ...receipt, fromGeneration: 3, toGeneration: 4 } },
    { ...accepted, receipt: { ...receipt, on: true } },
  ])('refuses a mismatched command acknowledgement', async (value) => {
    const f = fixture();
    f.set.mockResolvedValue({ kind: 'ok', value });
    await expect(
      call(f.controller.setRoute(await admitted('/v1/privacy/recording/set')), setBody),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('does not call either owner without guard admission or on malformed wire input', async () => {
    const f = fixture();
    await expect(call(f.controller.readRoute({} as Request), readBody)).rejects.toBeDefined();
    await expect(call(f.controller.setRoute({} as Request), setBody)).rejects.toBeDefined();
    await expect(
      call(f.controller.setRoute(await admitted('/v1/privacy/recording/set')), { ...setBody, on: 'false' } as never),
    ).rejects.toBeDefined();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.set).not.toHaveBeenCalled();
  });
});
