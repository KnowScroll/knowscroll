import 'reflect-metadata';
import { call } from '@orpc/server';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { FormationUseCases } from '@knowscroll/backend/modules/scenes';
import { FormationController } from './formation.controller.js';
import { scopeGuard } from './scope-guard.js';
const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const target = { kind: 'next' as const };
const capabilities = {
  version: 'scene-client.v1' as const,
  descriptors: ['scene-descriptor.v1'],
  chunks: ['scene-chunk.v1'],
  manifests: ['scene-manifest.v1'],
  generators: ['silhouette.v1'],
  families: ['terraced.v1', 'ridged.v1', 'archipelago.v1'],
  detail: 'full' as const,
  reducedMotion: false,
};
const input = { version: 'formation-presentation.v1' as const, readId: id(4), target, capabilities };
const value = {
  ...input,
  scope: { universeId: id(2), privacyEpoch: 1, personalWatermark: 0 },
  recordedAt: '2026-10-22T00:00:00.000Z',
  currentGeography: { revision: 0, structureRevision: 0, activityRevision: 0 },
  sceneRevision: 0,
  status: 'unavailable' as const,
  reason: 'temporarily_unavailable' as const,
};
async function request() {
  const req = { path: '/v1/universe/formation/read', headers: { 'x-ks-scope': `${id(1)}:1` } } as unknown as Request;
  const next = vi.fn();
  await scopeGuard({
    callers: {
      resolve: () =>
        Promise.resolve({
          accountId: id(1),
          universeId: id(2),
          privacyEpoch: 1,
          sessionId: id(5),
          credential: 'bearer',
        }),
      sessionValid: () => Promise.resolve(true),
    },
    logEvent: () => undefined,
  })(req, {} as Response, next);
  expect(next).toHaveBeenCalledOnce();
  return req;
}
describe('guarded Formation controller (synthetic ports only)', () => {
  it('passes exact input/current authority and requires the actual guard', async () => {
    const read = vi.fn<FormationUseCases['read']>(() => Promise.resolve({ kind: 'accepted', value }));
    const claim = vi.fn<FormationUseCases['claim']>();
    const controller = new FormationController({
      read,
      claim,
      acknowledge: vi.fn(),
      expire: vi.fn(),
      recover: vi.fn(),
    });
    expect(await call(controller.read(await request()), input)).toEqual(value);
    expect(read).toHaveBeenCalledExactlyOnceWith(
      { universeId: id(2), privacyEpoch: 1, actor: { kind: 'account', accountId: id(1) } },
      input,
    );
    await expect(call(controller.read({} as Request), input)).rejects.toThrow('without the scope guard');
  });
  it('rejects cross-scope/read/target/capability or private extension acceptances', async () => {
    const req = await request();
    for (const corrupt of [
      { ...value, readId: id(8) },
      { ...value, scope: { ...value.scope, universeId: id(8) } },
      { ...value, target: { kind: 'transition', transitionId: id(8) } },
      { ...value, capabilities: { ...capabilities, generators: [] } },
      { ...value, privateMetadata: 'CANARY' },
    ]) {
      const controller = new FormationController({
        read: () => Promise.resolve({ kind: 'accepted', value: corrupt } as never),
        claim: vi.fn(),
        acknowledge: vi.fn(),
        expire: vi.fn(),
        recover: vi.fn(),
      });
      await expect(call(controller.read(req), input)).rejects.toMatchObject({ code: 'INTERNAL' });
    }
  });
  it('strictly rejects unknown fields before domain dispatch', async () => {
    const read = vi.fn(),
      controller = new FormationController({
        read,
        claim: vi.fn(),
        acknowledge: vi.fn(),
        expire: vi.fn(),
        recover: vi.fn(),
      });
    await expect(
      call(controller.read(await request()), { ...input, position: { x: 1 } } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(read).not.toHaveBeenCalled();
  });
});
