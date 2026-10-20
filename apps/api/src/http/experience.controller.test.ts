import 'reflect-metadata';
import { call } from '@orpc/server';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { Caller } from './callers.js';
import { ExperienceController } from './experience.controller.js';
import { scopeGuard } from './scope-guard.js';

const id = '0199a000-0000-7000-8000-000000000001';
const caller: Caller = { accountId: id, universeId: id, privacyEpoch: 1, sessionId: id, credential: 'cookie' };

async function admittedRequest(): Promise<Request> {
  const request = { path: '/v1/experience/open', headers: { 'x-ks-scope': `${id}:1` } } as unknown as Request;
  const next = vi.fn();
  await scopeGuard({
    callers: { resolve: () => Promise.resolve(caller), sessionValid: () => Promise.resolve(true) },
    logEvent: () => undefined,
  })(request, {} as Response, next);
  expect(next).toHaveBeenCalledOnce();
  return request;
}

function wiredController() {
  const effects = vi.fn(() => Promise.reject(new Error('No legacy effect may run for a new command')));
  const navigation = vi.fn(() => Promise.resolve({ kind: 'refused' as const, code: 'OFFER_UNAVAILABLE' as const }));
  const context = vi.fn(() => Promise.resolve({ kind: 'refused' as const, code: 'NOT_FOUND' as const }));
  const actions = vi.fn(() => Promise.resolve({ kind: 'refused' as const, code: 'ASSET_NOT_FOUND' as const }));
  return {
    controller: new ExperienceController(
      effects,
      effects,
      effects,
      effects,
      effects,
      navigation,
      navigation,
      context,
      actions,
    ),
    effects,
    navigation,
    context,
    actions,
  };
}

describe('Explore wire dispatch and legacy compatibility', () => {
  it('routes discovery, exact return and navigation to the navigation consumer without legacy effects', async () => {
    const { controller, effects, navigation } = wiredController();
    const request = await admittedRequest();
    const unavailable = { code: 'OFFER_UNAVAILABLE' };
    await expect(
      call(controller.openExposureRoute(request), {
        commandId: id,
        target: { kind: 'discover' },
        capabilities: { documentSchemas: ['scroll-document.v1'], blocks: { fallback: [1] } },
      }),
    ).rejects.toMatchObject(unavailable);
    await expect(
      call(controller.openExposureRoute(request), {
        commandId: id,
        target: { kind: 'return', assetId: id, assetRevision: 2 },
        capabilities: { documentSchemas: ['scroll-document.v1'], blocks: { fallback: [1] } },
      }),
    ).rejects.toMatchObject(unavailable);
    await expect(
      call(controller.navigateExperienceRoute(request), {
        commandId: id,
        sessionId: id,
        expectedIntentRevision: 0,
        from: { offerId: id, exposureId: id },
        intent: { mode: 'variant', to: 'scroll' },
      }),
    ).rejects.toMatchObject(unavailable);
    expect(navigation).toHaveBeenCalledTimes(3);
    expect(effects).not.toHaveBeenCalled();
  });

  it('routes offer activation and explicit actions to their actual consumers', async () => {
    const { controller, effects } = wiredController();
    const request = await admittedRequest();
    await expect(
      call(controller.activateExposureRoute(request), {
        commandId: id,
        target: { kind: 'offer', sessionId: id, offerId: id, expectedIntentRevision: 0 },
      }),
    ).rejects.toMatchObject({ code: 'OFFER_UNAVAILABLE' });
    for (const kind of ['like', 'unlike', 'hide'] as const)
      await expect(
        call(controller.applyActionRoute(request), {
          commandId: id,
          kind,
          target: { assetId: id, assetRevision: 1 },
        }),
      ).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' });
    expect(effects).not.toHaveBeenCalled();
  });

  it('rejects a mixed activation target at validation instead of downgrading into direct effects', async () => {
    const { controller, effects } = wiredController();
    const mixed = {
      commandId: id,
      exposureId: id,
      target: { kind: 'offer' as const, sessionId: id, offerId: id, expectedIntentRevision: 0 },
    };
    await expect(call(controller.activateExposureRoute(await admittedRequest()), mixed)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(effects).not.toHaveBeenCalled();
  });

  it('routes current context and exposure-linked actions, including Save/Unsave, while rejecting malformed IDs', async () => {
    const { controller, effects } = wiredController();
    const request = await admittedRequest();
    await expect(call(controller.exposureContextRoute(request), { exposureId: id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    for (const kind of ['save', 'unsave', 'like', 'unlike', 'hide'] as const)
      await expect(
        call(controller.applyActionRoute(request), {
          commandId: id,
          kind,
          target: { assetId: id, assetRevision: 1 },
          exposureId: id,
        }),
      ).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' });
    await expect(
      call(controller.applyActionRoute(request), {
        commandId: id,
        kind: 'save',
        target: { assetId: id, assetRevision: 1 },
        exposureId: 'malformed',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(call(controller.exposureContextRoute(request), { exposureId: 'malformed' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(effects).not.toHaveBeenCalled();
  });
});
