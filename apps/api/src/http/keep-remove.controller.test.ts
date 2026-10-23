import 'reflect-metadata';
import { call, type ORPCError } from '@orpc/server';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { KeepRemovalUseCase } from '@knowscroll/backend/modules/experience';
import type { KeepRemovalAcceptance } from '@knowscroll/contracts';
import { KeepRemoveController } from './keep-remove.controller.js';
import { scopeGuard } from './scope-guard.js';
import { problemFromOrpcError } from './problems.js';
const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const entry = { assetId: id(3), assetRevision: 2, savedEntryId: id(4) };
const command = { version: 'keep-remove.v1' as const, commandId: id(5), entry };
const acceptance: KeepRemovalAcceptance = {
  ...command,
  scope: { accountId: id(1), privacyEpoch: 2 },
  recordedAt: '2026-10-22T00:00:00.000Z',
  replayed: false,
  outcome: 'accepted',
  operation: 'keep.entry.remove',
};
async function request() {
  const req = { path: '/v1/experience/keep/remove', headers: { 'x-ks-scope': `${id(1)}:2` } } as unknown as Request;
  const next = vi.fn();
  await scopeGuard({
    callers: {
      resolve: () =>
        Promise.resolve({
          accountId: id(1),
          universeId: id(2),
          privacyEpoch: 2,
          sessionId: id(6),
          credential: 'bearer',
        }),
      sessionValid: () => Promise.resolve(true),
    },
    logEvent: () => undefined,
  })(req, {} as Response, next);
  expect(next).toHaveBeenCalledOnce();
  return req;
}
const wired = () => {
  const port = vi.fn<KeepRemovalUseCase>(() => Promise.resolve({ kind: 'ok', value: acceptance }));
  return { port, controller: new KeepRemoveController(port) };
};
describe('dedicated guarded Keep removal adapter (synthetic ports only)', () => {
  it('dispatches the exact membership/body with admitted current authority; ACK stays historical', async () => {
    const f = wired();
    expect(await call(f.controller.removeRoute(await request()), command)).toEqual(acceptance);
    expect(f.port).toHaveBeenCalledExactlyOnceWith(
      { universeId: id(2), privacyEpoch: 2, actor: { kind: 'account', accountId: id(1) } },
      command,
    );
    f.port.mockResolvedValue({ kind: 'ok', value: { ...acceptance, replayed: true } });
    expect(await call(f.controller.removeRoute(await request()), command)).toEqual({ ...acceptance, replayed: true });
    expect(acceptance).not.toHaveProperty('currentlyAbsent');
  });
  it('never reaches the port without the scope guard', async () => {
    const f = wired();
    await expect(call(f.controller.removeRoute({} as Request), command)).rejects.toThrow('without the scope guard');
    expect(f.port).not.toHaveBeenCalled();
  });
  it('rejects asset-only removal, position/CAS/authority overrides and unknown fields before dispatch', async () => {
    const f = wired(),
      req = await request();
    for (const body of [
      { version: command.version, commandId: command.commandId, assetId: entry.assetId },
      { ...command, entry: { assetId: entry.assetId, assetRevision: 2 } },
      { ...command, entry: { ...entry, savedEntryId: 'not-a-uuid' } },
      { ...command, force: true },
      { ...command, privacyEpoch: 2 },
      { ...command, expectedPlaceRevision: 0 },
      { ...command, position: { kind: 'reel', positionMs: 5 } },
      { ...command, entry: { ...entry, privateKey: 'CANARY' } },
    ])
      await expect(call(f.controller.removeRoute(req), body as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.port).not.toHaveBeenCalled();
  });
  it('passes only actual closed backend refusals without extension metadata', async () => {
    const req = await request();
    for (const code of [
      'INVALID_REQUEST',
      'UNIVERSE_UNAVAILABLE',
      'PRIVACY_EPOCH_CHANGED',
      'KEEP_ENTRY_UNAVAILABLE',
      'COMMAND_KEY_REUSED',
      'SERVICE_UNAVAILABLE',
    ] as const) {
      const c = new KeepRemoveController(() => Promise.resolve({ kind: 'refused', code }));
      try {
        await call(c.removeRoute(req), command);
        throw new Error('Expected refusal');
      } catch (error) {
        expect(problemFromOrpcError(error as ORPCError<string, unknown>, () => undefined).code).toBe(code);
      }
    }
  });
  it('coarsely refuses corrupt, cross-scope or mismatched backend acceptances', async () => {
    const req = await request();
    for (const value of [
      { ...acceptance, scope: { accountId: id(9), privacyEpoch: 2 } },
      { ...acceptance, scope: { accountId: id(1), privacyEpoch: 3 } },
      { ...acceptance, commandId: id(9) },
      { ...acceptance, entry: { ...entry, savedEntryId: id(9) } },
      { ...acceptance, entry: { ...entry, assetRevision: 3 } },
      { ...acceptance, recordedAt: 'bad-time' },
      { ...acceptance, currentlyAbsent: true },
      { ...acceptance, currentEntry: { ...entry, savedEntryId: id(9) } },
    ]) {
      const c = new KeepRemoveController(() => Promise.resolve({ kind: 'ok', value } as never));
      await expect(call(c.removeRoute(req), command)).rejects.toMatchObject({ code: 'INTERNAL' });
    }
  });
});
