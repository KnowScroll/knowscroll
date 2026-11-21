import 'reflect-metadata';
import { call } from '@orpc/server';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { ReviewReleaseResult, ReviewRejectResult } from '@knowscroll/contracts';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import type { OperatorReview } from '@knowscroll/backend/modules/content';
import type { IsOperator, ReadJourney, ReadOperatorPanels } from '@knowscroll/backend/modules/operator';
import type { Caller } from './callers.js';
import { scopeGuard } from './scope-guard.js';
import { OperatorController } from './operator.controller.js';

const accountId = '0199a000-0000-7000-8000-000000000002';
const universeId = '0199a000-0000-7000-8000-000000000001';
const assetId = '0199A000-0000-7000-8000-0000000000AA';
const caller: Caller = { accountId, universeId, privacyEpoch: 1, sessionId: universeId, credential: 'cookie' };
const target = { assetId: assetId.toLowerCase(), revision: 3 };
const released: ReviewReleaseResult = { outcome: 'released', reason: null, replacedRevision: null };
const rejected: ReviewRejectResult = { outcome: 'rejected', reason: null };

async function admittedRequest(): Promise<Request> {
  const request = { path: '/v1/operator/review', headers: { 'x-ks-scope': `${accountId}:1` } } as unknown as Request;
  const next = vi.fn();
  await scopeGuard({
    callers: { resolve: () => Promise.resolve(caller), sessionValid: () => Promise.resolve(true) },
    logEvent: () => undefined,
  })(request, {} as Response, next);
  expect(next).toHaveBeenCalledOnce();
  return request;
}

function wired(options: { readonly operator: boolean; readonly review?: Partial<OperatorReview> }) {
  const logged: { event: string; fields: Record<string, unknown> | undefined }[] = [];
  const logEvent = ((event: string, fields?: Record<string, unknown>) => {
    logged.push({ event, fields });
  }) as unknown as LogEvent;
  const isOperator: IsOperator = () => Promise.resolve(options.operator);
  // Spies are kept apart from the object the controller is given, so a test can assert on them without unbound methods.
  const review = {
    list: vi.fn<OperatorReview['list']>(() => Promise.resolve({ kind: 'listed', revisions: [] })),
    show: vi.fn<OperatorReview['show']>(() => Promise.resolve({ kind: 'unreadable' })),
    release: vi.fn<OperatorReview['release']>(() =>
      Promise.resolve({ kind: 'decided', result: released, recipe: 'broad-street' }),
    ),
    reject: vi.fn<OperatorReview['reject']>(() =>
      Promise.resolve({ kind: 'decided', result: rejected, recipe: 'broad-street' }),
    ),
  };
  for (const name of ['list', 'show', 'release', 'reject'] as const) {
    const override = options.review?.[name];
    if (override !== undefined) review[name].mockImplementation(override as never);
  }
  const controller = new OperatorController(logEvent, isOperator, vi.fn<ReadOperatorPanels>(), vi.fn<ReadJourney>(), {
    list: (accountId) => review.list(accountId),
    show: (accountId, target) => review.show(accountId, target),
    release: (accountId, target) => review.release(accountId, target),
    reject: (accountId, target, reason) => review.reject(accountId, target, reason),
  });
  return { controller, review, logged };
}

const routes = (controller: OperatorController, request: Request) => ({
  list: () => call(controller.reviewListRoute(request), {}),
  show: (input = { assetId, revision: '3' }) => call(controller.reviewShowRoute(request), input),
  release: (input = { assetId, revision: '3' }) => call(controller.reviewReleaseRoute(request), input),
  reject: (input: { assetId: string; revision: string; reason?: string } = { assetId, revision: '3', reason: 'No.' }) =>
    call(controller.reviewRejectRoute(request), input),
});

