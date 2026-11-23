import 'reflect-metadata';
import { call } from '@orpc/server';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { ProblemCode } from '@knowscroll/contracts';
import type { ScenarioRefusal, ScenarioUseCases } from '@knowscroll/backend/modules/scenarios';
import type { Caller } from './callers.js';
import { ScenariosController } from './scenarios.controller.js';
import { scopeGuard } from './scope-guard.js';

const id = '0199a000-0000-7000-8000-000000000001';
const accountId = '0199a000-0000-7000-8000-000000000002';
const caller: Caller = { accountId, universeId: id, privacyEpoch: 2, sessionId: id, credential: 'cookie' };
const thread = { threadId: id, membershipId: id, membershipRevision: 1 };

async function admittedRequest(): Promise<Request> {
  const request = {
    path: '/v1/social/scenarios/draft',
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

/** What each use case's refusal becomes on the wire: a closed problem, never a 500 and never a reason of its own. */
const refusalCodes: Record<ScenarioRefusal, ProblemCode> = {
  invalid_input: 'INVALID_REQUEST',
  stale_revision: 'SHARING_REVISION_STALE',
  command_key_reused: 'COMMAND_KEY_REUSED',
  budget_unavailable: 'TOO_MANY_REQUESTS',
  unsupported: 'UNPROCESSABLE_REQUEST',
  unavailable: 'SHARING_UNAVAILABLE',
  // The made-to-order switch is off (D-436): the thread or branch is simply not there to start from.
  made_to_order_off: 'SHARING_UNAVAILABLE',
};

describe('the scenarios HTTP adapter and its refusals', () => {
  for (const code of Object.keys(refusalCodes) as ScenarioRefusal[])
    it(`answers ${code} with ${refusalCodes[code]} for a draft and for a choice`, async () => {
      const refused = vi.fn(() => Promise.resolve({ kind: 'refused' as const, code }));
      const useCases = { draft: refused, choose: refused } as unknown as ScenarioUseCases;
      const controller = new ScenariosController(useCases);
      const request = await admittedRequest();
      const draft = {
        version: 'scenario.v1' as const,
        commandId: id,
        thread,
        kind: 'what_if' as const,
        origin: { kind: 'root' as const },
        parent: { kind: 'root' as const, assetRevision: 1 },
        text: 'What if traffic doubles?',
      };
      const choose = {
        version: 'scenario.v1' as const,
        commandId: id,
        thread,
        draftId: id,
        selection: { kind: 'suggestion' as const, optionId: 'o1' },
      };
      await expect(call(controller.draftRoute(request), draft)).rejects.toMatchObject({ code: refusalCodes[code] });
      await expect(call(controller.chooseRoute(request), choose)).rejects.toMatchObject({ code: refusalCodes[code] });
      expect(refused).toHaveBeenCalledTimes(2);
    });
});
