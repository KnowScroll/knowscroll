import 'reflect-metadata';
import { call } from '@orpc/server';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { ClearExplorationAcceptance, ClearExplorationStatus } from '@knowscroll/contracts';
import type { ClearExplorationUseCases } from '../modules/privacy.js';
import { PrivacyController } from './privacy.controller.js';
import { scopeGuard } from './scope-guard.js';

const accountId = '0199a000-0000-7000-8000-000000000001';
const universeId = '0199a000-0000-7000-8000-000000000002';
const commandId = '0199a000-0000-7000-8000-000000000003';
const input = {
  version: 'clear-exploration.v1' as const,
  commandId,
  expectedPrivacyEpoch: 2,
  confirmation: 'clear-exploration-preserve-keep-and-social' as const,
};
const accepted: ClearExplorationAcceptance = {
  version: 'clear-exploration.v1',
  commandId,
  fromEpoch: 2,
  toEpoch: 3,
  recordedAt: '2026-10-22T00:00:00.000Z',
  outcome: 'accepted',
  operation: 'privacy.clear-exploration',
  replayed: false,
};
const query = { version: 'clear-exploration.v1' as const, target: { kind: 'command' as const, commandId } };
const status: ClearExplorationStatus = {
  ...query,
  scope: { accountId, privacyEpoch: 3 },
  status: 'pending',
  receipt: { commandId, fromEpoch: 2, toEpoch: 3, recordedAt: accepted.recordedAt },
  phase: 'removing_live_data',
};

async function admitted(epoch = 2) {
  const request = {
    path: '/v1/privacy/clear-exploration',
    headers: { 'x-ks-scope': `${accountId}:${epoch}` },
  } as unknown as Request;
  const next = vi.fn();
  await scopeGuard({
    callers: {
      resolve: () =>
        Promise.resolve({ accountId, universeId, privacyEpoch: epoch, sessionId: universeId, credential: 'bearer' }),
      sessionValid: () => Promise.resolve(true),
    },
    logEvent: () => undefined,
  })(request, {} as Response, next);
  expect(next).toHaveBeenCalledOnce();
  return request;
}
function fixture() {
  const start = vi.fn<ClearExplorationUseCases['start']>(() =>
    Promise.resolve({ kind: 'entered', value: { kind: 'ok', value: accepted } }),
  );
  const read = vi.fn<ClearExplorationUseCases['status']>(() =>
    Promise.resolve({ kind: 'entered', value: { kind: 'ok', value: status } }),
  );
  const process = vi.fn<ClearExplorationUseCases['process']>(() => Promise.resolve());
  const fail = vi.fn<ClearExplorationUseCases['fail']>(() => Promise.resolve());
  const recover = vi.fn<ClearExplorationUseCases['recover']>(() => Promise.resolve({ scheduled: 0, skipped: 0 }));
  return {
    start,
    read,
    process,
    fail,
    recover,
    controller: new PrivacyController({ start, status: read, process, fail, recover }),
  };
}
describe('Clear thin adapter (authored transport fixtures)', () => {
  it('accepts only through the durable start port with admitted current authority', async () => {
    const f = fixture();
    expect(await call(f.controller.startRoute(await admitted()), input)).toEqual(accepted);
    expect(f.start).toHaveBeenCalledExactlyOnceWith({ accountId, universeId, privacyEpoch: 2 }, input);
    expect(f.process).not.toHaveBeenCalled();
    expect(f.fail).not.toHaveBeenCalled();
    expect(f.recover).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
  });
  it('returns historical replay epochs without replacing current scope', async () => {
    const f = fixture();
    f.start.mockResolvedValue({ kind: 'entered', value: { kind: 'ok', value: { ...accepted, replayed: true } } });
    expect(await call(f.controller.startRoute(await admitted(4)), input)).toEqual({ ...accepted, replayed: true });
  });
  it('refuses malformed, wrong-command and impossible historical output', async () => {
    for (const value of [
      { ...accepted, commandId: universeId },
      { ...accepted, fromEpoch: 3, toEpoch: 4 },
      { ...accepted, replayed: true },
      { ...accepted, privatePayload: 'canary' },
    ]) {
      const f = fixture();
      f.start.mockResolvedValue({ kind: 'entered', value: { kind: 'ok', value } });
      await expect(call(f.controller.startRoute(await admitted()), input)).rejects.toMatchObject({ code: 'INTERNAL' });
    }
  });
  it('binds status to current account/epoch and exact selector before returning it', async () => {
    const f = fixture();
    expect(await call(f.controller.statusRoute(await admitted(3)), query)).toEqual(status);
    expect(f.read).toHaveBeenCalledExactlyOnceWith({ accountId, universeId, privacyEpoch: 3 }, query);
    for (const value of [
      { ...status, scope: { accountId: universeId, privacyEpoch: 3 } },
      { ...status, scope: { accountId, privacyEpoch: 4 } },
      { ...status, target: { kind: 'latest' as const } },
      {
        ...status,
        target: { kind: 'command' as const, commandId: universeId },
        receipt: { ...status.receipt, commandId: universeId },
      },
    ]) {
      f.read.mockResolvedValue({ kind: 'entered', value: { kind: 'ok', value } });
      await expect(call(f.controller.statusRoute(await admitted(3)), query)).rejects.toMatchObject({
        code: 'INTERNAL',
      });
    }
    expect(f.start).not.toHaveBeenCalled();
    expect(f.process).not.toHaveBeenCalled();
  });
  it('maps current authority refusals before exposing any acceptance', async () => {
    const f = fixture();
    f.start.mockResolvedValue({ kind: 'refused', refusal: { kind: 'epoch_changed', currentEpoch: 99 } });
    await expect(call(f.controller.startRoute(await admitted()), input)).rejects.toMatchObject({
      code: 'PRIVACY_EPOCH_CHANGED',
    });
    f.start.mockResolvedValue({ kind: 'entered', value: { kind: 'rejected', code: 'COMMAND_KEY_REUSED' } });
    await expect(call(f.controller.startRoute(await admitted()), input)).rejects.toMatchObject({
      code: 'COMMAND_KEY_REUSED',
    });
  });
  it('a handler reached without the ordinary scope guard fails before its use case', async () => {
    const f = fixture();
    await expect(call(f.controller.startRoute({} as Request), input)).rejects.toBeDefined();
    expect(f.start).not.toHaveBeenCalled();
  });
});
