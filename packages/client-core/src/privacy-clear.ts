import {
  ClearExplorationAcceptanceSchema,
  ClearExplorationSchema,
  ClearExplorationStatusSchema,
  type ClearExploration,
  type ClearExplorationReceipt,
  type ClearExplorationStatus,
} from '@knowscroll/contracts';
import { ORPCError } from '@orpc/client';
import type { AccountScope } from './account-scope';

export const PRIVACY_CLEAR_ACKNOWLEDGEMENT = 'clear-exploration-preserve-keep-and-social' as const;
export interface PrivacyClearState {
  readonly status:
    | 'idle'
    | 'sending'
    | 'accepted'
    | 'unknown'
    | 'checking'
    | 'not_recorded'
    | 'pending'
    | 'failed'
    | 'completed_live'
    | 'unavailable'
    | 'ended';
  readonly retryOriginal: boolean;
  readonly canConfirm: boolean;
  readonly receipt?: ClearExplorationReceipt;
  readonly phase?: Extract<ClearExplorationStatus, { status: 'pending' }>['phase'];
}
export interface PrivacyClearSession {
  readonly getState: () => PrivacyClearState;
  readonly subscribe: (listener: () => void) => () => void;
  /** A deliberate new operation; rejected while a prior operation needs reconciliation. */
  readonly confirm: (intent: {
    readonly commandId: string;
    readonly confirmation: typeof PRIVACY_CLEAR_ACKNOWLEDGEMENT;
  }) => Promise<boolean>;
  /** Explicit retry through fresh current authority, keeping the original UUID/epoch/body. */
  readonly retryOriginal: () => Promise<boolean>;
  /** Exact pending command when known; otherwise a read-only latest lookup, including after reload. */
  readonly refreshStatus: () => Promise<boolean>;
}

/** Internal manager capability. A ticket captures credential generation BEFORE any async work. */
interface PrivacyClearHost {
  readonly current: () => AccountScope | undefined;
  readonly capture: (scope: AccountScope) => { finishAfterAttempt(): Promise<boolean> } | undefined;
}

type Pending = { readonly accountId: string; readonly body: ClearExploration; unknown: boolean };
const idle: PrivacyClearState = Object.freeze({ status: 'idle', retryOriginal: false, canConfirm: true });

/**
 * Manager-lifetime memory only. AccountScope purge must not lose an unknown command, but local
 * credential changes reset it. No history, query response, credential, log or persistent journal.
 */
