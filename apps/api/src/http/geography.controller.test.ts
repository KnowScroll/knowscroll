import 'reflect-metadata';
import { call } from '@orpc/server';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { GeographySnapshot, UniverseDeltas } from '@knowscroll/contracts';
import type { ReadOwnGeography, ReadOwnDeltas } from '@knowscroll/backend/modules/geography';
import type { Caller } from './callers.js';
import { scopeGuard } from './scope-guard.js';
import { GeographyController } from './geography.controller.js';

const universeId = '0199a000-0000-7000-8000-000000000001';
const accountId = '0199a000-0000-7000-8000-000000000002';
const caller: Caller = { accountId, universeId, privacyEpoch: 2, sessionId: universeId, credential: 'cookie' };
const authority = { universeId, privacyEpoch: 2, actor: { kind: 'account', accountId } };
const input = { selection: { kind: 'universe' as const }, limit: 100 };
const deltaInput = { afterGeographyRevision: 0, limit: 10 };
const base = {
  universeId,
  privacyEpoch: 2,
  personalWatermark: 7,
  geography: { revision: 0, structureRevision: 0, activityRevision: 0 },
};
const snapshot: GeographySnapshot = {
  ...base,
  version: 'geography-snapshot.v1',
  recordedAt: '2026-10-20T00:00:00.000Z',
  selection: input.selection,
  status: 'empty',
};
const deltas: UniverseDeltas = {
  ...base,
  version: 'universe-deltas.v1',
  status: 'available',
  afterGeographyRevision: 0,
  deltas: [],
  hasMore: false,
};
async function admittedRequest(): Promise<Request> {
  const request = {
    path: '/v1/universe/geography/read',
    headers: { 'x-ks-scope': `${accountId}:2` },
  } as unknown as Request;
  const next = vi.fn();
  await scopeGuard({
    callers: { resolve: () => Promise.resolve(caller), sessionValid: () => Promise.resolve(true) },
    logEvent: () => undefined,
  })(request, {} as Response, next);
  expect(next).toHaveBeenCalledOnce();
  return request;
}
function wired() {
  const read = vi.fn<ReadOwnGeography>(() => Promise.resolve({ kind: 'read', snapshot }));
  const changes = vi.fn<ReadOwnDeltas>(() => Promise.resolve({ kind: 'read', deltas }));
  return { controller: new GeographyController(read, changes), read, changes };
}

describe('Geography guarded read-only HTTP adapter', () => {
  it('uses only admitted authority and returns the independent backend snapshots unchanged', async () => {
    const { controller, read, changes } = wired();
    const request = await admittedRequest();
    expect(await call(controller.readRoute(request), input)).toEqual(snapshot);
    expect(read).toHaveBeenCalledExactlyOnceWith(authority, input);
    expect(changes).not.toHaveBeenCalled();
    expect(await call(controller.deltasRoute(request), deltaInput)).toEqual(deltas);
    expect(changes).toHaveBeenCalledExactlyOnceWith(authority, deltaInput);
    expect(read).toHaveBeenCalledOnce();
  });

  it('maps foreign or missing selection to the same sanitized problem and scope refusal consistently', async () => {
    const read: ReadOwnGeography = () => Promise.resolve({ kind: 'refused', reason: 'selection_not_found' });
    const changes: ReadOwnDeltas = () => Promise.resolve({ kind: 'refused', reason: 'scope_refused' });
    const controller = new GeographyController(read, changes);
    const request = await admittedRequest();
    await expect(call(controller.readRoute(request), input)).rejects.toMatchObject({ code: 'NOT_FOUND', data: {} });
    await expect(call(controller.deltasRoute(request), deltaInput)).rejects.toMatchObject({
      code: 'UNIVERSE_UNAVAILABLE',
      data: {},
    });
    const refused = new GeographyController(
      () => Promise.resolve({ kind: 'refused', reason: 'scope_refused' }),
      changes,
    );
    await expect(call(refused.readRoute(request), input)).rejects.toMatchObject({
      code: 'UNIVERSE_UNAVAILABLE',
      data: {},
    });
  });

  it('refuses unguarded calls before either backend read', async () => {
    const { controller, read, changes } = wired();
    const request = {} as unknown as Request;
    await expect(call(controller.readRoute(request), input)).rejects.toThrow('without the scope guard');
    await expect(call(controller.deltasRoute(request), deltaInput)).rejects.toThrow('without the scope guard');
    expect(read).not.toHaveBeenCalled();
    expect(changes).not.toHaveBeenCalled();
  });

  it('refuses caller authority, commands and oversized windows before dispatch', async () => {
    const { controller, read, changes } = wired();
    const request = await admittedRequest();
    for (const value of [
      { ...input, accountId },
      { ...input, commandId: universeId },
      { ...input, limit: 101 },
    ])
      await expect(call(controller.readRoute(request), value)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    for (const value of [
      { ...deltaInput, privacyEpoch: 2 },
      { ...deltaInput, limit: 11 },
    ])
      await expect(call(controller.deltasRoute(request), value)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(read).not.toHaveBeenCalled();
    expect(changes).not.toHaveBeenCalled();
  });

  it('validates backend output instead of serving malformed geography', async () => {
    const read: ReadOwnGeography = () =>
      Promise.resolve({ kind: 'read', snapshot: { ...snapshot, universeId: 'bad' } });
    const { changes } = wired();
    const controller = new GeographyController(read, changes);
    await expect(call(controller.readRoute(await admittedRequest()), input)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
  });
});
