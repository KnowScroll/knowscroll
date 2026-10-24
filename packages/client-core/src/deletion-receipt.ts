import type { AccountDeletionState } from '@knowscroll/contracts';
import type { DeletionReceiptClient } from './auth-client';
import type { KeyValueStore } from './account-scope';

/** Where a device keeps the id of the deletion it asked for. It names no one and is no credential. */
export const DELETION_RECEIPT_KEY = 'ks.deletion.receipt';

/**
 * What the device knows about its account deletion (P02 "Receipts"). `none`: no deletion was asked
 * for from here. `unchecked`: a receipt exists and has not been asked about yet.
 */
export type DeletionReceiptState =
  | { readonly status: 'none' }
  | { readonly status: 'unchecked' | 'checking'; readonly receiptId: string }
  | { readonly status: 'unavailable'; readonly receiptId: string }
  | { readonly status: AccountDeletionState; readonly receiptId: string };

/**
 * The receipt of this device's account deletion. Deletion ends every session, so the receipt is
 * read without one (`/auth/deletion/{id}`), and it lives outside any account scope: remembered in
 * the device's key-value store (web: kept; native: in memory until a persistent store exists)
 * before the request is sent, so a lost answer can still be recovered by asking about it.
 */
export interface DeletionReceiptSession {
  readonly getState: () => DeletionReceiptState;
  readonly subscribe: (listener: () => void) => () => void;
  /** Keeps the id of a deletion about to be requested. */
  readonly remember: (receiptId: string) => void;
  /** Asks the server how it is going. A receipt the server does not know is forgotten: it never arrived. */
  readonly refresh: () => Promise<void>;
  /** Asks for the same deletion to be worked on again now. */
  readonly retry: () => Promise<void>;
  /** Drops the receipt (after "Done", or when the request was refused). */
  readonly forget: () => void;
}

export function createDeletionReceiptSession(options: {
  readonly auth: DeletionReceiptClient;
  readonly store: KeyValueStore;
}): DeletionReceiptSession {
  const listeners = new Set<() => void>();
  const initial = options.store.getItem(DELETION_RECEIPT_KEY);
  let state: DeletionReceiptState = initial === null ? { status: 'none' } : { status: 'unchecked', receiptId: initial };
  let inFlight: Promise<void> | undefined;

  function set(next: DeletionReceiptState): void {
    state = next;
    for (const listener of [...listeners]) listener();
  }

  function forget(): void {
    options.store.removeItem(DELETION_RECEIPT_KEY);
    set({ status: 'none' });
  }

  async function ask(
    receiptId: string,
    question: () => ReturnType<DeletionReceiptClient['readDeletion']>,
  ): Promise<void> {
    set({ status: 'checking', receiptId });
    const outcome = await question();
    // The receipt may have been forgotten or replaced while the answer was on its way.
    if (state.status === 'none' || state.receiptId !== receiptId) return;
    if (outcome.kind === 'state') set({ status: outcome.state, receiptId });
    else if (outcome.kind === 'unknown') forget();
    else set({ status: 'unavailable', receiptId });
  }

  function once(run: () => Promise<void>): Promise<void> {
    inFlight ??= run().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    remember(receiptId) {
      options.store.setItem(DELETION_RECEIPT_KEY, receiptId);
      set({ status: 'unchecked', receiptId });
    },
    refresh() {
      const current = state;
      if (current.status === 'none') return Promise.resolve();
      return once(() => ask(current.receiptId, () => options.auth.readDeletion(current.receiptId)));
    },
    retry() {
      const current = state;
      if (current.status === 'none') return Promise.resolve();
      return once(() => ask(current.receiptId, () => options.auth.retryDeletion(current.receiptId)));
    },
    forget,
  };
}
