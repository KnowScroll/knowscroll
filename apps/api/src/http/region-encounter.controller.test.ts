import 'reflect-metadata';
import { call } from '@orpc/server';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { RegionEncounterUseCases } from '@knowscroll/backend/modules/experience';
import { RegionEncounterController } from './region-encounter.controller.js';
import { scopeGuard } from './scope-guard.js';
const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const target = { kind: 'region' as const, regionId: id(3), expectedObjectRevision: 1, expectedGeographyRevision: 1 };
const capabilities = {
  documentSchemas: ['scroll-document.v1'],
  blocks: { fallback: [1], paragraph: [1], subheading: [1] },
};
const input = { version: 'region-encounter-preview.v1' as const, readId: id(4), target, capabilities };
const value = {
  ...input,
  scope: { universeId: id(2), privacyEpoch: 1, personalWatermark: 0 },
  recordedAt: '2026-10-22T00:00:00.000Z',
  geographyRevision: 1,
  status: 'unavailable' as const,
  reason: 'no_eligible_content' as const,
};
async function request() {
  const req = { path: '/v1/experience/region/preview', headers: { 'x-ks-scope': `${id(1)}:1` } } as unknown as Request;
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
describe('guarded Region controller (synthetic ports only)', () => {
  it('passes exact input/current authority and requires the actual guard', async () => {
    const preview = vi.fn<RegionEncounterUseCases['preview']>(() => Promise.resolve({ kind: 'accepted', value }));
    const open = vi.fn<RegionEncounterUseCases['open']>();
    const controller = new RegionEncounterController({ preview, open });
    expect(await call(controller.preview(await request()), input)).toEqual(value);
    expect(preview).toHaveBeenCalledExactlyOnceWith(
      { universeId: id(2), privacyEpoch: 1, actor: { kind: 'account', accountId: id(1) } },
      input,
    );
    await expect(call(controller.preview({} as Request), input)).rejects.toThrow('without the scope guard');
  });
  it('rejects cross-scope/read/target/capability or private extension acceptances', async () => {
    const req = await request();
    for (const corrupt of [
      { ...value, readId: id(8) },
      { ...value, scope: { ...value.scope, universeId: id(8) } },
      { ...value, target: { ...target, regionId: id(8) } },
      { ...value, capabilities: { ...capabilities, blocks: { fallback: [1] } } },
      { ...value, privateMetadata: 'CANARY' },
    ]) {
      const controller = new RegionEncounterController({
        preview: () => Promise.resolve({ kind: 'accepted', value: corrupt } as never),
        open: vi.fn(),
      });
      await expect(call(controller.preview(req), input)).rejects.toMatchObject({ code: 'INTERNAL' });
    }
  });
  it('strictly rejects unknown fields before domain dispatch', async () => {
    const preview = vi.fn(),
      controller = new RegionEncounterController({ preview, open: vi.fn() });
    await expect(
      call(controller.preview(await request()), { ...input, position: { x: 1 } } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(preview).not.toHaveBeenCalled();
  });
});
