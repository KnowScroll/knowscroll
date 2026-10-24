import { createAccountScope, memoryStore } from '@knowscroll/client-core';
import type {
  CancelContentRequest,
  ContentRequestList,
  ContentRequestStatus,
  CreateContentRequest,
} from '@knowscroll/contracts';
import { id } from '../encounter/encounter-session.fixture';
import { createRequestsListSession } from './requests-list-session';

/** Labelled CI HTTP fixture: the actual typed transport and AccountScope, no live backend. */
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const stamp = '2026-10-20T10:00:00.000Z';

type Listed = ContentRequestList['requests'][number];
export const preparing = (n: number, title = `Ask ${String(n)}`, revision = 1): Listed => ({
  title,
  format: 'scroll',
  status: {
    version: 'content-request-status.v1',
    requestId: id(n),
    privacyEpoch: 1,
    requestRevision: revision,
    revision: 3,
    createdAt: stamp,
    updatedAt: stamp,
    status: 'preparing',
    phase: 'preparing',
  },
});
export const readyItem = (n: number, kind: 'reel' | 'scroll' = 'scroll'): Listed => {
  const status: ContentRequestStatus = {
    ...preparing(n).status,
    requestRevision: 2,
    status: 'ready',
    content: {
      assetId: id(n + 500),
      assetRevision: 1,
      explanationUnitId: 'fixture-only',
      metadata: { kind, title: `Ready ${String(n)}`, summary: 'CI only', language: 'en' },
    },
  };
  return { title: `Ready ${String(n)}`, format: kind, status };
};
export const closedItem = (
  n: number,
  reason: 'unsupported_request' | 'could_not_prepare' | 'budget_unavailable' = 'could_not_prepare',
): Listed => ({
  title: `Closed ${String(n)}`,
  format: 'scroll',
  status: { ...preparing(n).status, requestRevision: 2, status: 'unavailable', reason },
});

export function requestsListHarness(first: readonly Listed[] = [preparing(10)]) {
  let counter = 5000;
  let items = first;
  let listFailure = false;
  let cancelFailure: 'unknown' | 'refused' | false = false;
  let createFailure: 'unknown' | 'refused' | false = false;
  const calls: { method: string; path: string; body?: CancelContentRequest | CreateContentRequest }[] = [];
  const scope = createAccountScope({
    account: { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'requests@fixture.test' },
    baseUrl: 'https://fixture.requests.test',
    authorization: () => undefined,
    store: memoryStore(),
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (request.method === 'POST' && path === '/v1/content/requests/cancel') {
        const body = (await request.json()) as CancelContentRequest;
        calls.push({ method: 'POST', path, body });
        if (cancelFailure === 'unknown') throw new Error('unknown_cancel');
        if (cancelFailure === 'refused')
          return json({ type: 'about:blank', title: 'Not found', status: 404, code: 'NOT_FOUND' }, 404);
        items = items.map((item) =>
          item.status.requestId === body.requestId
            ? {
                ...item,
                status: { ...item.status, requestRevision: item.status.requestRevision + 1, status: 'cancelled' },
              }
            : item,
        );
        return json({
          version: 'content-request-cancel-receipt.v1',
          commandId: body.commandId,
          requestId: body.requestId,
          recordedAt: stamp,
          privacyEpoch: 1,
          revision: 4,
          replayed: false,
          outcome: 'cancelled',
        });
      }
      if (request.method === 'POST' && path === '/v1/content/requests') {
        const body = (await request.json()) as CreateContentRequest;
        calls.push({ method: 'POST', path, body });
        if (createFailure === 'unknown') throw new Error('unknown_create');
        if (createFailure === 'refused')
          return json({ type: 'about:blank', title: 'Too many', status: 429, code: 'TOO_MANY_REQUESTS' }, 429);
        const created = preparing(
          6000 + counter++,
          body.intent.kind === 'topic' && body.intent.subject.kind === 'text'
            ? body.intent.subject.text
            : 'Asked again',
        );
        items = [{ ...created, status: { ...created.status, createdAt: '2026-10-20T11:00:00.000Z' } }, ...items];
        return json({
          version: 'content-request-receipt.v1',
          commandId: body.commandId,
          requestId: created.status.requestId,
          recordedAt: stamp,
          privacyEpoch: 1,
          revision: 5,
          replayed: false,
          outcome: 'accepted',
        });
      }
      calls.push({ method: request.method, path });
      if (listFailure) throw new Error('offline');
      return json({ version: 'content-request-list.v1', requests: items });
    },
  });
  const session = createRequestsListSession(scope, () => id(++counter));
  return {
    scope,
    session,
    calls,
    reads: () => calls.filter((call) => call.method === 'GET').length,
    cancels: () => calls.filter((call) => call.path.endsWith('/cancel')),
    creates: () => calls.filter((call) => call.method === 'POST' && call.path === '/v1/content/requests'),
    setItems: (next: readonly Listed[]) => {
      items = next;
    },
    setListFailure: (value: boolean) => {
      listFailure = value;
    },
    setCancelFailure: (value: 'unknown' | 'refused' | false) => {
      cancelFailure = value;
    },
    setCreateFailure: (value: 'unknown' | 'refused' | false) => {
      createFailure = value;
    },
  };
}
