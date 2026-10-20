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

function prerequisiteController() {
  const effects = vi.fn(() => Promise.reject(new Error('No legacy effect may run for a new command')));
  return { controller: new ExperienceController(effects, effects, effects, effects, effects), effects };
}

describe('Explore contract prerequisite compatibility refusals', () => {
  it('refuses discovery and navigation before any legacy use case can mutate or read', async () => {
    const { controller, effects } = prerequisiteController();
    const request = await admittedRequest();
    const unsupported = { code: 'EXPERIENCE_COMMAND_UNSUPPORTED', status: 422 };
    await expect(
      call(controller.openExposureRoute(request), {
        commandId: id,
        target: { kind: 'discover' },
        capabilities: { documentSchemas: ['scroll-document.v1'], blocks: { fallback: [1] } },
      }),
    ).rejects.toMatchObject(unsupported);
    await expect(
      call(controller.openExposureRoute(request), {
        commandId: id,
        target: { kind: 'return', assetId: id, assetRevision: 2 },
        capabilities: { documentSchemas: ['scroll-document.v1'], blocks: { fallback: [1] } },
      }),
    ).rejects.toMatchObject(unsupported);
    await expect(
      call(controller.navigateExperienceRoute(request), {
        commandId: id,
        sessionId: id,
        expectedIntentRevision: 0,
        from: { offerId: id, exposureId: id },
        intent: { mode: 'variant', to: 'scroll' },
      }),
    ).rejects.toMatchObject(unsupported);
    expect(effects).not.toHaveBeenCalled();
  });

  it('refuses offer activation and each new action before direct activation or saved-state effects', async () => {
    const { controller, effects } = prerequisiteController();
    const request = await admittedRequest();
    await expect(
      call(controller.activateExposureRoute(request), {
        commandId: id,
        target: { kind: 'offer', sessionId: id, offerId: id, expectedIntentRevision: 0 },
      }),
    ).rejects.toMatchObject({ code: 'EXPERIENCE_COMMAND_UNSUPPORTED', status: 422 });
    for (const kind of ['like', 'unlike', 'hide'] as const)
      await expect(
        call(controller.applyActionRoute(request), {
          commandId: id,
          kind,
          target: { assetId: id, assetRevision: 1 },
        }),
      ).rejects.toMatchObject({ code: 'EXPERIENCE_COMMAND_UNSUPPORTED', status: 422 });
    expect(effects).not.toHaveBeenCalled();
  });

  it('rejects a mixed activation target at validation instead of downgrading into direct effects', async () => {
    const { controller, effects } = prerequisiteController();
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
});
