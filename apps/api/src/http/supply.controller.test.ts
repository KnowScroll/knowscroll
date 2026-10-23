import 'reflect-metadata';
import { call } from '@orpc/server';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type {
  ContentRequestReceipt,
  ContentRequestStatus,
  CancelContentRequestReceipt,
  ContentRequestList,
  CreateContentRequest,
  ProblemCode,
} from '@knowscroll/contracts';
import type { Refusal } from '@knowscroll/backend/modules/supply';
import type { Caller } from './callers.js';
import { scopeGuard } from './scope-guard.js';
import { SupplyController } from './supply.controller.js';

const id = '0199a000-0000-7000-8000-000000000001';
const accountId = '0199a000-0000-7000-8000-000000000002';
const caller: Caller = { accountId, universeId: id, privacyEpoch: 2, sessionId: id, credential: 'cookie' };
const authority = { universeId: id, privacyEpoch: 2, actor: { kind: 'account', accountId } };
const createInput: CreateContentRequest = {
  version: 'content-request.v1',
  commandId: id,
  intent: { kind: 'topic', subject: { kind: 'text', text: 'Authored fixture topic' }, format: 'either' },
  language: 'en',
  capabilities: { documentSchemas: ['scroll-document.v1'], blocks: { fallback: [1] } },
};
const cancelInput = { version: 'content-request-cancel.v1' as const, commandId: id, requestId: id };
const receipt: ContentRequestReceipt = {
  version: 'content-request-receipt.v1',
  commandId: id,
  requestId: id,
  recordedAt: '2026-10-20T00:00:00.000Z',
  privacyEpoch: 2,
  revision: 3,
  replayed: true,
  outcome: 'accepted',
};
const cancellation: CancelContentRequestReceipt = {
  ...receipt,
  version: 'content-request-cancel-receipt.v1',
  outcome: 'already_closed',
};
const status: ContentRequestStatus = {
  version: 'content-request-status.v1',
  requestId: id,
  privacyEpoch: 2,
  requestRevision: 2,
  revision: 4,
  createdAt: receipt.recordedAt,
  updatedAt: receipt.recordedAt,
  status: 'unavailable',
  reason: 'unsupported_request',
};
const listing: ContentRequestList = {
  version: 'content-request-list.v1',
  requests: [{ title: 'Seasons', format: 'scroll', status }],
};
async function admittedRequest(): Promise<Request> {
  const request = { path: '/v1/content/requests', headers: { 'x-ks-scope': `${accountId}:2` } } as unknown as Request;
  const next = vi.fn();
  await scopeGuard({
    callers: { resolve: () => Promise.resolve(caller), sessionValid: () => Promise.resolve(true) },
    logEvent: () => undefined,
  })(request, {} as Response, next);
  expect(next).toHaveBeenCalledOnce();
  return request;
}
function wired() {
  const create = vi.fn(() => Promise.resolve({ kind: 'ok' as const, value: receipt }));
  const read = vi.fn(() => Promise.resolve({ kind: 'ok' as const, value: status }));
  const list = vi.fn(() => Promise.resolve({ kind: 'ok' as const, value: listing }));
  const cancel = vi.fn(() => Promise.resolve({ kind: 'ok' as const, value: cancellation }));
  return { controller: new SupplyController(create, read, list, cancel), create, read, list, cancel };
}

describe('Supply guarded HTTP contract adapter', () => {
  it('dispatches exact inputs with admitted authority and preserves independent receipt/status values', async () => {
    const { controller, create, read, list, cancel } = wired();
    const request = await admittedRequest();
    expect(await call(controller.createRoute(request), createInput)).toEqual(receipt);
    expect(create).toHaveBeenCalledExactlyOnceWith(authority, createInput);
    expect(read).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(await call(controller.readRoute(request), { requestId: id })).toEqual(status);
    expect(read).toHaveBeenCalledExactlyOnceWith(authority, { requestId: id });
    expect(create).toHaveBeenCalledTimes(1);
    expect(await call(controller.listRoute(request), undefined)).toEqual(listing);
    expect(list).toHaveBeenCalledExactlyOnceWith(authority);
    expect(await call(controller.cancelRoute(request), cancelInput)).toEqual(cancellation);
    expect(cancel).toHaveBeenCalledExactlyOnceWith(authority, cancelInput);
  });

  const refusalCodes: Record<Refusal, ProblemCode> = {
    scope_refused: 'UNIVERSE_UNAVAILABLE',
    command_key_reused: 'COMMAND_KEY_REUSED',
    receipt_unavailable: 'SERVICE_UNAVAILABLE',
    source_unavailable: 'ASSET_NOT_FOUND',
    stale_source: 'ASSET_REVISION_STALE',
    not_found: 'NOT_FOUND',
  };
  for (const reason of Object.keys(refusalCodes) as Refusal[])
    it(`maps ${reason} consistently without backend details`, async () => {
      const refused = vi.fn(() => Promise.resolve({ kind: 'refused' as const, reason }));
      const controller = new SupplyController(refused, refused, refused, refused);
      const request = await admittedRequest();
      for (const invoke of [
        () => call(controller.createRoute(request), createInput),
        () => call(controller.readRoute(request), { requestId: id }),
        () => call(controller.listRoute(request), undefined),
        () => call(controller.cancelRoute(request), cancelInput),
      ]) {
        await expect(invoke()).rejects.toMatchObject({ code: refusalCodes[reason], data: {} });
      }
      expect(refused).toHaveBeenCalledTimes(4);
    });

  it('refuses every unguarded handler before its use case runs', async () => {
    const { controller, create, read, list, cancel } = wired();
    const request = {} as unknown as Request;
    await expect(call(controller.createRoute(request), createInput)).rejects.toThrow('without the scope guard');
    await expect(call(controller.readRoute(request), { requestId: id })).rejects.toThrow('without the scope guard');
    await expect(call(controller.listRoute(request), undefined)).rejects.toThrow('without the scope guard');
    expect(list).not.toHaveBeenCalled();
    await expect(call(controller.cancelRoute(request), cancelInput)).rejects.toThrow('without the scope guard');
    expect(create).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('strictly validates all three inputs before dispatch', async () => {
    const { controller, create, read, cancel } = wired();
    const request = await admittedRequest();
    const crossAccount = { ...createInput, accountId };
    const crossEpoch = { ...cancelInput, privacyEpoch: 2 };
    await expect(call(controller.createRoute(request), crossAccount)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(call(controller.createRoute(request), { ...createInput, commandId: 'bad' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(call(controller.readRoute(request), { requestId: 'bad' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(call(controller.cancelRoute(request), crossEpoch)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(create).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('validates backend output instead of emitting a malformed acceptance receipt', async () => {
    const create = vi.fn(() => Promise.resolve({ kind: 'ok' as const, value: { ...receipt, requestId: 'bad' } }));
    const { read, list, cancel } = wired();
    const controller = new SupplyController(create, read, list, cancel);
    await expect(call(controller.createRoute(await admittedRequest()), createInput)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
    expect(create).toHaveBeenCalledOnce();
  });
});