export function createPrivacyClearSession(host: PrivacyClearHost): PrivacyClearSession & {
  reset(ended?: boolean): void;
  accountChanged(accountId: string): void;
} {
  let state = idle;
  let pending: Pending | undefined;
  let ownerAccountId: string | undefined;
  let blockingReceipt = false;
  let serial = 0;
  let busy = false;
  let ended = false;
  const listeners = new Set<() => void>();
  const publish = (next: Omit<PrivacyClearState, 'retryOriginal' | 'canConfirm'>) => {
    state = Object.freeze({
      ...next,
      retryOriginal: pending?.unknown === true && !busy,
      canConfirm: !ended && !busy && !pending && !blockingReceipt,
    });
    for (const listener of [...listeners]) listener();
  };
  const valid = (token: number) => !ended && token === serial;
  const current = () => {
    const scope = host.current();
    return scope?.active ? scope : undefined;
  };
  async function readStatus(): Promise<boolean> {
    const scope = current();
    if (ended || busy) return false;
    if (!scope || (pending && pending.accountId !== scope.account.accountId)) {
      publish({ status: 'unavailable' });
      return false;
    }
    ownerAccountId = scope.account.accountId;
    const token = ++serial;
    const knownReceipt = state.receipt;
    const target = pending
      ? ({ kind: 'command', commandId: pending.body.commandId } as const)
      : ({ kind: 'latest' } as const);
    busy = true;
    publish({ status: 'checking', ...(state.receipt ? { receipt: state.receipt } : {}) });
    try {
      const snapshot = ClearExplorationStatusSchema.parse(
        await scope.api.privacy.readClearExplorationStatus({ version: 'clear-exploration.v1', target }),
      );
      if (!valid(token) || !scope.active || current() !== scope) return false;
      if (
        snapshot.scope.accountId !== scope.account.accountId ||
        snapshot.scope.privacyEpoch !== scope.account.privacyEpoch ||
        snapshot.target.kind !== target.kind ||
        (target.kind === 'command' &&
          (snapshot.target.kind !== 'command' || snapshot.target.commandId !== target.commandId)) ||
        (pending &&
          snapshot.status !== 'not_recorded' &&
          snapshot.receipt.fromEpoch !== pending.body.expectedPrivacyEpoch) ||
        (blockingReceipt && knownReceipt && snapshot.status === 'not_recorded') ||
        (pending &&
          knownReceipt &&
          (snapshot.status === 'not_recorded' ||
            snapshot.receipt.commandId !== knownReceipt.commandId ||
            snapshot.receipt.fromEpoch !== knownReceipt.fromEpoch ||
            snapshot.receipt.toEpoch !== knownReceipt.toEpoch ||
            snapshot.receipt.recordedAt !== knownReceipt.recordedAt))
      )
        throw new Error('invalid_privacy_snapshot');
      busy = false;
      if (snapshot.status === 'not_recorded') {
        // This read cannot prove a delayed send will never arrive. Preserve the original body.
        publish({ status: 'not_recorded' });
      } else {
        blockingReceipt = snapshot.status !== 'completed_live';
        if (pending) pending.unknown = false;
        if (snapshot.status === 'completed_live') pending = undefined;
        publish({
          status: snapshot.status,
          receipt: Object.freeze({ ...snapshot.receipt }),
          ...('phase' in snapshot ? { phase: snapshot.phase } : {}),
        });
      }
      return true;
    } catch {
      if (valid(token)) {
        busy = false;
        publish({ status: 'unavailable', ...(state.receipt ? { receipt: state.receipt } : {}) });
      }
      return false;
    } finally {
      if (valid(token)) {
        busy = false;
        if (state.status === 'checking')
          publish({ status: 'unavailable', ...(knownReceipt ? { receipt: knownReceipt } : {}) });
      }
    }
  }
  async function send(): Promise<boolean> {
    const scope = current();
    const original = pending;
    if (ended || busy || !scope || !original || original.accountId !== scope.account.accountId) return false;
    const ticket = host.capture(scope);
    if (!ticket) return false;
    const token = ++serial;
    busy = true;
    publish({ status: 'sending' });
    let receipt: ClearExplorationReceipt | undefined;
    try {
      const ack = ClearExplorationAcceptanceSchema.parse(await scope.api.privacy.clearExploration(original.body));
      if (!valid(token)) return false;
      if (ack.commandId !== original.body.commandId || ack.fromEpoch !== original.body.expectedPrivacyEpoch)
        throw new Error('invalid_privacy_acceptance');
      receipt = Object.freeze({
        commandId: ack.commandId,
        fromEpoch: ack.fromEpoch,
        toEpoch: ack.toEpoch,
        recordedAt: ack.recordedAt,
      });
      original.unknown = false;
      blockingReceipt = true;
    } catch (error) {
      if (!valid(token)) return false;
      if (error instanceof ORPCError && error.status >= 400 && error.status < 500) {
        pending = undefined;
        busy = false;
        publish({ status: 'unavailable' });
        return false;
      }
      original.unknown = true;
    }
    // finishAfterAttempt synchronously purges the exact old scope before its first await. It
    // preserves a newer scope already mounted for the same account, and rejects old credentials.
    const recovery = ticket.finishAfterAttempt();
    if (valid(token)) publish({ status: receipt ? 'accepted' : 'unknown', ...(receipt ? { receipt } : {}) });
    const recovered = await recovery.catch(() => false);
    if (!valid(token)) return false;
    busy = false;
    publish({ status: receipt ? 'accepted' : 'unknown', ...(receipt ? { receipt } : {}) });
    if (recovered) await readStatus();
    return true;
  }
  function reset(dispose = false) {
    serial++;
    busy = false;
    pending = undefined;
    blockingReceipt = false;
    ownerAccountId = undefined;
    ended = dispose;
    publish({ status: dispose ? 'ended' : 'idle' });
    if (dispose) listeners.clear();
  }
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async confirm(intent) {
      if (ended || busy || pending || blockingReceipt) return false;
      const scope = current();
      if (!scope || !host.capture(scope)) return false;
      const parsed = ClearExplorationSchema.safeParse({
        version: 'clear-exploration.v1',
        ...intent,
        expectedPrivacyEpoch: scope.account.privacyEpoch,
      });
      if (!parsed.success) return false;
      ownerAccountId = scope.account.accountId;
      pending = { accountId: scope.account.accountId, body: Object.freeze(parsed.data), unknown: false };
      return send();
    },
    retryOriginal: async () => (pending?.unknown === true ? send() : false),
    refreshStatus: readStatus,
    reset,
    accountChanged(accountId) {
      if (ownerAccountId !== undefined && ownerAccountId !== accountId) reset();
    },
  };
}
