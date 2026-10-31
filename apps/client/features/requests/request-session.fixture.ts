import { createAccountScope, memoryStore } from '@knowscroll/client-core';
import { problemDetails, type ContentRequestStatus, type CreateContentRequest } from '@knowscroll/contracts';
import { createRequestSession } from './request-session';
import { id } from '../encounter/encounter-session.fixture';

const json = (value: unknown) =>
  new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
const createdAt = '2026-10-20T10:00:00.000Z';
export function requestHarness() {
  let counter = 1000;
  let source = {
    exposureId: id(4),
    assetId: id(5),
    assetRevision: 2,
    session: { sessionId: id(6), expectedIntentRevision: 3 },
  };
  const fields = {
    version: 'content-request-status.v1',
    requestId: id(10),
    privacyEpoch: 1,
    requestRevision: 1,
    revision: 3,
    createdAt,
    updatedAt: createdAt,
  } as const;
  let status: ContentRequestStatus = { ...fields, status: 'preparing', phase: 'requested' };
  let createFailure: boolean | 'too_many_open' | 'recording_paused' = false;
  /** The recording policy the server reads back; an ask from here carries its generation (D-083). */
  let recording = { on: true, generation: 1 };
  let cancelFailure = false;
  let retryFailure: 'unknown' | 'refused' | 'too_many_open' | false = false;
  let retryOutcome: 'retrying' | 'already_open' | 'not_retryable' = 'retrying';
  let withdrawn = false;
  let readGate: Promise<void> | undefined;
  let createGate: Promise<void> | undefined;
  const calls: { path: string; method: string; body: unknown }[] = [];
  const opens: unknown[] = [];
  const store = memoryStore();
  const scope = createAccountScope({
    account: { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'requests@fixture.test' },
    baseUrl: 'https://fixture.requests.test',
    authorization: () => undefined,
    store,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      const body = request.method === 'POST' ? ((await request.json()) as CreateContentRequest) : undefined;
      if (path === '/v1/privacy/recording/read')
        return json({
          version: 'recording-policy.v1',
          ...body,
          scope: { accountId: id(1), privacyEpoch: 1 },
          revision: 0,
          policy: recording,
        });
      calls.push({ path, method: request.method, body });
      if (path === '/v1/content/requests/cancel') {
        if (cancelFailure) throw new Error('unknown_cancel');
        // Only this private waiter changes; no shared work state is available to the client.
        status = { ...fields, status: 'cancelled', requestRevision: status.requestRevision + 1 };
        return json({
          version: 'content-request-cancel-receipt.v1',
          commandId: body!.commandId,
          requestId: status.requestId,
          recordedAt: createdAt,
          privacyEpoch: 1,
          revision: 4,
          replayed: false,
          outcome: 'cancelled',
        });
      }
      if (path === '/v1/content/requests/retry') {
        if (retryFailure === 'unknown') throw new Error('unknown_retry');
        if (retryFailure === 'refused' || retryFailure === 'too_many_open') {
          const code = retryFailure === 'refused' ? 'NOT_FOUND' : 'TOO_MANY_REQUESTS';
          return new Response(JSON.stringify(problemDetails(code)), {
            status: retryFailure === 'refused' ? 404 : 429,
            headers: { 'content-type': 'application/problem+json' },
          });
        }
        // The same request goes back to preparing at a higher revision, as the server does.
        if (retryOutcome === 'retrying')
          status = { ...fields, status: 'preparing', phase: 'preparing', requestRevision: status.requestRevision + 1 };
        return json({
          version: 'content-request-retry-receipt.v1',
          commandId: body!.commandId,
          requestId: status.requestId,
          recordedAt: createdAt,
          privacyEpoch: 1,
          revision: 5,
          replayed: false,
          outcome: retryOutcome,
        });
      }
      if (request.method === 'POST') {
        await createGate;
        if (createFailure === 'too_many_open')
          return new Response(JSON.stringify(problemDetails('TOO_MANY_REQUESTS')), {
            status: 429,
            headers: { 'content-type': 'application/problem+json' },
          });
        if (createFailure === 'recording_paused')
          return new Response(JSON.stringify(problemDetails('RECORDING_PAUSED')), {
            status: 409,
            headers: { 'content-type': 'application/problem+json' },
          });
        if (createFailure) throw new Error('unknown_create');
        return json({
          version: 'content-request-receipt.v1',
          commandId: body!.commandId,
          requestId: status.requestId,
          recordedAt: createdAt,
          privacyEpoch: 1,
          revision: 2,
          replayed: true,
          outcome: 'accepted',
        });
      }
      const frozen = status;
      await readGate;
      if (withdrawn) {
        const problem = problemDetails('NOT_FOUND');
        return new Response(JSON.stringify(problem), {
          status: 404,
          headers: { 'content-type': 'application/problem+json' },
        });
      }
      return json(frozen);
    },
  });
  const session = createRequestSession(
    scope,
    () => id(++counter),
    () => ({ ...source, session: { ...source.session } }),
    (target) => {
      opens.push(target);
      return true;
    },
  );
  session.show('topic');
  session.visible(true);
  return {
    fields,
    scope,
    store,
    session,
    calls,
    opens,
    setCreateFailure: (value: boolean | 'too_many_open' | 'recording_paused') => {
      createFailure = value;
    },
    setRecording: (value: { on: boolean; generation: number }) => {
      recording = value;
    },
    setCancelFailure: (value: boolean) => {
      cancelFailure = value;
    },
    setRetryFailure: (value: 'unknown' | 'refused' | 'too_many_open' | false) => {
      retryFailure = value;
    },
    setRetryOutcome: (value: 'retrying' | 'already_open' | 'not_retryable') => {
      retryOutcome = value;
    },
    setReadGate: (value: Promise<void> | undefined) => {
      readGate = value;
    },
    setCreateGate: (value: Promise<void> | undefined) => {
      createGate = value;
    },
    setWithdrawn: (value: boolean) => {
      withdrawn = value;
    },
    setStatus: (value: ContentRequestStatus) => {
      status = value;
    },
    status: () => status,
    changeSource: () => {
      source = {
        ...source,
        session: { ...source.session, expectedIntentRevision: source.session.expectedIntentRevision + 1 },
      };
    },
  };
}
