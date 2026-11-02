import { useCallback, useSyncExternalStore } from 'react';
import type { PrivacyClearState } from '@knowscroll/client-core';
import { useAccountScope } from '../../providers/account-scope';

/** What a Clear that is under way is doing, as a title and a plain line. */
export interface ClearProgress {
  readonly title: string;
  readonly text: string;
  /**
   * True while a removal is really under way. False while only its status is being read, which a panel
   * itself starts when its own load fails: that read ending is not a removal ending, so it must not
   * make the panel load again (and fail again, and read the status again, without end).
   */
  readonly removing: boolean;
}

/**
 * A Clear that has been asked for and is not finished, in plain words; nothing before one is asked for or once it has
 * finished, failed or could not be confirmed. The privacy screen's receipt and the panels that cannot load while the
 * account is being cleared say the same thing.
 */
export function clearProgress(state: PrivacyClearState): ClearProgress | undefined {
  if (state.status === 'sending') return { title: 'Sending', text: 'Sending your clear request…', removing: true };
  if (state.status === 'checking')
    return { title: 'Checking', text: 'Checking the latest removal status…', removing: false };
  if (state.status === 'accepted')
    return {
      title: 'Accepted',
      text: 'Your clear request was accepted. Live removal has not been confirmed yet.',
      removing: true,
    };
  if (state.status !== 'pending') return undefined;
  if (state.phase === 'waiting_for_accounting')
    return {
      title: 'Clearing',
      text: 'Some earlier activity is still finishing. Your removal request is retained.',
      removing: true,
    };
  if (state.phase === 'verifying_live_removal')
    return { title: 'Clearing', text: 'Checking that live exploration data has been removed.', removing: true };
  return { title: 'Clearing', text: 'Your exploration history and universe are being removed.', removing: true };
}

/**
 * The Clear that is running for the signed-in account, if any, and a way to ask the server again. A panel that cannot
 * load while the account is being cleared shows this in place of a load failure.
 */
export function useClearProgress(): { readonly progress: ClearProgress | undefined; readonly check: () => void } {
  const { manager } = useAccountScope();
  const privacy = manager.privacy;
  const state = useSyncExternalStore(privacy.subscribe, privacy.getState, privacy.getState);
  const check = useCallback(() => void privacy.refreshStatus(), [privacy]);
  return { progress: clearProgress(state), check };
}
