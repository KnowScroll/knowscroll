import { apiProblem, type AccountScope } from '@knowscroll/client-core';
import type { CancelContentRequest, ContentRequestList } from '@knowscroll/contracts';

export type ListedRequest = ContentRequestList['requests'][number];

export interface RequestsListState {
  readonly phase: 'loading' | 'ready' | 'unavailable' | 'ended';
  /** The person's own asks, newest first. Never persisted. */
  readonly items: readonly ListedRequest[];
  /** The last refresh failed, so what is shown may be out of date. */
  readonly stale: boolean;
  /** The request whose cancel is being sent, or was sent and not confirmed (a retry reuses its command). */
  readonly cancelling?: { readonly requestId: string; readonly phase: 'sending' | 'unknown' };
}

/** How often a visible list looks again while something is still being prepared. */
export const REQUESTS_POLL_MS = 10_000;

const initial = (): RequestsListState => ({ phase: 'loading', items: [], stale: false });

/**
 * E07's requests sheet as a memory-only session over one AccountScope: the list is read from the
 * server, never kept on the device. A newer read never loses to an older one, and no item moves back
 * to an older request revision. While visible and while any request is still preparing it looks again
 * on a quiet timer; reading creates no work. Cancel is the same command as in the request sheet, and an
 * unconfirmed cancel is retried with its exact command ID.
 */
export function createRequestsListSession(scope: AccountScope, newCommandId: () => string) {
  let state = initial();
  let live = true;
  let visible = false;
  let readSerial = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingCancel: CancelContentRequest | undefined;
  const listeners = new Set<() => void>();
  const valid = () => live && scope.active;
  const publish = (patch: Partial<RequestsListState>) => {
    if (!valid()) return;
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };
  const stopTimer = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const schedule = () => {
    stopTimer();
    if (valid() && visible && state.items.some((item) => item.status.status === 'preparing'))
      timer = setTimeout(() => void refresh(), REQUESTS_POLL_MS);
  };
  /** Keeps the highest request revision seen for each request, so an older read cannot undo a newer one. */
  const merge = (incoming: readonly ListedRequest[]): readonly ListedRequest[] =>
    incoming.map((item) => {
      const known = state.items.find((entry) => entry.status.requestId === item.status.requestId);
      return known && known.status.requestRevision > item.status.requestRevision ? known : item;
    });

  async function refresh() {
    if (!valid()) return;
    const serial = ++readSerial;
    try {
      const list = await scope.api.supply.list();
      if (!valid() || serial !== readSerial) return;
      if (list.requests.some((item) => item.status.privacyEpoch !== scope.account.privacyEpoch))
        throw new Error('requests_lineage');
      publish({ phase: 'ready', items: merge(list.requests), stale: false });
    } catch {
      if (valid() && serial === readSerial)
        publish(state.phase === 'loading' ? { phase: 'unavailable' } : { stale: true });
    } finally {
      if (valid() && serial === readSerial) schedule();
    }
  }

  async function runCancel() {
    const command = pendingCancel;
    if (!valid() || !command) return;
    stopTimer();
    publish({ cancelling: { requestId: command.requestId, phase: 'sending' } });
    try {
      const receipt = await scope.api.supply.cancel(command);
      if (!valid()) return;
      if (
        receipt.commandId !== command.commandId ||
        receipt.requestId !== command.requestId ||
        receipt.privacyEpoch !== scope.account.privacyEpoch
      )
        throw new Error('cancel_lineage');
      pendingCancel = undefined;
      publish({ cancelling: undefined });
      await refresh();
    } catch (error) {
      if (!valid()) return;
      const problem = apiProblem(error);
      const refused = problem !== undefined && problem.status >= 400 && problem.status < 500;
      // A refusal ends the command; anything else may have reached the server and is retried unchanged.
      if (refused) pendingCancel = undefined;
      publish({ cancelling: refused ? undefined : { requestId: command.requestId, phase: 'unknown' } });
      schedule();
    }
  }

  scope.onEnd?.(() => {
    live = false;
    readSerial += 1;
    stopTimer();
    pendingCancel = undefined;
    state = { ...initial(), phase: 'ended' };
    listeners.forEach((listener) => listener());
    listeners.clear();
  });

  return {
    getState: () => state,
    subscribe(this: void, listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** The list is on screen: read it now, and keep looking while something is preparing. */
    visible(value: boolean) {
      visible = value && valid();
      stopTimer();
      if (visible) void refresh();
    },
    refresh,
    /** Cancels one preparing request. Only one cancel runs at a time; a retry reuses the same command. */
    cancel(requestId: string) {
      if (!valid() || state.cancelling?.phase === 'sending') return;
      if (pendingCancel?.requestId !== requestId)
        pendingCancel = { version: 'content-request-cancel.v1', commandId: newCommandId(), requestId };
      void runCancel();
    },
  };
}
export type RequestsListSession = ReturnType<typeof createRequestsListSession>;
