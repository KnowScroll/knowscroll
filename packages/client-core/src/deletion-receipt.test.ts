import { describe, expect, it } from 'vitest';
import type { DeletionReceiptClient, DeletionReceiptOutcome } from './auth-client';
import { memoryStore } from './account-scope';
import { DELETION_RECEIPT_KEY, createDeletionReceiptSession } from './deletion-receipt';

const receipt = '0199a000-0000-7000-8000-000000000099';

function fixture(stored?: string) {
  const store = memoryStore();
  if (stored !== undefined) store.setItem(DELETION_RECEIPT_KEY, stored);
  const answers: { read: DeletionReceiptOutcome; retry: DeletionReceiptOutcome } = {
    read: { kind: 'state', state: 'in_progress' },
    retry: { kind: 'state', state: 'in_progress' },
  };
  const asked: string[] = [];
  const auth: DeletionReceiptClient = {
    readDeletion: (id) => {
      asked.push(`read ${id}`);
      return Promise.resolve(answers.read);
    },
    retryDeletion: (id) => {
      asked.push(`retry ${id}`);
      return Promise.resolve(answers.retry);
    },
  };
  return { store, answers, asked, session: createDeletionReceiptSession({ auth, store }) };
}

describe('the deletion receipt of this device', () => {
  it('starts empty, and remembers an id in the store before anything is asked', () => {
    const { session, store } = fixture();
    expect(session.getState()).toEqual({ status: 'none' });
    session.remember(receipt);
    expect(store.getItem(DELETION_RECEIPT_KEY)).toBe(receipt);
    expect(session.getState()).toEqual({ status: 'unchecked', receiptId: receipt });
  });

  it('picks a remembered receipt up again after a reload', () => {
    expect(fixture(receipt).session.getState()).toEqual({ status: 'unchecked', receiptId: receipt });
  });

  it('reads the state without a session and passes it on', async () => {
    const { session, answers, asked } = fixture(receipt);
    await session.refresh();
    expect(session.getState()).toEqual({ status: 'in_progress', receiptId: receipt });
    answers.read = { kind: 'state', state: 'needs_retry' };
    await session.refresh();
    expect(session.getState().status).toBe('needs_retry');
    answers.read = { kind: 'state', state: 'completed' };
    await session.refresh();
    expect(session.getState().status).toBe('completed');
    expect(asked).toEqual([`read ${receipt}`, `read ${receipt}`, `read ${receipt}`]);
  });

  it('forgets a receipt the server does not know: that request never arrived', async () => {
    const { session, store, answers } = fixture(receipt);
    answers.read = { kind: 'unknown' };
    await session.refresh();
    expect(session.getState()).toEqual({ status: 'none' });
    expect(store.getItem(DELETION_RECEIPT_KEY)).toBeNull();
  });

  it('keeps the receipt when the server cannot be reached or throttles', async () => {
    const { session, answers } = fixture(receipt);
    answers.read = { kind: 'unavailable' };
    await session.refresh();
    expect(session.getState()).toEqual({ status: 'unavailable', receiptId: receipt });
    answers.read = { kind: 'rate_limited', retryAfterSeconds: 30 };
    await session.refresh();
    expect(session.getState().status).toBe('unavailable');
  });

  it('asks for a retry and shows the answer, one question at a time', async () => {
    const { session, answers, asked } = fixture(receipt);
    answers.retry = { kind: 'state', state: 'in_progress' };
    const first = session.retry();
    const second = session.retry();
    expect(session.getState().status).toBe('checking');
    await Promise.all([first, second]);
    expect(asked).toEqual([`retry ${receipt}`]);
    expect(session.getState()).toEqual({ status: 'in_progress', receiptId: receipt });
  });

  it('drops the receipt on request and ignores an answer that arrives after', async () => {
    const { session, store, answers } = fixture(receipt);
    answers.read = { kind: 'state', state: 'completed' };
    const pending = session.refresh();
    session.forget();
    await pending;
    expect(session.getState()).toEqual({ status: 'none' });
    expect(store.getItem(DELETION_RECEIPT_KEY)).toBeNull();
    await session.refresh();
    await session.retry();
    expect(session.getState()).toEqual({ status: 'none' });
  });
});