describe('the operator review routes', () => {
  it('answer an account that is not an operator with the same not found on every route, and never reach the review', async () => {
    const { controller, review, logged } = wired({ operator: false });
    const request = await admittedRequest();
    const route = routes(controller, request);
    for (const attempt of [route.list, route.show, route.release, route.reject])
      await expect(attempt()).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    // What they send makes no difference: a malformed asset, revision or reason is no reason to answer differently.
    for (const attempt of [
      () => route.show({ assetId: 'not-a-uuid', revision: 'x' }),
      () => route.release({ assetId: 'x'.repeat(200), revision: '-1' }),
      () => route.reject({ assetId: 'nope', revision: '0', reason: '' }),
    ])
      await expect(attempt()).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect(review.list).not.toHaveBeenCalled();
    expect(review.show).not.toHaveBeenCalled();
    expect(review.release).not.toHaveBeenCalled();
    expect(review.reject).not.toHaveBeenCalled();
    expect(logged.filter((entry) => entry.event === 'operator.refused')).toHaveLength(7);
    expect(logged.every((entry) => entry.fields?.['reasonCode'] === 'not_operator')).toBe(true);
  });

  it('answer the same not found for a revision that is not held, and log only a code', async () => {
    const notHeld = () => Promise.resolve({ kind: 'not_found' as const, why: 'not_held' as const });
    const { controller, logged } = wired({
      operator: true,
      review: { show: notHeld, release: notHeld, reject: notHeld },
    });
    const route = routes(controller, await admittedRequest());
    for (const attempt of [route.show, route.release, route.reject])
      await expect(attempt()).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect(logged.map((entry) => entry.fields?.['outcome'])).toEqual(['not_held', 'not_held', 'not_held']);
  });

  it('give an operator a malformed asset or revision as an invalid request, after the operator check', async () => {
    const { controller, review } = wired({ operator: true });
    const route = routes(controller, await admittedRequest());
    for (const input of [
      { assetId: 'not-a-uuid', revision: '3' },
      { assetId, revision: '0' },
      { assetId, revision: '3.5' },
      { assetId, revision: 'x' },
    ]) {
      await expect(route.show(input)).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 });
      await expect(route.release(input)).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 });
    }
    expect(review.show).not.toHaveBeenCalled();
    expect(review.release).not.toHaveBeenCalled();
  });

  it('read a held revision for the signed-in account, with the asset in lower case', async () => {
    const { controller, review } = wired({ operator: true });
    const route = routes(controller, await admittedRequest());
    // The fixture review answers `unreadable`, which the route says as a problem the screen can show.
    await expect(route.show()).rejects.toMatchObject({ code: 'UNPROCESSABLE_REQUEST', status: 422 });
    expect(review.show).toHaveBeenCalledExactlyOnceWith(accountId, target);
  });

  it('release and reject through the review as the signed-in account, and log the decision with the recipe key and no reason', async () => {
    const { controller, review, logged } = wired({ operator: true });
    const route = routes(controller, await admittedRequest());
    expect(await route.release()).toEqual(released);
    expect(review.release).toHaveBeenCalledExactlyOnceWith(accountId, target);
    expect(await route.reject({ assetId, revision: '3', reason: 'The picture says the opposite.' })).toEqual(rejected);
    expect(review.reject).toHaveBeenCalledExactlyOnceWith(accountId, target, 'The picture says the opposite.');
    const decisions = logged.filter((entry) => entry.event === 'content.review_decided');
    expect(decisions.map((entry) => entry.fields)).toEqual([
      { severity: 'info', context: 'broad-street', outcome: 'released', revision: 3 },
      { severity: 'info', context: 'broad-street', outcome: 'rejected', revision: 3 },
    ]);
    expect(JSON.stringify(logged)).not.toContain('opposite');
  });

  it('answer a refused release as a result with its reason, and a reason that is not valid as an invalid request', async () => {
    const refused: ReviewReleaseResult = { outcome: 'refused', reason: 'coverage_missing', replacedRevision: null };
    const { controller, logged } = wired({
      operator: true,
      review: {
        release: () => Promise.resolve({ kind: 'decided', result: refused, recipe: null }),
        reject: () => Promise.resolve({ kind: 'reason_invalid' }),
      },
    });
    const route = routes(controller, await admittedRequest());
    expect(await route.release()).toEqual(refused);
    expect(logged.at(-1)).toMatchObject({
      event: 'content.review_decided',
      fields: { severity: 'warn', context: 'unknown_recipe', outcome: 'refused', reasonCode: 'coverage_missing' },
    });
    await expect(route.reject({ assetId, revision: '3' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      status: 400,
    });
  });
});
