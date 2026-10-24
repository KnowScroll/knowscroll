import { DeleteAccountJobSchema } from '../events.js';
import type {
  AccountDeletionState,
  AccountDeletionTx,
  FenceOwnAccount,
  PersonalAuthority,
  PersonalScopeTx,
  ReadAccountDeletion,
  RequestAccountDeletion,
  RetryAccountDeletion,
  WithPersonalScope,
} from '../public.js';

/** What the registry's erasers reported for one module (a subset of `ErasureReport`). */
export interface DeletionReport {
  readonly module: string;
  readonly status: 'completed' | 'pending' | 'failed';
}

export type FenceOutcome = 'fenced' | 'receipt_in_use';

/** The effects behind account deletion. Implemented over PostgreSQL by `adapters/deletion-store.ts`. */
export interface DeleteAccountPorts {
  readonly withScope: WithPersonalScope;
  /** Own root is held; takes the own-account UPDATE gate and rereads that both are active. */
  readonly fenceOwn: FenceOwnAccount;
  /**
   * Inside the caller's locked scope and account gate: records the operation under `receiptId`,
   * sets account and universe to `deleting`, advances the epoch, deletes every session and sends
   * the socket-revocation notice. `receipt_in_use` writes nothing.
   */
  readonly fence: (scope: PersonalScopeTx, receiptId: string) => Promise<FenceOutcome>;
  /** Sends `identity.delete-account` in the scope's own transaction. */
  readonly enqueue: (scope: PersonalScopeTx, deletionId: string) => Promise<void>;
  readonly readReceipt: (receiptId: string) => Promise<AccountDeletionState | undefined>;
  /** Pending: due now and a job in the same transaction. Completed and unknown are reported as such. */
  readonly requestRetry: (receiptId: string) => Promise<'queued' | 'completed' | 'not_found'>;
  /**
   * Runs `work` inside the deletion transaction (identity's address lock, the deleting root, its
   * account, the operation row, in that order). `undefined` when the operation is unknown or done.
   */
  readonly withDeletion: <T>(
    deletionId: string,
    work: (scope: AccountDeletionTx) => Promise<T>,
  ) => Promise<T | undefined>;
  /** Every module's erasers over the deleting account, in registry order. */
  readonly eraseAccountData: (scope: AccountDeletionTx) => Promise<readonly DeletionReport[]>;
  /** Inside the deletion transaction: the operation becomes an anonymous audit row; the root and account go. */
  readonly finish: (scope: AccountDeletionTx) => Promise<void>;
  /** Inside the deletion transaction: records that accounting still holds the universe; due again later. */
  readonly postpone: (scope: AccountDeletionTx) => Promise<void>;
  /** After the final failed delivery: shows the receipt as needing a retry. Never throws for an unknown id. */
  readonly markFailed: (deletionId: string) => Promise<void>;
  /** Hands at most `limit` due pending deletions back to the queue and pushes each fifteen minutes out. */
  readonly requeueDue: (limit: number) => Promise<number>;
}

/** Largest value of the integer epoch and revision counters (a fence at the limit is refused). */
const MAX_COUNTER = 2_147_483_647;

/** How many due deletions one recovery pass hands back. */
export const RECOVERY_BATCH = 25;

export type DeleteAccountOutcome = 'completed' | 'waiting_for_accounting' | 'gone';

/**
 * Account deletion (blueprint §19 "Account deletion", D-043), in two steps that never share a
 * transaction with a network call.
 *
 * `request` (HTTP): in the caller's locked scope and own-account gate, fence the account so no
 * request, worker or sign-in can act for it again, delete its sessions, record the operation and
 * enqueue the erasure job; all of it commits together or not at all. The answer means the request
 * is durable, not that the data is gone.
 *
 * `process` (worker, `identity.delete-account`): in one transaction under the deletion locks, run
 * every module's eraser. If all report completed, remove the universe root and the account and
 * turn the operation into an audit row without personal data. If accounting still holds the
 * universe (a paid attempt whose outcome is unknown is never refunded or resent), commit what was
 * erased and try again later; the account stays fenced. Any other failure rolls everything back and
 * the queue (or the recovery pass) delivers again. Every step is idempotent, and a stale worker
 * finds no universe to act on.
 */
export function makeDeleteAccount(ports: DeleteAccountPorts) {
  const request: RequestAccountDeletion = async (authority: PersonalAuthority, { receiptId }) => {
    const outcome = await ports.withScope(authority, async (scope) => {
      const access = await ports.fenceOwn(scope);
      if (
        access.kind === 'unavailable' ||
        scope.authority.privacyEpoch >= MAX_COUNTER ||
        scope.revisionAtEntry >= MAX_COUNTER
      )
        return 'unavailable' as const;
      if ((await ports.fence(scope, receiptId)) === 'receipt_in_use') return 'receipt_in_use' as const;
      await ports.enqueue(scope, receiptId);
      return 'accepted' as const;
    });
    if (outcome.kind === 'refused')
      return { kind: 'refused', reason: outcome.refusal.kind === 'epoch_changed' ? 'epoch_changed' : 'unavailable' };
    if (outcome.value !== 'accepted') return { kind: 'refused', reason: outcome.value };
    return { kind: 'accepted', receiptId, requestedAt: new Date() };
  };

  const readReceipt: ReadAccountDeletion = (receiptId) => ports.readReceipt(receiptId);

  const retry: RetryAccountDeletion = async (receiptId) => {
    const outcome = await ports.requestRetry(receiptId);
    return outcome === 'queued' ? { kind: 'queued' } : { kind: outcome };
  };

  async function process(input: unknown): Promise<DeleteAccountOutcome> {
    const job = DeleteAccountJobSchema.parse(input);
    const outcome = await ports.withDeletion(job.deletionId, async (scope): Promise<DeleteAccountOutcome> => {
      const reports = await ports.eraseAccountData(scope);
      if (reports.some((report) => report.status === 'failed')) throw new Error('ACCOUNT_ERASURE_FAILED');
      if (reports.some((report) => report.status === 'pending')) {
        await ports.postpone(scope);
        return 'waiting_for_accounting';
      }
      await ports.finish(scope);
      return 'completed';
    });
    return outcome ?? 'gone';
  }

  async function fail(input: unknown): Promise<void> {
    await ports.markFailed(DeleteAccountJobSchema.parse(input).deletionId);
  }

  async function recover(): Promise<{ readonly requeued: number }> {
    return { requeued: await ports.requeueDue(RECOVERY_BATCH) };
  }

  return { request, readReceipt, retry, process, fail, recover };
}
