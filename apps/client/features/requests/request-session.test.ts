import { waitFor } from '@testing-library/react-native';
import type { ContentRequestStatus } from '@knowscroll/contracts';
import { requestHarness } from './request-session.fixture';
import { id } from '../encounter/encounter-session.fixture';
const ready = (h: ReturnType<typeof requestHarness>, revision = 2): ContentRequestStatus => ({
  ...h.fields,
  requestRevision: revision,
  status: 'ready',
  content: {
    assetId: id(44),
    assetRevision: 7,
    explanationUnitId: 'fixture-only',
    metadata: { kind: 'scroll', title: 'Ready fixture', summary: 'CI only', language: 'en' },
  },
});
const posts = (h: ReturnType<typeof requestHarness>) => h.calls.filter((call) => call.method === 'POST');
function ask(h: ReturnType<typeof requestHarness>) {
  h.session.edit({ text: 'private prose' });
  h.session.submit();
}

describe('request consumer over actual scoped HTTP fixture transport', () => {
  it('freezes an uncertain command and retries its exact bytes without edits or a second ID', async () => {
    const h = requestHarness();
    try {
      h.setCreateFailure(true);
      ask(h);
      await waitFor(() => expect(h.session.getState().phase).toBe('send_unknown'));
      h.session.edit({ text: 'changed' });
      h.session.submit();
      h.session.startAgain();
      h.setCreateFailure(false);
      h.session.retrySend();
      await waitFor(() => expect(h.session.getState().status?.status).toBe('preparing'));
      expect(posts(h)).toHaveLength(2);
      expect(posts(h)[1]!.body).toEqual(posts(h)[0]!.body);
      expect(h.session.getState().text).toBe('private prose');
      expect(h.store.keys()).toEqual([]);
      expect(h.opens).toEqual([]);
    } finally {
      h.scope.end();
    }
  });
  it('says so when the person already has the most open asks, and keeps the draft', async () => {
    const h = requestHarness();
    try {
      h.setCreateFailure('too_many_open');
      ask(h);
      await waitFor(() => expect(h.session.getState().phase).toBe('refused'));
      expect(h.session.getState()).toMatchObject({ error: 'too_many_open', text: 'private prose' });
      expect(h.session.getState().receipt).toBeUndefined();
    } finally {
      h.scope.end();
    }
  });
  it('keeps immutable replay acceptance separate from current read and refuses withdrawn Open', async () => {
    const h = requestHarness();
    let release = () => {};
    try {
      h.setReadGate(
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      ask(h);
      await waitFor(() => expect(h.session.getState().receipt?.replayed).toBe(true));
      const receipt = h.session.getState().receipt;
      expect(h.session.getState().status).toBeUndefined();
      expect(h.opens).toEqual([]);
      release();
      h.setReadGate(undefined);
      await waitFor(() => expect(h.session.getState().status?.status).toBe('preparing'));
      h.setStatus(ready(h));
      await h.session.refresh();
      expect(h.session.getState().receipt).toBe(receipt);
      expect(h.opens).toEqual([]);
      h.setWithdrawn(true);
      expect(await h.session.openReady()).toBe(false);
      expect(h.opens).toEqual([]);
      expect(posts(h)).toHaveLength(1);
      h.setWithdrawn(false);
      expect(await h.session.openReady()).toBe(true);
      expect(h.opens).toEqual([{ kind: 'return', assetId: id(44), assetRevision: 7 }]);
    } finally {
      release();
      h.scope.end();
    }
  });
  it('retains highest request revision, and ready becoming unavailable blocks opening', async () => {
    const h = requestHarness();
    try {
      ask(h);
      await waitFor(() => expect(h.session.getState().status).toBeDefined());
      h.setStatus(ready(h, 4));
      await h.session.refresh();
      h.setStatus({ ...h.fields, requestRevision: 2, status: 'preparing', phase: 'requested' });
      await h.session.refresh();
      expect(h.session.getState().status?.requestRevision).toBe(4);
      h.setStatus({ ...h.fields, requestRevision: 5, status: 'unavailable', reason: 'source_unavailable' });
      await h.session.refresh();
      expect(await h.session.openReady()).toBe(false);
      expect(h.opens).toEqual([]);
    } finally {
      h.scope.end();
    }
  });
  it('does not silently replace source/session lineage and sends explicit catalogue intent only when chosen', async () => {
    const h = requestHarness();
    try {
      h.session.edit({ text: 'tides private prose', about: true });
      h.changeSource();
      h.session.submit();
      expect(h.session.getState().error).toBe('source');
      expect(posts(h)).toEqual([]);
      h.session.show('topic');
      h.session.edit({ text: 'unrelated private prose', topicId: 'earth.tides', about: true });
      // Typing clears an old selected suggestion; explicit selection is a distinct deliberate choice.
      h.session.edit({ topicId: 'earth.tides' });
      h.session.submit();
      await waitFor(() => expect(h.session.getState().receipt).toBeDefined());
      expect(posts(h)[0]!.body).toMatchObject({
        intent: {
          kind: 'topic',
          subject: { kind: 'catalogue', topicId: 'earth.tides' },
          context: { exposureId: id(4), assetRevision: 2, session: { sessionId: id(6), expectedIntentRevision: 4 } },
        },
      });
      expect(JSON.stringify(posts(h)[0]!.body)).not.toContain('unrelated private prose');
    } finally {
      h.scope.end();
    }
  });
  it('cancellation retries only its frozen waiter command and trusts status rather than receipt outcome', async () => {
    const h = requestHarness();
    try {
      ask(h);
      await waitFor(() => expect(h.session.getState().status?.status).toBe('preparing'));
      h.setCancelFailure(true);
      h.session.cancel();
      await waitFor(() => expect(h.session.getState().phase).toBe('cancel_unknown'));
      expect(h.session.getState().status?.status).toBe('preparing');
      h.setCancelFailure(false);
      h.session.retryCancel();
      await waitFor(() => expect(h.session.getState().status?.status).toBe('cancelled'));
      const cancels = posts(h).filter((call) => call.path.endsWith('/cancel'));
      expect(cancels).toHaveLength(2);
      expect(cancels[1]!.body).toEqual(cancels[0]!.body);
      expect(cancels[0]!.body).toMatchObject({ requestId: id(10) });
      expect(posts(h)).toHaveLength(3);
      expect(h.opens).toEqual([]);
    } finally {
      h.scope.end();
    }
  });
  it('purges draft/frozen command/source/receipt/status and ignores late success after scope/account change', async () => {
    const h = requestHarness();
    const next = requestHarness();
    let release = () => {};
    try {
      h.setCreateGate(
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      ask(h);
      await waitFor(() => expect(posts(h)).toHaveLength(1));
      h.scope.end();
      release();
      await Promise.resolve();
      await Promise.resolve();
      expect(h.session.getState()).toMatchObject({ phase: 'ended', text: '' });
      expect(h.session.getState().source).toBeUndefined();
      expect(h.session.getState().receipt).toBeUndefined();
      expect(h.scope.queryClient.getQueryCache().getAll()).toEqual([]);
      expect(next.session.getState().text).toBe('');
      expect(next.calls).toEqual([]);
      h.session.retrySend();
      expect(posts(h)).toHaveLength(1);
    } finally {
      release();
      h.scope.end();
      next.scope.end();
    }
  });
  it('polls only while visible, stops at terminal, and never creates new work on read', async () => {
    jest.useFakeTimers();
    const h = requestHarness();
    try {
      ask(h);
      await jest.advanceTimersByTimeAsync(0);
      expect(h.session.getState().status?.status).toBe('preparing');
      h.session.visible(false);
      const count = h.calls.length;
      await jest.advanceTimersByTimeAsync(65000);
      expect(h.calls).toHaveLength(count);
      h.session.visible(true);
      await jest.advanceTimersByTimeAsync(0);
      h.setStatus(ready(h));
      await jest.advanceTimersByTimeAsync(5000);
      const terminal = h.calls.length;
      await jest.advanceTimersByTimeAsync(65000);
      expect(h.calls).toHaveLength(terminal);
      expect(posts(h)).toHaveLength(1);
      expect(h.opens).toEqual([]);
    } finally {
      h.scope.end();
      jest.useRealTimers();
    }
  });
  it('fences an old request read after a deliberate fresh request', async () => {
    const h = requestHarness();
    let release = () => {};
    try {
      ask(h);
      await waitFor(() => expect(h.session.getState().status).toBeDefined());
      h.setStatus(ready(h));
      await h.session.refresh();
      h.setReadGate(
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      const late = h.session.refresh();
      await waitFor(() => expect(h.calls.filter((call) => call.method === 'GET')).toHaveLength(3));
      h.session.startAgain();
      h.setStatus({ ...h.fields, requestId: id(11), status: 'preparing', phase: 'requested' });
      h.setReadGate(undefined);
      ask(h);
      await waitFor(() => expect(h.session.getState().status?.requestId).toBe(id(11)));
      release();
      await late;
      expect(h.session.getState().receipt?.requestId).toBe(id(11));
      expect(h.session.getState().status).toMatchObject({ requestId: id(11), status: 'preparing' });
      expect(h.opens).toEqual([]);
    } finally {
      release();
      h.scope.end();
    }
  });
  it('stops after twelve automatic reads without creating another command', async () => {
    jest.useFakeTimers();
    const h = requestHarness();
    try {
      ask(h);
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(120000);
      expect(h.calls.filter((call) => call.method === 'GET')).toHaveLength(13);
      expect(posts(h)).toHaveLength(1);
    } finally {
      h.scope.end();
      jest.useRealTimers();
    }
  });

  it("tries again after couldn't prepare by retrying the same request, or goes back to edit the words", async () => {
    const h = requestHarness();
    try {
      ask(h);
      await waitFor(() => expect(h.session.getState().status?.status).toBe('preparing'));
      h.setStatus({ ...h.fields, requestRevision: 2, status: 'unavailable', reason: 'could_not_prepare' });
      await h.session.refresh();
      h.session.tryAgain();
      await waitFor(() => expect(h.session.getState().status?.status).toBe('preparing'));
      // One create, one retry that names the same request: no second request beside the closed one.
      expect(posts(h).map((call) => call.path)).toEqual(['/v1/content/requests', '/v1/content/requests/retry']);
      expect(posts(h)[1]!.body).toMatchObject({
        version: 'content-request-retry.v1',
        requestId: h.fields.requestId,
      });
      expect(h.session.getState()).toMatchObject({ phase: 'accepted', error: undefined });
      expect(h.session.getState().status!.requestRevision).toBeGreaterThan(2);

      h.setStatus({ ...h.fields, requestRevision: 6, status: 'unavailable', reason: 'could_not_prepare' });
      await h.session.refresh();
      h.session.editAgain();
      expect(h.session.getState()).toMatchObject({ phase: 'draft', text: 'private prose', status: undefined });
      expect(posts(h)).toHaveLength(2);
    } finally {
      h.scope.end();
    }
  });

  it('repeats an unconfirmed retry with its exact command, and says plainly when the request cannot be retried', async () => {
    const h = requestHarness();
    try {
      ask(h);
      await waitFor(() => expect(h.session.getState().status?.status).toBe('preparing'));
      h.setStatus({ ...h.fields, requestRevision: 2, status: 'unavailable', reason: 'could_not_prepare' });
      await h.session.refresh();
      h.setRetryFailure('unknown');
      h.session.tryAgain();
      await waitFor(() => expect(h.session.getState().phase).toBe('retry_unknown'));
      h.setRetryFailure(false);
      h.session.retryTryAgain();
      await waitFor(() => expect(h.session.getState().status?.status).toBe('preparing'));
      const retries = posts(h).filter((call) => call.path.endsWith('/retry'));
      expect(retries).toHaveLength(2);
      expect((retries[1]!.body as { commandId: string }).commandId).toBe(
        (retries[0]!.body as { commandId: string }).commandId,
      );

      h.setStatus({ ...h.fields, requestRevision: 8, status: 'unavailable', reason: 'could_not_prepare' });
      await h.session.refresh();
      h.setRetryOutcome('not_retryable');
      h.session.tryAgain();
      await waitFor(() => expect(h.session.getState().error).toBe('not_retryable'));
      expect(h.session.getState()).toMatchObject({
        phase: 'accepted',
        status: { status: 'unavailable', reason: 'could_not_prepare' },
      });
      const fresh = posts(h).filter((call) => call.path.endsWith('/retry'));
      expect((fresh[2]!.body as { commandId: string }).commandId).not.toBe(
        (retries[0]!.body as { commandId: string }).commandId,
      );

      h.setRetryFailure('too_many_open');
      h.session.tryAgain();
      await waitFor(() => expect(h.session.getState().error).toBe('too_many_open'));
      expect(h.session.getState().phase).toBe('accepted');
    } finally {
      h.scope.end();
    }
  });

  it('does not ask again while a request is still waiting, and never reopens a ready one', async () => {
    const h = requestHarness();
    try {
      ask(h);
      await waitFor(() => expect(h.session.getState().status?.status).toBe('preparing'));
      h.session.tryAgain();
      h.session.editAgain();
      expect(h.session.getState().phase).toBe('accepted');
      h.setStatus(ready(h, 2));
      await h.session.refresh();
      h.session.tryAgain();
      expect(posts(h)).toHaveLength(1);
    } finally {
      h.scope.end();
    }
  });
});

describe('Ask from here (D1) in the request consumer', () => {
  const stop = { stopId: 'call-delhi' };
  const askFromHere = (h: ReturnType<typeof requestHarness>, question = '  Why is the far side cold?  ') => {
    h.session.show('ask', stop);
    h.session.edit({ text: question });
    h.session.submit();
  };

  it('sends the question with the exact source, the stop it came from and the recording generation, and nothing else', async () => {
    const h = requestHarness();
    try {
      askFromHere(h);
      await waitFor(() => expect(h.session.getState().status?.status).toBe('preparing'));
      expect(posts(h)).toHaveLength(1);
      expect(posts(h)[0]!.body).toMatchObject({
        version: 'content-request.v1',
        intent: {
          kind: 'ask',
          source: { exposureId: id(4), assetId: id(5), assetRevision: 2 },
          anchor: { kind: 'stop', stopId: 'call-delhi' },
          question: 'Why is the far side cold?',
          recordingGeneration: 1,
        },
      });
      // No format, no topic, no guess: the sheet decides none of it.
      expect(Object.keys((posts(h)[0]!.body as { intent: object }).intent).sort()).toEqual([
        'anchor',
        'kind',
        'question',
        'recordingGeneration',
        'source',
      ]);
      expect(h.store.keys()).toEqual([]);
    } finally {
      h.scope.end();
    }
  });

  it('is off while recording is paused: nothing is sent, and the sheet is told why', async () => {
    const h = requestHarness();
    try {
      h.setRecording({ on: false, generation: 2 });
      await h.scope.recording?.refresh();
      askFromHere(h);
      await waitFor(() => expect(h.session.getState().error).toBe('paused'));
      expect(posts(h)).toEqual([]);
      expect(h.session.getState()).toMatchObject({
        phase: 'draft',
        text: '  Why is the far side cold?  '.slice(0, 500),
      });
    } finally {
      h.scope.end();
    }
  });

  it('believes the server when it says recording is paused, though the device had not heard', async () => {
    const h = requestHarness();
    try {
      h.setCreateFailure('recording_paused');
      askFromHere(h);
      await waitFor(() => expect(h.session.getState().phase).toBe('refused'));
      expect(h.session.getState().error).toBe('paused');
    } finally {
      h.scope.end();
    }
  });

  it('sends "Something new" as a free-text ask with no source, and keeps the question a question when asked again', async () => {
    const h = requestHarness();
    try {
      h.session.show('ask', stop);
      h.session.edit({ about: false, text: 'How do tides work?' });
      h.session.submit();
      await waitFor(() => expect(h.session.getState().status?.status).toBe('preparing'));
      expect(posts(h)[0]!.body).toMatchObject({
        intent: { kind: 'topic', subject: { kind: 'text', text: 'How do tides work?' }, format: 'scroll' },
      });
      expect((posts(h)[0]!.body as { intent: object }).intent).not.toHaveProperty('context');
      h.setStatus({ ...h.fields, requestRevision: 2, status: 'unavailable', reason: 'unsupported_request' });
      await h.session.refresh();
      h.session.startAgain();
      expect(h.session.getState()).toMatchObject({ mode: 'ask', about: true, anchor: stop, text: '' });
    } finally {
      h.scope.end();
    }
  });

  it('moves an unsent question to the stop the person is on now, and refuses a source that changed under it', async () => {
    const h = requestHarness();
    try {
      h.session.show('ask', stop);
      h.session.edit({ text: 'Why is the far side cold?' });
      h.session.show('ask', { stopId: 'long-days' });
      expect(h.session.getState()).toMatchObject({
        anchor: { stopId: 'long-days' },
        text: 'Why is the far side cold?',
      });
      h.changeSource();
      h.session.submit();
      await waitFor(() => expect(h.session.getState().error).toBe('source'));
      expect(posts(h)).toEqual([]);
    } finally {
      h.scope.end();
    }
  });

  it('sends nothing for words that are too short, and is not sent twice by a double press', async () => {
    const h = requestHarness();
    try {
      h.session.show('ask', stop);
      h.session.edit({ text: 'ab' });
      h.session.submit();
      expect(posts(h)).toEqual([]);
      h.session.edit({ text: 'Why is the far side cold?' });
      h.session.submit();
      h.session.submit();
      await waitFor(() => expect(h.session.getState().status?.status).toBe('preparing'));
      expect(posts(h)).toHaveLength(1);
    } finally {
      h.scope.end();
    }
  });
});
