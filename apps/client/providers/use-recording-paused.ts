import { useSyncExternalStore } from 'react';
import type { AccountScope } from '@knowscroll/client-core';
import { useAccountScope } from './account-scope';

const noSubscription = () => () => undefined;
const noPolicy = () => undefined;

/**
 * Whether recording is paused for this account scope (D-083): the one place the client turns the recording policy into
 * "paused". False without a scope or before the policy has been read; a rule that needs the answer still asks the server,
 * and this only lets a screen say so early.
 */
export function useRecordingPausedIn(scope: AccountScope | undefined): boolean {
  const recording = scope?.recording;
  const policy = useSyncExternalStore(
    recording?.subscribe ?? noSubscription,
    recording?.getState ?? noPolicy,
    recording?.getState ?? noPolicy,
  );
  return policy?.policy !== undefined && !policy.policy.on;
}

/** As `useRecordingPausedIn`, for a screen that is inside the account provider. */
export function useRecordingPaused(): boolean {
  const { state } = useAccountScope();
  return useRecordingPausedIn(state.status === 'signed_in' ? state.scope : undefined);
}
