import 'reflect-metadata';
import { call } from '@orpc/server';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { KeepPlaceUseCases } from '@knowscroll/backend/modules/experience';
import type { KeepEntrySnapshot, KeepPlaceAcceptance } from '@knowscroll/contracts';
import { KeepController } from './keep.controller.js';
import { scopeGuard } from './scope-guard.js';
import { problemFromOrpcError } from './problems.js';
import type { ORPCError } from '@orpc/server';
const accountId = '0199a000-0000-7000-8000-000000000001',
  universeId = '0199a000-0000-7000-8000-000000000002',
  assetId = '0199a000-0000-7000-8000-000000000003',
  savedEntryId = '0199a000-0000-7000-8000-000000000004',
  commandId = '0199a000-0000-7000-8000-000000000005';
const target = { assetId, assetRevision: 1 },
  entry = { ...target, savedEntryId };
const input = { version: 'keep-place.v1' as const, target };
const command = {
  version: 'keep-place.v1' as const,
  commandId,
  entry,
  expectedPlaceRevision: 0,
  position: { kind: 'reel' as const, positionMs: 1234.5 },
};
const snapshot: KeepEntrySnapshot = {
  version: 'keep-place.v1',
  scope: { accountId, privacyEpoch: 2 },
  target,
  status: 'available',
  entry,
  place: { status: 'none', placeRevision: 0 },
};
const acceptance: KeepPlaceAcceptance = {
  version: 'keep-place.v1',
  scope: { accountId, privacyEpoch: 2 },
  commandId,
  entry,
  recordedAt: '2026-10-21T00:00:00.000Z',
  replayed: false,
  outcome: 'accepted',
  operation: 'keep.place.set',
  basePlaceRevision: 0,
  acceptedPlaceRevision: 1,
};
async function request() {
  const req = { path: '/v1/experience/keep/read', headers: { 'x-ks-scope': `${accountId}:2` } } as unknown as Request;
  const next = vi.fn();
  await scopeGuard({
    callers: {
      resolve: () =>
        Promise.resolve({ accountId, universeId, privacyEpoch: 2, sessionId: universeId, credential: 'bearer' }),
      sessionValid: () => Promise.resolve(true),
    },
    logEvent: () => undefined,
  })(req, {} as Response, next);
  expect(next).toHaveBeenCalledOnce();
  return req;
}
function wired() {
  const readEntry = vi.fn<KeepPlaceUseCases['readEntry']>(() => Promise.resolve({ kind: 'ok', value: snapshot }));
  const setPlace = vi.fn<KeepPlaceUseCases['setPlace']>(() => Promise.resolve({ kind: 'ok', value: acceptance }));
  return { readEntry, setPlace, controller: new KeepController({ readEntry, setPlace }) };
}
describe('Keep guarded thin HTTP adapter', () => {
  it('uses only the matching port, admitted authority and exact fractional body', async () => {
    const f = wired(),
      req = await request(),
      authority = { universeId, privacyEpoch: 2, actor: { kind: 'account', accountId } };
    expect(await call(f.controller.readRoute(req), input)).toEqual(snapshot);
    expect(f.readEntry).toHaveBeenCalledExactlyOnceWith(authority, input);
    expect(f.setPlace).not.toHaveBeenCalled();
    expect(await call(f.controller.setPlaceRoute(req), command)).toEqual(acceptance);
    expect(f.setPlace).toHaveBeenCalledExactlyOnceWith(authority, command);
    expect(f.readEntry).toHaveBeenCalledOnce();
  });
  it('fails closed before dispatch when the scope guard was absent', async () => {
    const f = wired();
    await expect(call(f.controller.readRoute({} as Request), input)).rejects.toThrow('without the scope guard');
    await expect(call(f.controller.setPlaceRoute({} as Request), command)).rejects.toThrow('without the scope guard');
    expect(f.readEntry).not.toHaveBeenCalled();
    expect(f.setPlace).not.toHaveBeenCalled();
  });
  it('strictly refuses authority/unknown fields and malformed positions before either port', async () => {
    const f = wired(),
      req = await request();
    await expect(
      call(f.controller.readRoute(req), { ...input, privateKey: 'CANARY', accountId } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    for (const changed of [
      { ...command, position: { kind: 'reel', positionMs: -1 } },
      { ...command, authority: { accountId } },
      { ...command, entry: { ...entry, privateKey: 'CANARY' } },
    ])
      await expect(call(f.controller.setPlaceRoute(req), changed as never)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    expect(f.readEntry).not.toHaveBeenCalled();
    expect(f.setPlace).not.toHaveBeenCalled();
  });
  it('passes every closed use-case refusal and only a validated stale revision', async () => {
    const req = await request();
    for (const code of [
      'INVALID_REQUEST',
      'UNIVERSE_UNAVAILABLE',
      'PRIVACY_EPOCH_CHANGED',
      'KEEP_ENTRY_UNAVAILABLE',
      'COMMAND_KEY_REUSED',
      'SERVICE_UNAVAILABLE',
      'UNPROCESSABLE_REQUEST',
      'KEEP_PLACE_COUNTER_EXHAUSTED',
    ] as const) {
      const refusal = () => Promise.resolve({ kind: 'refused' as const, code });
      const c = new KeepController({ readEntry: refusal, setPlace: refusal });
      await expect(call(c.readRoute(req), input)).rejects.toMatchObject({ code });
      await expect(call(c.setPlaceRoute(req), command)).rejects.toMatchObject({ code });
    }
    const c = new KeepController({
      readEntry: wired().readEntry,
      setPlace: () => Promise.resolve({ kind: 'refused', code: 'KEEP_PLACE_REVISION_STALE', currentPlaceRevision: 7 }),
    });
    try {
      await call(c.setPlaceRoute(req), command);
      throw new Error('CI expected refusal');
    } catch (e) {
      expect(problemFromOrpcError(e as ORPCError<string, unknown>, () => undefined)).toMatchObject({
        code: 'KEEP_PLACE_REVISION_STALE',
        currentPlaceRevision: 7,
      });
    }
  });
  it('coarsely refuses malformed and cross-scope/target backend snapshots and acceptances', async () => {
    const req = await request();
    for (const value of [
      { ...snapshot, privateKey: 'CANARY' },
      { ...snapshot, scope: { accountId: assetId, privacyEpoch: 2 } },
      { ...snapshot, target: { ...target, assetRevision: 2 } },
    ]) {
      const c = new KeepController({
        readEntry: () => Promise.resolve({ kind: 'ok', value } as never),
        setPlace: wired().setPlace,
      });
      await expect(call(c.readRoute(req), input)).rejects.toMatchObject({ code: 'INTERNAL' });
    }
    for (const value of [
      { ...acceptance, acceptedPlaceRevision: 4 },
      { ...acceptance, scope: { accountId, privacyEpoch: 3 } },
      { ...acceptance, entry: { ...entry, savedEntryId: assetId } },
      { ...acceptance, commandId: assetId },
    ]) {
      const c = new KeepController({
        readEntry: wired().readEntry,
        setPlace: () => Promise.resolve({ kind: 'ok', value } as never),
      });
      await expect(call(c.setPlaceRoute(req), command)).rejects.toMatchObject({ code: 'INTERNAL' });
    }
  });
});
