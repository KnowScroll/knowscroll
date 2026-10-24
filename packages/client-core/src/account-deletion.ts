import { DELETE_ACCOUNT_CONFIRMATION, type SessionAccount } from '@knowscroll/contracts';
import { apiProblem, type ApiClient } from './api-client';

interface DeletionOwner {
  readonly account: SessionAccount;
  readonly api: Pick<ApiClient, 'account'>;
}

/**
 * What asking for deletion achieved. `accepted`: the server took the request and every session is
 * over. `stale`: this screen was made for an older privacy epoch. `unavailable`: refused (the
 * account is already being deleted, a Clear is unfinished). `unconfirmed`: no answer arrived; the
 * request may have been accepted, and the receipt says.
 */
export type AccountDeletionOutcome = 'accepted' | 'stale' | 'unavailable' | 'unconfirmed';

export interface AccountDeletionDeps {
  readonly newId: () => string;
  /** Keeps the receipt id before anything is sent, so a lost answer can still be recovered. */
  readonly remember: (receiptId: string) => void;
  /** Drops the receipt: the request was refused, so there is nothing to ask about. */
  readonly forget: () => void;
  /** Ends the scope here once the server has ended every session. */
  readonly ended: () => Promise<void>;
}

/**
 * The confirmed delete command (P02). The caller has shown the consequences and the person has
 * acknowledged them; nothing here asks again.
 */
export async function requestAccountDeletion(
  owner: DeletionOwner,
  deps: AccountDeletionDeps,
): Promise<AccountDeletionOutcome> {
  const receiptId = deps.newId();
  deps.remember(receiptId);
  try {
    await owner.api.account.delete({
      receiptId,
      expectedPrivacyEpoch: owner.account.privacyEpoch,
      confirmation: DELETE_ACCOUNT_CONFIRMATION,
    });
  } catch (error) {
    const problem = apiProblem(error);
    if (problem === undefined) return 'unconfirmed';
    deps.forget();
    return problem.code === 'PRIVACY_EPOCH_CHANGED' ? 'stale' : 'unavailable';
  }
  await deps.ended();
  return 'accepted';
}
