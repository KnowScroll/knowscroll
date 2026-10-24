import { waitFor } from '@testing-library/react-native';
import { closedItem, preparing, readyItem, requestsListHarness } from './requests-list.fixture';
import { REQUESTS_POLL_MS } from './requests-list-session';
import { id } from '../encounter/encounter-session.fixture';

describe('requests list session over the actual scoped HTTP fixture transport', () => {
  it('reads the person own asks when it becomes visible, and shows nothing it did not read', async () => {
    const h = requestsListHarness([readyItem(11), preparing(10), closedItem(12)]);
    try {
      expect(h.session.getState()).toMatchObject({ phase: 'loading', items: [] });
      h.session.visible(true);
      await waitFor(() => expect(h.session.getState().phase).toBe('ready'));
      expect(h.session.getState().items.map((item) => item.title)).toEqual(['Ready 11', 'Ask 10', 'Closed 12']);
      expect(h.calls.every((call) => call.method === 'GET')).toBe(true);
    } finally {
      h.scope.end();
    }
  });

  it('looks again only while visible and while something is preparing, and stops when nothing is', async () => {
    jest.useFakeTimers();
    const h = requestsListHarness([preparing(10)]);
    try {
      h.session.visible(true);
      await jest.advanceTimersByTimeAsync(0);
      expect(h.reads()).toBe(1);
      await jest.advanceTimersByTimeAsync(REQUESTS_POLL_MS);
      expect(h.reads()).toBe(2);
      h.session.visible(false);
      const hidden = h.reads();
      await jest.advanceTimersByTimeAsync(REQUESTS_POLL_MS * 3);
      expect(h.reads()).toBe(hidden);
      h.session.visible(true);
      await jest.advanceTimersByTimeAsync(0);
      h.setItems([readyItem(10)]);
      await jest.advanceTimersByTimeAsync(REQUESTS_POLL_MS);
      expect(h.session.getState().items[0]?.status.status).toBe('ready');
      const settled = h.reads();
      await jest.advanceTimersByTimeAsync(REQUESTS_POLL_MS * 5);
      expect(h.reads()).toBe(settled);
    } finally {
      h.scope.end();
      jest.useRealTimers();
    }
  });

  it('never moves a request back to an older revision', async () => {
    const h = requestsListHarness([readyItem(10)]);
    try {
      h.session.visible(true);
      await waitFor(() => expect(h.session.getState().items[0]?.status.status).toBe('ready'));
      h.setItems([preparing(10)]);
      await h.session.refresh();
      expect(h.session.getState().items[0]?.status.status).toBe('ready');
    } finally {
      h.scope.end();
    }
  });

  it('keeps the last list and marks it out of date when a refresh fails; a first failure is unavailable', async () => {
    const failing = requestsListHarness();
    failing.setListFailure(true);
    failing.session.visible(true);
    await waitFor(() => expect(failing.session.getState().phase).toBe('unavailable'));
    failing.scope.end();

    const h = requestsListHarness([preparing(10)]);
    try {
      h.session.visible(true);
      await waitFor(() => expect(h.session.getState().phase).toBe('ready'));
      h.setListFailure(true);
      await h.session.refresh();
      expect(h.session.getState()).toMatchObject({ phase: 'ready', stale: true });
      expect(h.session.getState().items).toHaveLength(1);
      h.setListFailure(false);
      await h.session.refresh();
      expect(h.session.getState().stale).toBe(false);
    } finally {
      h.scope.end();
    }
  });

  it('cancels one preparing request and refreshes; an unconfirmed cancel retries with the same command', async () => {
    const h = requestsListHarness([preparing(10), preparing(11)]);
    try {
      h.session.visible(true);
      await waitFor(() => expect(h.session.getState().phase).toBe('ready'));
      h.setCancelFailure('unknown');
      h.session.cancel(id(10));
      await waitFor(() => expect(h.session.getState().cancelling).toEqual({ requestId: id(10), phase: 'unknown' }));
      h.setCancelFailure(false);
      h.session.cancel(id(10));
      await waitFor(() => expect(h.session.getState().cancelling).toBeUndefined());
      const [first, second] = h.cancels();
      expect(second!.body).toEqual(first!.body);
      await waitFor(() =>
        expect(h.session.getState().items.map((item) => item.status.status)).toEqual(['cancelled', 'preparing']),
      );
    } finally {
      h.scope.end();
    }
  });

  it('drops a cancel the server refused, so the next press is a new command', async () => {
    const h = requestsListHarness([preparing(10)]);
    try {
      h.session.visible(true);
      await waitFor(() => expect(h.session.getState().phase).toBe('ready'));
      h.setCancelFailure('refused');
      h.session.cancel(id(10));
      await waitFor(() => expect(h.cancels()).toHaveLength(1));
      await waitFor(() => expect(h.session.getState().cancelling).toBeUndefined());
      h.setCancelFailure(false);
      h.session.cancel(id(10));
      await waitFor(() => expect(h.cancels()).toHaveLength(2));
      expect(h.cancels()[1]!.body!.commandId).not.toBe(h.cancels()[0]!.body!.commandId);
    } finally {
      h.scope.end();
    }
  });

  it('ends with the scope: no more reads, no state kept', async () => {
    jest.useFakeTimers();
    const h = requestsListHarness([preparing(10)]);
    try {
      h.session.visible(true);
      await jest.advanceTimersByTimeAsync(0);
      h.scope.end();
      const reads = h.reads();
      await jest.advanceTimersByTimeAsync(REQUESTS_POLL_MS * 4);
      expect(h.reads()).toBe(reads);
      expect(h.session.getState()).toMatchObject({ phase: 'ended', items: [] });
    } finally {
      jest.useRealTimers();
    }
  });
});
