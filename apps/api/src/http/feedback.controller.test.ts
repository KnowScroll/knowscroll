import 'reflect-metadata';
import { call } from '@orpc/server';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { NotInterestedUseCases } from '@knowscroll/backend/modules/experience';
import type { ReportUseCases } from '@knowscroll/backend/modules/feedback';
import type { Caller } from './callers.js';
import { FeedbackController } from './feedback.controller.js';
import { scopeGuard } from './scope-guard.js';

const id = '0199a000-0000-7000-8000-000000000001';
const caller: Caller = { accountId: id, universeId: id, privacyEpoch: 1, sessionId: id, credential: 'cookie' };

async function admittedRequest(): Promise<Request> {
  const request = { path: '/v1/feedback/abuse-reports', headers: { 'x-ks-scope': `${id}:1` } } as unknown as Request;
  const next = vi.fn();
  await scopeGuard({
    callers: { resolve: () => Promise.resolve(caller), sessionValid: () => Promise.resolve(true) },
    logEvent: () => undefined,
  })(request, {} as Response, next);
  expect(next).toHaveBeenCalledOnce();
  return request;
}

const receipt = { commandId: id, reportId: id, receivedAt: '2026-10-24T22:11:00.000Z', replayed: false };

function controllerWith(options: {
  set?: NotInterestedUseCases['set'];
  report?: (reason: string | undefined) => unknown;
}) {
  const notInterested = {
    set: options.set ?? vi.fn(),
    undo: vi.fn(),
  } as unknown as NotInterestedUseCases;
  const reportAbuse = vi.fn((_authority: unknown, _command: unknown) => Promise.resolve(options.report?.(undefined)));
  const reports = { reportAbuse, reportContentError: reportAbuse } as unknown as ReportUseCases;
  return { controller: new FeedbackController(notInterested, reports), reportAbuse, notInterested };
}

describe('the feedback routes', () => {
  it('answers a receipt and nothing about the target', async () => {
    const { controller, reportAbuse } = controllerWith({ report: () => ({ kind: 'received', outcome: receipt }) });
    const request = await admittedRequest();
    const answer = await call(controller.reportAbuseRoute(request), {
      commandId: id,
      category: 'harassment',
      target: { kind: 'person', personId: id },
    });
    expect(answer).toEqual(receipt);
    expect(reportAbuse).toHaveBeenCalledWith(
      expect.objectContaining({ universeId: id, privacyEpoch: 1 }),
      expect.objectContaining({ target: { kind: 'person', personId: id } }),
    );
  });

  it('gives one answer for a target that is missing, hidden or the caller’s own', async () => {
    const { controller } = controllerWith({ report: () => ({ kind: 'refused', reason: 'target_unavailable' }) });
    await expect(
      call(controller.reportAbuseRoute(await admittedRequest()), {
        commandId: id,
        category: 'spam',
        target: { kind: 'message', messageId: id },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  it('names the daily bound, a reused key and a privacy reset in the catalogue’s words', async () => {
    for (const [reason, code] of [
      ['too_many_reports', 'TOO_MANY_REQUESTS'],
      ['command_key_reused', 'COMMAND_KEY_REUSED'],
      ['epoch_changed', 'PRIVACY_EPOCH_CHANGED'],
      ['outcome_from_newer_release', 'SERVICE_UNAVAILABLE'],
    ] as const) {
      const { controller } = controllerWith({ report: () => ({ kind: 'refused', reason }) });
      await expect(
        call(controller.reportContentErrorRoute(await admittedRequest()), {
          commandId: id,
          category: 'wrong',
          target: { assetId: id, assetRevision: 1 },
        }),
      ).rejects.toMatchObject({ code });
    }
  });

  it('answers Not interested on missing content as the content being unavailable', async () => {
    const set = vi.fn(() => Promise.resolve({ kind: 'refused' as const, reason: 'asset_not_found' as const }));
    const { controller } = controllerWith({ set });
    await expect(
      call(controller.notInterestedRoute(await admittedRequest()), { commandId: id, assetId: id }),
    ).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND', status: 404 });
  });

  it('rejects a body with a field the contract does not have before any use case runs', async () => {
    const { controller, reportAbuse } = controllerWith({});
    await expect(
      call(controller.reportAbuseRoute(await admittedRequest()), {
        commandId: id,
        category: 'harassment',
        target: { kind: 'person', personId: id },
        reportedAccountId: id,
      } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(reportAbuse).not.toHaveBeenCalled();
  });
});
