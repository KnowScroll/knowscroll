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
});
